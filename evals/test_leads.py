"""Acceptance tests for the lead write path (T5.1).

Spec "Done when": a valid lead creates a ``leads`` row and (in dev mode, no
Resend key) logs an email whose body contains the agency & summary; a lead
missing its email returns a ``ToolError``.

The tests run entirely offline: with no ``RESEND_API_KEY`` set,
``create_lead_enquiry`` takes the dev-log branch (no network). Each test points
the app at a throwaway database so it never touches the real ``data/app.db``.

Run with: ``pytest evals/test_leads.py``.
"""

import sqlite3

import pytest

import engine.config as config
import engine.db as db
from engine.schemas import LeadEnquiry, ToolError
from engine.tools.leads import create_lead_enquiry


# ---------------------------------------------------------------------------
# Fixtures — temp DB + guaranteed dev mode (no Resend key)
# ---------------------------------------------------------------------------
# Same trick as test_db.py: settings is a frozen dataclass, so we swap fields via
# object.__setattr__. We reroute the DB to a temp file AND blank the Resend key so
# the notification path is the deterministic, offline dev-log branch.
@pytest.fixture
def temp_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "test.db")
    object.__setattr__(config.settings, "resend_api_key", "")   # force dev-log mode
    db.init_db()
    return config.settings.db_path


def _valid_lead() -> LeadEnquiry:
    """A fully-populated, valid enquiry used by the happy-path tests."""
    return LeadEnquiry(
        user_email="aisha@sunrise.ae", agency="Sunrise Travel",
        full_name="Aisha Khan", phone="+97144580111",
        summary="Wants MSC Gulf fares for December, family of 4.",
        line_slug="msc", month="2026-12", party_size=4,
        transcript_excerpt="user: How much for MSC in December?",
    )


# ---------------------------------------------------------------------------
# Happy path — valid lead persists a row and dev-logs the email
# ---------------------------------------------------------------------------
def test_valid_lead_persists_row_and_dev_logs_email(temp_db, capsys):
    result = create_lead_enquiry(_valid_lead())

    # Returns the success dict (not a ToolError), flagged as dev_logged.
    assert not isinstance(result, ToolError)
    assert result["status"] == "ok"
    assert result["email_status"] == "dev_logged"
    assert result["user_email"] == "aisha@sunrise.ae"

    # The leads row landed with the structured refs and the dev status.
    conn = sqlite3.connect(temp_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM leads WHERE id=?", (result["lead_id"],)).fetchone()
    conn.close()
    assert row["line_slug"] == "msc"
    assert row["party_size"] == 4
    assert row["email_status"] == "dev_logged"

    # The dev-mode console log carried the agency and the summary (proof the
    # email body was assembled) — matches the "Done when" email assertion.
    logged = capsys.readouterr().out
    assert "Sunrise Travel" in logged
    assert "Wants MSC Gulf fares" in logged


# ---------------------------------------------------------------------------
# Validation — a missing contact field returns a ToolError, writes nothing
# ---------------------------------------------------------------------------
def test_missing_email_returns_toolerror(temp_db):
    # model_construct bypasses Pydantic so we can simulate a lead that reached the
    # tool without its email — exactly what the deterministic guard must catch.
    lead = LeadEnquiry.model_construct(
        user_email="", agency="Sunrise Travel", full_name="Aisha Khan",
        phone="+97144580111", summary="Wants fares.",
    )
    result = create_lead_enquiry(lead)
    assert isinstance(result, ToolError)
    assert "user_email" in result.detail

    # Nothing was persisted on the rejected lead.
    conn = sqlite3.connect(temp_db)
    count = conn.execute("SELECT count(*) FROM leads").fetchone()[0]
    conn.close()
    assert count == 0


# ---------------------------------------------------------------------------
# Validation — an unknown line slug is rejected before any write
# ---------------------------------------------------------------------------
def test_unknown_line_slug_returns_toolerror(temp_db):
    lead = _valid_lead()
    bad = lead.model_copy(update={"line_slug": "atlantis"})   # not a represented line
    result = create_lead_enquiry(bad)
    assert isinstance(result, ToolError)
    assert "atlantis" in result.detail


# ---------------------------------------------------------------------------
# A lead with no line reference is fine (line_slug is optional)
# ---------------------------------------------------------------------------
def test_lead_without_line_slug_is_accepted(temp_db):
    lead = _valid_lead().model_copy(update={"line_slug": None})
    result = create_lead_enquiry(lead)
    assert not isinstance(result, ToolError)
    assert result["status"] == "ok"
