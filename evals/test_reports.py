"""Tests for the export/report command (T7.3).

Spec "Done when": `engine.reports users` lists every registered agency with its
enquiry count; `--csv` emits a header + rows. These run entirely offline against a
throwaway database, using the same temp-DB trick as test_db.py.

Run with: ``pytest evals/test_reports.py``.
"""

import pytest

import engine.config as config
import engine.db as db
import engine.reports as reports
from engine.schemas import LeadEnquiry, UserProfile


# ---------------------------------------------------------------------------
# Temp DB seeded with two agencies; one has two enquiries, the other has none
# ---------------------------------------------------------------------------
@pytest.fixture
def seeded_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    db.init_db()

    aisha = UserProfile(agency="Sunrise Travel", full_name="Aisha Khan",
                        email="aisha@sunrise.ae", phone="+97144580111")
    omar = UserProfile(agency="Dunes Holidays", full_name="Omar Said",
                       email="omar@dunes.ae", phone="+97142223344")
    db.upsert_user(aisha)
    db.upsert_user(omar)

    # Two leads for Aisha, none for Omar -> exercises the enquiry count + LEFT JOIN.
    for i in range(2):
        db.insert_lead(LeadEnquiry(
            user_email=aisha.email, agency=aisha.agency, full_name=aisha.full_name,
            phone=aisha.phone, summary=f"Enquiry {i}", line_slug="msc", month="December",
        ), email_status="dev_logged")
    return config.settings.db_path


# ---------------------------------------------------------------------------
# list_users — both agencies, correct enquiry counts, zero-lead agency included
# ---------------------------------------------------------------------------
def test_list_users_counts_enquiries(seeded_db):
    users = db.list_users()
    by_email = {u["email"]: u for u in users}
    assert set(by_email) == {"aisha@sunrise.ae", "omar@dunes.ae"}
    assert by_email["aisha@sunrise.ae"]["enquiries"] == 2
    assert by_email["omar@dunes.ae"]["enquiries"] == 0        # LEFT JOIN keeps her
    assert by_email["aisha@sunrise.ae"]["agency"] == "Sunrise Travel"


def test_list_leads_joins_agency(seeded_db):
    leads = db.list_leads()
    assert len(leads) == 2
    assert all(l["agency"] == "Sunrise Travel" for l in leads)   # joined from users
    assert all(l["user_email"] == "aisha@sunrise.ae" for l in leads)


# ---------------------------------------------------------------------------
# CLI: the users table shows an agency + email; --csv emits a header row
# ---------------------------------------------------------------------------
def test_reports_users_table(seeded_db, capsys):
    reports.main(["users"])
    out = capsys.readouterr().out
    assert "Sunrise Travel" in out and "aisha@sunrise.ae" in out
    assert "enquiries" in out                                  # the count column header
    assert "2 row(s)" in out


def test_reports_users_csv_has_header_and_rows(seeded_db, capsys):
    reports.main(["users", "--csv"])
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    assert lines[0] == "agency,full_name,email,phone,created_at,enquiries"   # header
    assert len(lines) == 3                                     # header + two agencies
    assert any("Dunes Holidays" in ln for ln in lines[1:])


def test_reports_leads_csv(seeded_db, capsys):
    reports.main(["leads", "--csv"])
    lines = [ln for ln in capsys.readouterr().out.splitlines() if ln.strip()]
    assert lines[0].startswith("created_at,agency,user_email")
    assert len(lines) == 3                                     # header + two leads


# ---------------------------------------------------------------------------
# No sub-command is an error (argparse requires one) — not a silent no-op
# ---------------------------------------------------------------------------
def test_reports_requires_a_subcommand(seeded_db):
    with pytest.raises(SystemExit):
        reports.main([])
