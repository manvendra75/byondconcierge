"""engine.orchestrator — the deterministic per-turn control flow.

This is the fixed pipeline that runs for every user turn (the guide's "pipeline
first" backbone). The MODEL decides only *within* a step (which tool, what to
say); the CODE here decides the flow:

  1. cheap_scope_gate  → classify the turn
  2. branch on intent  → greeting/out_of_scope/injection get a canned reply with
     no big-model spend; price_intent signals the lead flow; in_scope runs the
     agent (engine.agent.run_turn)
  3. no-price guard     → scan the answer; on a violation, regenerate once, then
     mask "[fares on request]" and flag the trace
  4. persist            → store the user message and the reply

``handle_turn`` returns ``{reply, intent, lead_signal}`` — everything the UI needs
to render the turn and know whether to open the lead-capture flow (T5).
"""

from __future__ import annotations

import re

from engine.agent import run_turn
from engine.config import Step
from engine.db import add_message
from engine.guards import cheap_scope_gate, currency_scan
from engine.schemas import LeadEnquiry, ToolError, UserProfile
from engine.tools.leads import create_lead_enquiry
from engine.tools.lines import _lines_by_slug
from engine.tools.resolve import detect_month, resolve_line
from engine.trace import StepTrace, log_step

# Below this confidence, an out_of_scope verdict is treated as unreliable: if the
# user is mid-conversation, we'd rather answer (the grounded agent can't invent
# facts) than bounce a likely follow-up. Injection/price are never failed open.
_FAILOPEN_MAX_CONFIDENCE = 0.75


# ---------------------------------------------------------------------------
# Canned replies for the intents that don't need the agent
# ---------------------------------------------------------------------------
def _first_name(profile: UserProfile) -> str:
    """First name for a friendly greeting, or a neutral fallback."""
    return profile.full_name.split()[0] if profile.full_name else "there"


def _canned(intent: str, profile: UserProfile) -> str:
    """Short, deterministic replies (no model spend) for non-answer intents."""
    if intent == "greeting":
        return (f"Hello {_first_name(profile)}! I'm the Byond Borders cruise concierge. "
                "Ask me about sailings, itineraries, fleets or line comparisons across our 13 partner lines.")
    if intent == "out_of_scope":
        return ("That's outside what I can help with — I focus on cruises across Byond Borders' 13 partner "
                "lines: sailings, itineraries, fleets and comparisons. Anything there I can help with?")
    if intent == "injection_suspect":
        return ("I can only help with cruise questions for Byond Borders' partner lines, and I can't change "
                "how I work. What would you like to know about our cruises?")
    if intent == "price_intent":
        return ("Fares are contracted and quoted by our sales desk rather than shown here. I can pass your "
                f"enquiry to the team so they follow up at {profile.email} — shall I do that?")
    return ""


# ---------------------------------------------------------------------------
# The no-price guard: scan → regenerate once → mask + flag
# ---------------------------------------------------------------------------
def _guarded_answer(session_id: str, profile: UserProfile, history: list[dict] | None,
                    message: str, on_delta) -> str:
    """Run the agent for an in-scope question, then enforce the no-price rule (FR4):
    if the answer contains any currency, regenerate once with an explicit no-price
    instruction; if it *still* contains currency, mask each amount and flag the
    trace. Prices essentially never appear (no price data + price intent is routed
    away), so this is a rarely-triggered backstop."""
    answer = run_turn(session_id, profile, history, message, on_delta=on_delta)
    if not currency_scan(answer):
        return answer

    # One regeneration, not streamed (we don't want to show the corrected text twice).
    answer = run_turn(session_id, profile, history, message, on_delta=None,
                      correction="Do not include any price, fare, cost, or currency amount.")
    leftover = currency_scan(answer)
    if leftover:
        for amount in leftover:
            answer = answer.replace(amount, "[fares on request]")
        # Flag that a policy mask happened, so it's visible in the traces.
        log_step(StepTrace(session_id=session_id, step=Step.SYNTHESIZE.value,
                           guard_outcome="currency_masked"))
    return answer


# ---------------------------------------------------------------------------
# Lead draft assembly (T5.2) — profile + conversation -> a LeadEnquiry draft
# ---------------------------------------------------------------------------
# The draft is built DETERMINISTICALLY (no model): contact fields come straight
# from the registered profile, and the best-effort sailing references (line /
# month / party) are pulled from the conversation with the same code resolvers
# the search uses. Nothing here is invented — an un-detected reference is left
# None, and the free-text summary + transcript still carry the context.

# How many recent turns to scan for references and to quote back to the desk.
_DRAFT_SCAN_TURNS = 6
_EXCERPT_TURNS = 4

# Party-size phrasings we recognise deterministically. Conservative on purpose:
# we match explicit group wording ("family of 4", "6 guests", "couple") and avoid
# a bare "for 2" (which is usually "for 2 weeks", not two travellers).
_PARTY_GROUP_RE = re.compile(r"\b(?:family|group|party)\s+of\s+(\d{1,2})\b")
_PARTY_COUNT_RE = re.compile(r"\b(\d{1,2})\s*(?:people|persons?|pax|guests?|adults?|travell?ers?|passengers?)\b")


def _detect_party_size(text: str) -> int | None:
    """Best-effort party size from free text, or ``None``. Returns 1–99; a parsed
    zero is dropped (LeadEnquiry requires party_size >= 1)."""
    t = text.lower()
    if re.search(r"\bcouple\b", t):
        return 2
    for rx in (_PARTY_GROUP_RE, _PARTY_COUNT_RE):
        m = rx.search(t)
        if m:
            n = int(m.group(1))
            if n >= 1:
                return n
    return None


def _recent_user_text(history: list[dict] | None) -> str:
    """The last few turns joined into one string, for running the reference
    resolvers over the conversation (not just the latest message)."""
    return " ".join(t["content"] for t in (history or [])[-_DRAFT_SCAN_TURNS:])


def _transcript_excerpt(history: list[dict] | None, message: str) -> str:
    """A short ``role: content`` transcript of the last few turns plus the current
    message — the context the sales desk sees under the structured summary."""
    lines = [f"{t['role']}: {t['content']}" for t in (history or [])[-_EXCERPT_TURNS:]]
    lines.append(f"user: {message}")
    return "\n".join(lines)


def build_lead_draft(profile: UserProfile, history: list[dict] | None, message: str) -> LeadEnquiry:
    """Assemble a LeadEnquiry draft from the profile and the conversation.

    Contact fields are taken verbatim from the registered profile. The sailing
    references are resolved from the current message first, then the recent
    history (so "how much for that?" after discussing MSC still captures MSC).
    ``line_slug`` is only kept if it's a line the write path actually knows, so a
    stray detection can never make ``create_lead_enquiry`` reject an otherwise
    valid lead — the line name still survives in the summary/transcript.
    """
    hist_text = _recent_user_text(history)

    # Line: prefer the current ask, fall back to recent history; keep only a slug
    # the leads tool recognises (drops it to None otherwise).
    slug = resolve_line(message) or resolve_line(hist_text)
    line_slug = slug if slug and slug in _lines_by_slug() else None

    # Month + party: same message-then-history preference, best-effort.
    month = detect_month(message) or detect_month(hist_text)
    party = _detect_party_size(message) or _detect_party_size(hist_text)

    return LeadEnquiry(
        user_email=profile.email,
        agency=profile.agency,
        full_name=profile.full_name,
        phone=profile.phone,
        # The enquiry itself is the summary; a rare blank message falls back to a
        # generic (summary must be non-blank).
        summary=message.strip() or "Fare and availability enquiry.",
        line_slug=line_slug,
        month=month,
        party_size=party,
        transcript_excerpt=_transcript_excerpt(history, message),
    )


# ---------------------------------------------------------------------------
# handle_turn — the full per-turn pipeline
# ---------------------------------------------------------------------------
def handle_turn(session_id: str, profile: UserProfile, history: list[dict] | None,
                message: str, on_delta=None) -> dict:
    """Process one turn and return ``{reply, intent, lead_signal, lead_draft}``.

    ``lead_signal`` is True when the turn is a price/quote request; ``lead_draft``
    then carries a ready :class:`LeadEnquiry` (else None). The UI (T5.2) shows the
    draft with a confirm/cancel affordance and calls :func:`confirm_lead` only on
    an explicit confirm — the model suggests, the code validates, the user decides.
    ``on_delta`` streams the in-scope answer to the caller for a live UI.
    """
    # (4a) Persist the incoming user message.
    add_message(session_id, "user", message)

    # (1) Classify — the gate sees recent `history`, so short follow-ups are judged
    # in context rather than in isolation. Keep the full result (intent + confidence).
    verdict = cheap_scope_gate(message, session_id, history)
    intent = verdict.intent

    # (1b) Fail-open: a *low-confidence* out_of_scope during an active conversation is
    # more likely a misread follow-up than a real off-topic turn, so answer it. Only
    # out_of_scope is failed open — injection and price intents stay strict, and a
    # first message (no history) is never overridden.
    if (intent == "out_of_scope" and history
            and verdict.confidence < _FAILOPEN_MAX_CONFIDENCE):
        intent = "in_scope"

    lead_signal = False
    lead_draft: LeadEnquiry | None = None

    if intent == "in_scope":
        # (2 -> agent) + (3) no-price guard.
        reply = _guarded_answer(session_id, profile, history, message, on_delta)
    elif intent == "price_intent":
        # Signal the lead flow and assemble the draft for the confirm step; no
        # big-model spend, no tools, and nothing is written until the user confirms.
        lead_signal = True
        lead_draft = build_lead_draft(profile, history, message)
        reply = _canned("price_intent", profile)
    else:
        # greeting / out_of_scope / injection_suspect -> canned, no tools.
        reply = _canned(intent, profile)

    # (4b) Persist the assistant reply.
    add_message(session_id, "assistant", reply)

    return {"reply": reply, "intent": intent, "lead_signal": lead_signal, "lead_draft": lead_draft}


# ---------------------------------------------------------------------------
# Lead confirm / cancel (T5.2) — the two outcomes of the confirmation affordance
# ---------------------------------------------------------------------------
# These are the ONLY callers of create_lead_enquiry: the write happens strictly
# after the user clicks confirm. Each persists its assistant reply (so the DB
# transcript stays complete) and returns a small result the UI renders.
def confirm_lead(session_id: str, draft: LeadEnquiry) -> dict:
    """User confirmed — run the one write path, persist the reply, and return it.

    On success the reply names the callback email (the done-when for T5.2). If the
    write is rejected (e.g. a validation slip), we surface an honest apology rather
    than a silent drop, and no ``ok`` is claimed.
    """
    result = create_lead_enquiry(draft)
    if isinstance(result, ToolError):
        reply = ("Sorry — I couldn't log that enquiry just now. Please try again, or reach the "
                 "Byond Borders desk directly and they'll help right away.")
        add_message(session_id, "assistant", reply)
        return {"reply": reply, "ok": False, "error": result.detail}

    reply = (f"Done — I've passed your enquiry to the Byond Borders desk. They'll be in touch at "
             f"{draft.user_email} with fares and availability. Anything else I can help with?")
    add_message(session_id, "assistant", reply)
    return {"reply": reply, "ok": True,
            "lead_id": result["lead_id"], "email_status": result["email_status"]}


def cancel_lead(session_id: str) -> dict:
    """User declined — send nothing, persist a friendly continue-the-chat reply."""
    reply = "No problem — I haven't sent anything. What else can I help you with?"
    add_message(session_id, "assistant", reply)
    return {"reply": reply, "ok": False}


# ---------------------------------------------------------------------------
# Console demo — exercise the pipeline across intents
# ---------------------------------------------------------------------------
def main() -> None:
    from engine.db import create_session, init_db, upsert_user

    init_db()
    profile = UserProfile(agency="Demo Travel", full_name="Aisha Khan",
                          email="aisha@demo.ae", phone="+97144580111")
    upsert_user(profile)
    create_session("orch-demo", profile.email)

    for msg in ["Do I need a visa for a Dubai cruise?",       # out_of_scope
                "How much is a Celebrity Mediterranean cruise?",  # price_intent
                "Compare MSC and Costa for families"]:            # in_scope
        result = handle_turn("orch-demo", profile, [], msg)
        print(f"\nYou: {msg}")
        print(f"[intent={result['intent']} lead_signal={result['lead_signal']}]")
        print("Concierge:", result["reply"][:200], "...")


if __name__ == "__main__":
    main()
