"""Unit tests for the SQLite store (T0.4 acceptance).

Proves the schema creates cleanly and the typed helpers round-trip: insert a
user and a lead, then read them straight back from the DB. Each test points the
app at a throwaway database file so it never touches the real ``data/app.db``.

Run with: ``pytest evals/test_db.py``.
"""

import sqlite3

import pytest

import engine.config as config
import engine.db as db
from engine.schemas import LeadEnquiry, UserProfile


# ---------------------------------------------------------------------------
# Fixture — redirect the app DB to a temp file, then initialise the schema
# ---------------------------------------------------------------------------
# settings is a frozen dataclass, so we swap in a temp path via object.__setattr__
# (the same mechanism dataclasses use internally). db.py reads settings.db_path
# through the shared `settings` object, so this reroutes every helper at once.
@pytest.fixture
def temp_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "test.db")
    db.init_db()
    return config.settings.db_path


# ---------------------------------------------------------------------------
# init_db creates the file and is idempotent
# ---------------------------------------------------------------------------
def test_init_db_creates_file_and_is_idempotent(temp_db):
    assert temp_db.exists()             # the .db file was created
    db.init_db()                        # second call must not raise
    # All expected tables are present.
    conn = sqlite3.connect(temp_db)
    names = {r[0] for r in conn.execute("SELECT name FROM sqlite_master WHERE type='table'")}
    conn.close()
    assert {"users", "sessions", "messages", "leads", "traces", "sailings"} <= names


# ---------------------------------------------------------------------------
# upsert_user round-trips, and a second upsert updates rather than duplicates
# ---------------------------------------------------------------------------
def test_upsert_user_round_trip(temp_db):
    user = UserProfile(agency="Sunrise Travel", full_name="Aisha Khan",
                       email="aisha@sunrise.ae", phone="+971 4 458 0111")
    db.upsert_user(user)

    conn = sqlite3.connect(temp_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM users WHERE email=?", (user.email,)).fetchone()
    assert row["agency"] == "Sunrise Travel"
    assert row["phone"] == "+97144580111"          # validator-cleaned form persisted

    # Re-registering the same email updates in place (no duplicate row).
    db.upsert_user(UserProfile(agency="Sunrise Holidays", full_name="Aisha Khan",
                               email="aisha@sunrise.ae", phone="+97144580111"))
    count = conn.execute("SELECT count(*) FROM users").fetchone()[0]
    updated = conn.execute("SELECT agency FROM users WHERE email=?", (user.email,)).fetchone()
    conn.close()
    assert count == 1 and updated["agency"] == "Sunrise Holidays"


# ---------------------------------------------------------------------------
# insert_lead round-trips with the structured refs intact
# ---------------------------------------------------------------------------
def test_insert_lead_round_trip(temp_db):
    lead = LeadEnquiry(
        user_email="aisha@sunrise.ae", agency="Sunrise Travel",
        full_name="Aisha Khan", phone="+97144580111",
        summary="Wants MSC Gulf fares for Dec, family of 4.",
        line_slug="msc", month="2026-12", party_size=4,
    )
    lead_id = db.insert_lead(lead, email_status="logged")

    conn = sqlite3.connect(temp_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT * FROM leads WHERE id=?", (lead_id,)).fetchone()
    conn.close()
    assert row["line_slug"] == "msc"
    assert row["party_size"] == 4
    assert row["email_status"] == "logged"
    assert row["summary"].startswith("Wants MSC")
