"""Unit tests for the trace layer (T0.5 acceptance).

Covers the three things the spec names: ``timed_step`` writes a traces row,
``mask_pii`` scrubs contact details, and ``cost_of`` prices tokens from the
config table. Uses a temp DB so nothing touches the real ``data/app.db``.

Run with: ``pytest evals/test_trace.py``.
"""

import sqlite3

import pytest

import engine.config as config
import engine.db as db
from engine.trace import StepTrace, cost_of, log_step, mask_pii, timed_step


# ---------------------------------------------------------------------------
# Same temp-DB fixture idea as test_db.py: reroute settings.db_path, init schema
# ---------------------------------------------------------------------------
@pytest.fixture
def temp_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "test.db")
    db.init_db()
    return config.settings.db_path


# ---------------------------------------------------------------------------
# mask_pii — the key example from the spec, plus by-value and nested masking
# ---------------------------------------------------------------------------
def test_mask_pii_email_key():
    assert mask_pii({"email": "a@b.com"}) == {"email": "***"}


def test_mask_pii_by_value_and_nested():
    out = mask_pii({
        "note": "call me on +971 4 458 0111",     # phone detected by value
        "who": "Aisha",                             # ordinary text left alone
        "profile": {"user_email": "x@y.com"},       # nested contact key masked
    })
    assert out["note"] == "***"
    assert out["who"] == "Aisha"
    assert out["profile"]["user_email"] == "***"


# ---------------------------------------------------------------------------
# cost_of — known model prices; unknown model is free
# ---------------------------------------------------------------------------
def test_cost_of_known_and_unknown_model():
    # gpt-4o-mini: $0.00015/1k in, $0.00060/1k out -> 1000 in + 1000 out = 0.00075
    assert cost_of("gpt-4o-mini", 1000, 1000) == 0.00075
    assert cost_of("no-such-model", 1000, 1000) == 0.0


# ---------------------------------------------------------------------------
# timed_step — writes exactly one traces row, with latency filled in
# ---------------------------------------------------------------------------
def test_timed_step_writes_row(temp_db):
    with timed_step("sess-1", "synthesize") as t:
        t.model = "gpt-4o"
        t.tokens_in, t.tokens_out = 800, 250
        t.cost_usd = cost_of(t.model, t.tokens_in, t.tokens_out)

    conn = sqlite3.connect(temp_db)
    conn.row_factory = sqlite3.Row
    rows = conn.execute("SELECT * FROM traces WHERE session_id=?", ("sess-1",)).fetchall()
    conn.close()
    assert len(rows) == 1
    assert rows[0]["step"] == "synthesize"
    assert rows[0]["latency_ms"] is not None            # the manager measured it
    assert rows[0]["cost_usd"] == pytest.approx(0.0045)  # 800*.0000025 + 250*.00001


# ---------------------------------------------------------------------------
# timed_step still logs when the body raises (a failed step leaves a trace)
# ---------------------------------------------------------------------------
def test_timed_step_logs_on_exception(temp_db):
    with pytest.raises(ValueError):
        with timed_step("sess-2", "scope_gate") as t:
            t.model = "gpt-4o-mini"
            raise ValueError("boom")

    conn = sqlite3.connect(temp_db)
    count = conn.execute("SELECT count(*) FROM traces WHERE session_id=?", ("sess-2",)).fetchone()[0]
    conn.close()
    assert count == 1


# ---------------------------------------------------------------------------
# log_step — JSON-encodes the masked tool args
# ---------------------------------------------------------------------------
def test_log_step_encodes_tool_args(temp_db):
    log_step(StepTrace(session_id="sess-3", step="extract_filters",
                       tool="search_sailings",
                       tool_args_masked={"dest": "Mediterranean", "email": "***"}))
    conn = sqlite3.connect(temp_db)
    conn.row_factory = sqlite3.Row
    row = conn.execute("SELECT tool_args_masked FROM traces WHERE session_id=?", ("sess-3",)).fetchone()
    conn.close()
    assert '"dest": "Mediterranean"' in row["tool_args_masked"]     # stored as JSON text
