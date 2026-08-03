"""engine.tools.leads — the one write path: capture a sales enquiry.

Everything else in the system only *reads* (sailings search, line facts, RAG).
This module is the single place that *writes outward*: it persists a captured
enquiry to the ``leads`` table and notifies the sales desk by email. It is
deliberately isolated and deterministic — no LLM, no invention — so the moment a
lead is created is auditable and never accidental.

Contract (see the guide's "predictable structure, not freeform prose" rule):
``create_lead_enquiry(lead)`` takes a validated :class:`LeadEnquiry` and returns
a plain ``dict`` on success or a structured :class:`ToolError` on a bad request —
the same return-a-ToolError pattern every other tool uses, so the orchestrator
branches on the type rather than string-matching a message.

Email delivery uses Resend (the same provider the website uses). With no
``RESEND_API_KEY`` configured the email is *logged to the console* instead of
sent, and the stored ``email_status`` records which happened
(``sent`` / ``dev_logged`` / ``failed``) — so a pilot with no key still captures
leads end-to-end, and the DB always reflects what really occurred.

**This tool is never called except after the user explicitly confirms** (the
model may *suggest* a lead, but T5.2's confirmation turn is what invokes it).
"""

from __future__ import annotations

from engine.config import settings
from engine.db import insert_lead
from engine.schemas import LeadEnquiry, ToolError
from engine.tools.lines import _lines_by_slug

# The visible sender. We reuse the desk's own (domain-verified) address as the
# From so Resend accepts it without extra config; the agent's email goes in
# reply-to below, so a reply from the desk lands straight back with the agency.
_FROM = f"Byond Borders Concierge <{settings.sales_email}>"

# Contact fields that MUST be present on any lead we accept. LeadEnquiry already
# enforces these at construction, but re-checking here is defence-in-depth: it
# guarantees the one write path can never persist a lead the desk can't act on,
# even if a caller hands us a loosely-built model.
_REQUIRED_CONTACT = ("user_email", "agency", "full_name", "phone", "summary")


# ---------------------------------------------------------------------------
# create_lead_enquiry — validate, persist, notify
# ---------------------------------------------------------------------------
def create_lead_enquiry(lead: LeadEnquiry) -> dict | ToolError:
    """Persist one captured enquiry and notify the sales desk.

    Steps, in order:

    1. **Deterministic validation** — every required contact field is present and
       non-blank, and ``line_slug`` is either a known cruise-line slug or ``None``.
       A failure returns a :class:`ToolError` and nothing is written.
    2. **Notify** — build the desk email and either send it (Resend key present)
       or log it to the console (dev mode). This yields an ``email_status`` and
       never raises: a delivery failure degrades to ``email_status="failed"`` so
       the lead is still saved.
    3. **Persist** — insert the ``leads`` row carrying that true ``email_status``,
       so the stored record always matches what actually happened.

    Returns ``{"status": "ok", "lead_id", "email_status", "user_email"}`` — the
    ``user_email`` is echoed back so the confirmation turn (T5.2) can promise the
    desk will reach the agent at that address.
    """
    # --- (1) Deterministic validation ------------------------------------
    # Reject any lead missing a contact field the desk needs to follow up. We
    # strip so a whitespace-only value counts as missing, and coerce to str so a
    # None (e.g. on a loosely-constructed model) is handled without a crash.
    missing = [f for f in _REQUIRED_CONTACT if not str(getattr(lead, f, "") or "").strip()]
    if missing:
        return ToolError(detail=f"lead missing required field(s): {', '.join(missing)}")

    # A referenced line must be one we actually represent (or omitted). This keeps
    # the desk's structured refs trustworthy and catches a bad slug from the model.
    if lead.line_slug is not None and lead.line_slug not in _lines_by_slug():
        return ToolError(detail=f"unknown line slug '{lead.line_slug}'")

    # --- (2) Notify the desk (send or dev-log; never raises) --------------
    email_status = _notify_sales(lead)

    # --- (3) Persist with the resolved status ----------------------------
    lead_id = insert_lead(lead, email_status=email_status)

    return {
        "status": "ok",
        "lead_id": lead_id,
        "email_status": email_status,
        "user_email": lead.user_email,
    }


# ---------------------------------------------------------------------------
# _format_email — the desk notification body (plain text, human-readable)
# ---------------------------------------------------------------------------
def _format_email(lead: LeadEnquiry) -> str:
    """Render the enquiry as a compact plain-text email body: who to contact, the
    one-paragraph summary, the structured sailing references (each falling back to
    an em dash when unknown — we never invent a value), and the transcript excerpt
    for context. Deliberately no prices appear here; the desk quotes fares itself.
    """
    dash = "—"  # em dash placeholder for an unknown reference

    def ref(v: object) -> str:
        return str(v) if v not in (None, "") else dash

    return (
        f"New cruise enquiry from {lead.agency}\n"
        f"\n"
        f"Contact\n"
        f"  Agent:  {lead.full_name}\n"
        f"  Agency: {lead.agency}\n"
        f"  Email:  {lead.user_email}\n"
        f"  Phone:  {lead.phone}\n"
        f"\n"
        f"Enquiry\n"
        f"  {lead.summary}\n"
        f"\n"
        f"References\n"
        f"  Line:      {ref(lead.line_slug)}\n"
        f"  Itinerary: {ref(lead.itinerary_name)}\n"
        f"  Month:     {ref(lead.month)}\n"
        f"  Party:     {ref(lead.party_size)}\n"
        f"\n"
        f"Transcript excerpt\n"
        f"  {lead.transcript_excerpt or '(none)'}\n"
    )


# ---------------------------------------------------------------------------
# _notify_sales — send via Resend, or log in dev mode; return the status
# ---------------------------------------------------------------------------
def _notify_sales(lead: LeadEnquiry) -> str:
    """Deliver (or log) the desk notification and return the resulting status:

    * ``"dev_logged"`` — no ``RESEND_API_KEY`` configured, so the email is printed
      to the console instead of sent (the pilot still works with no provider).
    * ``"sent"``       — Resend accepted the message.
    * ``"failed"``     — a send was attempted but errored; the lead is still saved.

    This function swallows all delivery errors on purpose: notifying the desk must
    never be able to lose a captured lead. The exception detail is logged so a
    failure is diagnosable without leaking it into the tool's return value.
    """
    subject = f"New cruise enquiry {chr(0x2014)} {lead.agency}"  # em dash in the subject
    body = _format_email(lead)

    # Dev mode: no provider key -> log to console and report it as such.
    if not settings.email_enabled:
        print(f"[leads] DEV email (not sent) to {settings.sales_email}\n"
              f"Subject: {subject}\n{body}")
        return "dev_logged"

    # Real send. Import Resend lazily so the module (and tests) load with no
    # network/provider dependency; configure the key just before the call.
    try:
        import resend

        resend.api_key = settings.resend_api_key
        resend.Emails.send({
            "from": _FROM,
            "to": [settings.sales_email],
            "reply_to": lead.user_email,   # desk replies land back with the agent
            "subject": subject,
            "text": body,
        })
        return "sent"
    except Exception as exc:  # noqa: BLE001 — any delivery error must not lose the lead
        print(f"[leads] email send FAILED ({exc!r}); lead will be saved as 'failed'")
        return "failed"
