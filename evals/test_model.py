"""Unit tests for the safe model-call wrapper (T3.2).

Spec "Done when": a stub returning bad-then-good JSON succeeds on retry and logs
2 traces. We stub ``_complete`` (the only network function) so these run with no
API key and no token spend. Also covers escalation and final failure.

Run with: ``pytest evals/test_model.py``.
"""

import sqlite3

import pytest

import engine.config as config
import engine.db as db
import engine.model as model
from engine.model import StepFailed, call_structured, _Completion
from engine.config import Step
from engine.schemas import IntentResult


# ---------------------------------------------------------------------------
# Temp DB so trace rows land somewhere throwaway
# ---------------------------------------------------------------------------
@pytest.fixture
def temp_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "app.db")
    db.init_db()
    return config.settings.db_path


def _trace_count(db_path, step):
    conn = sqlite3.connect(db_path)
    n = conn.execute("SELECT count(*) FROM traces WHERE step=?", (step,)).fetchone()[0]
    conn.close()
    return n


def _stub(monkeypatch, replies):
    """Make _complete return the given content strings in order, as _Completion
    objects with token usage. Lets us script bad/good sequences deterministically."""
    seq = iter(replies)
    def fake(model_name, messages, max_tokens, temperature):
        return _Completion(content=next(seq), tokens_in=10, tokens_out=5)
    monkeypatch.setattr(model, "_complete", fake)


# ---------------------------------------------------------------------------
# Bad-then-good JSON: succeeds on the retry, logs exactly 2 traces
# ---------------------------------------------------------------------------
def test_retry_succeeds_and_logs_two_traces(temp_db, monkeypatch):
    _stub(monkeypatch, [
        '{"intent": "nonsense", "confidence": 2}',      # invalid: bad literal + out of range
        '{"intent": "in_scope", "confidence": 0.9}',    # valid on retry
    ])
    result = call_structured(Step.EXTRACT_FILTERS, "classify this", IntentResult, session_id="s1")
    assert isinstance(result, IntentResult)
    assert result.intent == "in_scope"
    assert _trace_count(temp_db, "extract_filters") == 2      # one per attempt


# ---------------------------------------------------------------------------
# All-bad on a small step: retries twice then escalates to large -> 3 traces,
# and finally raises StepFailed.
# ---------------------------------------------------------------------------
def test_all_bad_escalates_then_fails(temp_db, monkeypatch):
    _stub(monkeypatch, ['{"bad": 1}'] * 3)                    # invalid every time
    with pytest.raises(StepFailed) as exc:
        call_structured(Step.EXTRACT_FILTERS, "x", IntentResult, session_id="s2")
    assert exc.value.step == "extract_filters"
    assert _trace_count(temp_db, "extract_filters") == 3      # small, small, large


# ---------------------------------------------------------------------------
# First-try success logs a single trace (no needless retry)
# ---------------------------------------------------------------------------
def test_first_try_success_one_trace(temp_db, monkeypatch):
    _stub(monkeypatch, ['{"intent": "greeting", "confidence": 1.0}'])
    result = call_structured(Step.SCOPE_GATE, "hi", IntentResult, session_id="s3")
    assert result.intent == "greeting"
    assert _trace_count(temp_db, "scope_gate") == 1
