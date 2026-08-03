"""Headless tests for the registration gate (T4.1).

Uses Streamlit's AppTest to drive app.py without a browser: fill the form, click
Enter, and assert on what renders. Each test points the DB at a temp file so the
real data/app.db is untouched.

Spec "Done when": invalid email/phone blocks entry with a message; a valid submit
persists a users row and reveals the chat.

Run with: ``pytest evals/test_app.py``.
"""

import sqlite3

import pytest
from streamlit.testing.v1 import AppTest

import engine.config as config
import engine.db as db
import engine.orchestrator as orch


# ---------------------------------------------------------------------------
# Fresh app pointed at a throwaway database
# ---------------------------------------------------------------------------
@pytest.fixture
def app(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    return AppTest.from_file("app.py", default_timeout=30).run()


def _fill(at, agency, name, email, phone):
    """Set the four form fields by their widget keys."""
    at.text_input(key="reg_agency").set_value(agency)
    at.text_input(key="reg_name").set_value(name)
    at.text_input(key="reg_email").set_value(email)
    at.text_input(key="reg_phone").set_value(phone)


# ---------------------------------------------------------------------------
# Invalid input blocks entry with an inline error
# ---------------------------------------------------------------------------
def test_invalid_email_blocks_with_message(app):
    _fill(app, "Sunrise Travel", "Aisha Khan", "not-an-email", "+97144580111")
    app.button[0].click().run()                      # submit
    assert app.error                                 # an inline error is shown
    assert not app.success                           # chat NOT revealed
    assert app.session_state["profile"] is None       # still unregistered


def test_invalid_phone_blocks_with_message(app):
    _fill(app, "Sunrise Travel", "Aisha Khan", "aisha@sunrise.ae", "abc")
    app.button[0].click().run()
    assert app.error
    assert app.session_state["profile"] is None


# ---------------------------------------------------------------------------
# Valid submit persists a users row and reveals the chat
# ---------------------------------------------------------------------------
def test_valid_submit_persists_and_unlocks(app):
    _fill(app, "Sunrise Travel", "Aisha Khan", "aisha@sunrise.ae", "+971 4 458 0111")
    app.button[0].click().run()

    # A profile + session are now in hot state, and the chat area is revealed.
    # (The "form is gone" case is asserted cleanly in test_restore_session_from_url;
    # here AppTest retains the pre-rerun form widgets, so we check the positives.)
    assert app.session_state["profile"] is not None
    assert app.session_state["session_id"]
    assert app.chat_input                             # chat surface unlocked

    # And a users row was persisted (phone stored in cleaned form).
    conn = sqlite3.connect(config.settings.db_path)
    row = conn.execute("SELECT phone FROM users WHERE email=?", ("aisha@sunrise.ae",)).fetchone()
    conn.close()
    assert row is not None and row[0] == "+97144580111"


# ---------------------------------------------------------------------------
# T4.2 — refresh keeps the session and history (restore from the URL)
# ---------------------------------------------------------------------------
def test_restore_session_from_url(tmp_path):
    # Seed a registered user + session + a prior exchange in a temp DB.
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    db.init_db()
    from engine.schemas import UserProfile
    p = UserProfile(agency="Sunrise Travel", full_name="Aisha Khan",
                    email="aisha@sunrise.ae", phone="+97144580111")
    db.upsert_user(p)
    db.create_session("sess-xyz", p.email)
    db.add_message("sess-xyz", "user", "Mediterranean sailings in January")
    db.add_message("sess-xyz", "assistant", "Here are the Mediterranean sailings...")

    # Load the app AS IF after a refresh: only the URL carries the session id.
    at = AppTest.from_file("app.py", default_timeout=30)
    at.query_params["sid"] = "sess-xyz"
    at.run()

    # The profile + history are restored; the registration form is gone.
    assert at.session_state["profile"] is not None
    assert len(at.session_state["messages"]) == 2         # prior turns reloaded
    assert len(at.chat_message) == 2                       # and rendered
    assert not at.text_input                               # no registration form


# ---------------------------------------------------------------------------
# T4.2 — sending a message runs the pipeline and shows the reply
# ---------------------------------------------------------------------------
def test_chat_send_renders_reply(tmp_path, monkeypatch):
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    db.init_db()
    from engine.schemas import UserProfile
    p = UserProfile(agency="Sunrise Travel", full_name="Aisha Khan",
                    email="aisha@sunrise.ae", phone="+97144580111")
    db.upsert_user(p)
    db.create_session("sess-abc", p.email)

    # Stub the whole pipeline (no API): stream two tokens, return a fixed reply.
    def fake_handle_turn(session_id, profile, history, message, on_delta=None):
        if on_delta:
            on_delta("Here are the "); on_delta("Mediterranean sailings.")
        return {"reply": "Here are the Mediterranean sailings.", "intent": "in_scope", "lead_signal": False}
    monkeypatch.setattr(orch, "handle_turn", fake_handle_turn)

    at = AppTest.from_file("app.py", default_timeout=30)
    at.query_params["sid"] = "sess-abc"        # start on the chat surface
    at.run()

    at.chat_input[0].set_value("Med sailings in Jan?").run()

    # The user message and the streamed reply are now in hot state + rendered.
    roles = [m["role"] for m in at.session_state["messages"]]
    assert roles == ["user", "assistant"]
    assert at.session_state["messages"][1]["content"] == "Here are the Mediterranean sailings."
    assert any("Mediterranean sailings." in md.value for md in at.markdown)


# ---------------------------------------------------------------------------
# T5.2 — price turn shows the lead draft; clicking Send writes a lead + names email
# ---------------------------------------------------------------------------
def test_lead_confirm_flow_writes_row_and_names_email(tmp_path, monkeypatch):
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    object.__setattr__(config.settings, "resend_api_key", "")   # dev-log mode (offline)
    db.init_db()
    from engine.schemas import LeadEnquiry, UserProfile
    p = UserProfile(agency="Sunrise Travel", full_name="Aisha Khan",
                    email="aisha@sunrise.ae", phone="+97144580111")
    db.upsert_user(p)
    db.create_session("sess-lead", p.email)

    # A price turn returns a ready draft (no API): the app should stash it and show
    # the confirm card. We stub handle_turn so the test stays deterministic/offline.
    draft = LeadEnquiry(user_email=p.email, agency=p.agency, full_name=p.full_name,
                        phone=p.phone, summary="How much for MSC in December?",
                        line_slug="msc", month="December")

    def fake_handle_turn(session_id, profile, history, message, on_delta=None):
        return {"reply": "Fares are quoted by our desk — shall I pass this on?",
                "intent": "price_intent", "lead_signal": True, "lead_draft": draft}
    monkeypatch.setattr(orch, "handle_turn", fake_handle_turn)

    at = AppTest.from_file("app.py", default_timeout=30)
    at.query_params["sid"] = "sess-lead"
    at.run()

    # Ask a price question -> the draft becomes pending and the card renders.
    at.chat_input[0].set_value("How much for MSC in December?").run()
    assert at.session_state["pending_lead"] is not None
    assert any(b.key == "lead_confirm" for b in at.button)      # Send button present

    # Click "Send to the desk" -> confirm_lead (the real one) writes the lead.
    next(b for b in at.button if b.key == "lead_confirm").click().run()

    # A leads row exists, the draft is cleared, and the reply names the callback email.
    conn = sqlite3.connect(config.settings.db_path)
    row = conn.execute("SELECT user_email, line_slug, email_status FROM leads").fetchone()
    conn.close()
    assert row == ("aisha@sunrise.ae", "msc", "dev_logged")
    assert at.session_state["pending_lead"] is None
    assert any("aisha@sunrise.ae" in m["content"] for m in at.session_state["messages"])
