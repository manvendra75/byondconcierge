"""app.py — the Byond Borders Cruise Concierge Streamlit app.

Run it with:  streamlit run app.py

Two parts:
* T4.1 — the registration gate (sign-in form → user + session).
* T4.2 — the streaming chat surface (chat input → handle_turn → streamed reply).

Streamlit re-runs this whole script on every interaction, so hot state (profile,
session id, message list) lives in ``st.session_state``. That survives re-runs but
NOT a hard browser refresh, so we also keep the session id in the URL query params
and reload the user + history from SQLite when the app loads with one.
"""

from __future__ import annotations

import uuid

import streamlit as st

from engine.db import (
    create_session,
    get_messages,
    get_session,
    get_user,
    init_db,
    upsert_user,
)
from engine.config import settings
from engine.ingest.load_sailings import snapshot_date
from engine.orchestrator import cancel_lead, confirm_lead, handle_turn
from engine.schemas import UserProfile
from engine.ui.register import render_registration_gate
from engine.ui.sidebar import render_ad_and_credit

# ---------------------------------------------------------------------------
# Page setup + storage bootstrap
# ---------------------------------------------------------------------------
st.set_page_config(page_title="Byond Borders Cruise Concierge", page_icon="🚢")
init_db()   # ensure the SQLite tables exist (idempotent, cheap)

# Seed the session-state keys once; setdefault leaves existing values untouched.
st.session_state.setdefault("profile", None)        # UserProfile once registered
st.session_state.setdefault("session_id", None)     # this conversation's id
st.session_state.setdefault("messages", [])         # [{role, content}] for rendering
st.session_state.setdefault("pending_lead", None)   # a LeadEnquiry awaiting confirm (T5.2)

# Read the sailing-data snapshot date ONCE per session (not on every rerun — the index is a
# large file), so we can show data freshness in the sidebar (TB.6). `if not in` avoids the
# setdefault pitfall where the default expression would be evaluated on every rerun.
if "data_date" not in st.session_state:
    st.session_state.data_date = snapshot_date()

st.title("🚢 Byond Borders Cruise Concierge")


# ---------------------------------------------------------------------------
# Restore an existing session from the URL (survives a browser refresh)
# ---------------------------------------------------------------------------
def _restore_from_url() -> None:
    """If the URL carries a session id and hot state is empty (e.g. after a
    refresh), reload the user profile and message history from SQLite so the
    conversation continues seamlessly."""
    if st.session_state.profile is not None:
        return                                   # already have live state
    session_id = st.query_params.get("sid")
    if not session_id:
        return
    session = get_session(session_id)
    if not session:
        return
    user = get_user(session["user_email"])
    if not user:
        return
    # Rebuild the profile (stored phone is already in validated form).
    st.session_state.profile = UserProfile(
        agency=user["agency"], full_name=user["full_name"],
        email=user["email"], phone=user["phone"],
    )
    st.session_state.session_id = session_id
    st.session_state.messages = get_messages(session_id)


_restore_from_url()


# ---------------------------------------------------------------------------
# Lead confirmation affordance (T5.2) — model suggests, user confirms, code writes
# ---------------------------------------------------------------------------
def _render_lead_confirm(session_id: str) -> None:
    """Show the pending lead draft with Send / Not-now buttons. The lead is written
    ONLY when the user clicks Send (which calls the orchestrator's confirm_lead —
    the one write path). Either button clears the draft, appends the resulting
    assistant reply to hot state, and re-runs so the chat continues cleanly."""
    draft = st.session_state.pending_lead
    with st.chat_message("assistant"):
        st.markdown("**Here's the enquiry I'll send to the Byond Borders desk:**")
        st.markdown(f"> {draft.summary}")
        # Structured references, shown only when we actually detected them.
        refs = []
        if draft.line_slug:
            refs.append(f"**Line:** {draft.line_slug}")
        if draft.month:
            refs.append(f"**Month:** {draft.month}")
        if draft.party_size:
            refs.append(f"**Party:** {draft.party_size}")
        if refs:
            st.caption(" · ".join(refs))
        st.caption(f"The desk will reply to {draft.user_email}.")

        # Two explicit choices; keys are stable so Streamlit tracks the clicks.
        send_col, cancel_col = st.columns(2)
        if send_col.button("✅ Send to the desk", key="lead_confirm", use_container_width=True):
            out = confirm_lead(session_id, draft)
            st.session_state.messages.append({"role": "assistant", "content": out["reply"]})
            st.session_state.pending_lead = None
            st.rerun()
        if cancel_col.button("✖ Not now", key="lead_cancel", use_container_width=True):
            out = cancel_lead(session_id)
            st.session_state.messages.append({"role": "assistant", "content": out["reply"]})
            st.session_state.pending_lead = None
            st.rerun()


# ---------------------------------------------------------------------------
# Registration gate — shown until a valid profile exists
# ---------------------------------------------------------------------------
if st.session_state.profile is None:
    profile = render_registration_gate()
    if profile is not None:
        # Persist the user, open a session, store both in hot state + the URL,
        # then re-run so the chat renders instead of the form.
        upsert_user(profile)
        session_id = str(uuid.uuid4())
        create_session(session_id, profile.email)
        st.session_state.profile = profile
        st.session_state.session_id = session_id
        st.query_params["sid"] = session_id      # so a refresh can restore it
        st.rerun()

# ---------------------------------------------------------------------------
# Chat surface — unlocked once registered
# ---------------------------------------------------------------------------
else:
    profile = st.session_state.profile
    session_id = st.session_state.session_id

    # Sidebar: who's signed in + a log-out that clears state and the URL.
    with st.sidebar:
        st.markdown(f"**{profile.full_name}**")
        st.caption(profile.agency)
        st.caption(profile.email)
        if st.button("Log out"):
            st.session_state.profile = None
            st.session_state.session_id = None
            st.session_state.messages = []
            st.query_params.clear()
            st.rerun()
        # Ad banner (sold to cruise companies) + "Powered by AtlasIQ" credit (T4.5). Config-driven
        # slot: shows a placeholder until an ad's set in env — engine/ui/sidebar.py.
        st.divider()
        render_ad_and_credit(settings)
        # Data freshness: tell the agent how current the sailing catalogue is (TB.6). Dated
        # departures rot (sell out / sail away), so the "as of" date sets expectations.
        if st.session_state.data_date:
            st.divider()
            st.caption(f"🚢 Sailing data as of {st.session_state.data_date}")

    # Replay the conversation so far from hot state.
    for msg in st.session_state.messages:
        with st.chat_message(msg["role"]):
            st.markdown(msg["content"])

    # If a price turn produced a lead draft, show the confirm/cancel card beneath the
    # conversation (below the assistant's "shall I pass this to the desk?" reply).
    if st.session_state.pending_lead is not None:
        _render_lead_confirm(session_id)

    # New turn: read the input, then run the full pipeline.
    if prompt := st.chat_input("Ask about cruises, sailings, lines…"):
        # History for the model = the turns BEFORE this one (the gate/agent use it
        # for context). Capture it before we append the new message.
        history = list(st.session_state.messages)

        # Show + remember the user's message.
        st.session_state.messages.append({"role": "user", "content": prompt})
        with st.chat_message("user"):
            st.markdown(prompt)

        # Assistant reply: stream tokens into a placeholder as they arrive.
        with st.chat_message("assistant"):
            placeholder = st.empty()
            buffer: list[str] = []

            def on_delta(chunk: str) -> None:
                # Append each streamed token and re-render with a cursor.
                buffer.append(chunk)
                placeholder.markdown("".join(buffer) + "▌")

            # A spinner is the progress state while the gate runs / tools search;
            # once tokens stream, they replace it in the placeholder below.
            with st.spinner("Searching cruises…"):
                result = handle_turn(session_id, profile, history, prompt, on_delta=on_delta)

            # Render the FINAL reply (the no-price-guarded text, cursor removed).
            # For canned intents (greeting/price/out-of-scope) nothing streamed, so
            # this is the first render of the reply.
            placeholder.markdown(result["reply"])

        # Remember the assistant reply for the next turn's context/rendering.
        # (handle_turn already persisted both messages to SQLite — we only keep a
        # hot copy here, we don't add_message again.)
        st.session_state.messages.append({"role": "assistant", "content": result["reply"]})

        # A price turn hands back a lead draft: stash it and re-run so the
        # confirm/cancel card renders under the reply (nothing is written yet).
        if result.get("lead_draft") is not None:
            st.session_state.pending_lead = result["lead_draft"]
            st.rerun()
