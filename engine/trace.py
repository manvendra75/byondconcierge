"""engine.trace — observability from day one.

Following the guide's "traces from day one" principle, every model call and tool
invocation should leave a row explaining what ran, how many tokens it used, what
it cost, how long it took, and how any guard resolved. That row is what lets you
answer "where did this bad answer go wrong?" in minutes instead of guesswork.

This module is a thin, ergonomic layer over ``engine.db.insert_trace``:

* ``StepTrace``      — a dataclass mirroring the ``traces`` columns.
* ``cost_of()``      — turn token counts into a USD figure via ``PRICE_PER_1K``.
* ``mask_pii()``     — scrub email/phone values before they are logged.
* ``log_step()``     — write one fully-formed trace row.
* ``timed_step()``   — a context manager that measures latency and logs on exit.

Nothing here changes behaviour; it only records what happened.
"""

from __future__ import annotations

import json
import re
import time
from contextlib import contextmanager
from dataclasses import dataclass, field
from typing import Any, Iterator

from engine.config import PRICE_PER_1K
from engine.db import insert_trace

# ---------------------------------------------------------------------------
# StepTrace — the in-memory shape of one trace row
# ---------------------------------------------------------------------------
# Mirrors the `traces` table columns (minus the auto id/created_at the DB fills
# in). Steps build one of these up as they run — a model call sets model/tokens,
# a tool call sets tool/args — then hand it to log_step().
@dataclass
class StepTrace:
    """One observability record. Every field is optional because different steps
    populate different columns."""

    session_id: str | None = None
    step: str | None = None               # a Step enum value, e.g. "scope_gate"
    model: str | None = None
    tokens_in: int | None = None
    tokens_out: int | None = None
    cost_usd: float | None = None
    latency_ms: int | None = None
    tool: str | None = None
    tool_args_masked: dict[str, Any] | None = None   # masked args (dict; JSON-encoded on write)
    retries: int | None = None
    guard_outcome: str | None = None


# ---------------------------------------------------------------------------
# Cost — token counts -> USD, using the price table in config
# ---------------------------------------------------------------------------
def cost_of(model: str, tokens_in: int, tokens_out: int) -> float:
    """Compute the dollar cost of a model call from its token counts.

    Prices come from ``PRICE_PER_1K`` (USD per 1,000 tokens, split in/out). A
    model that is not in the table simply costs $0 — cost accounting never blocks
    a call. Rounded to 6 dp because per-step costs are tiny fractions of a cent.
    """
    price = PRICE_PER_1K.get(model)
    if price is None:
        return 0.0
    return round(
        (tokens_in / 1000) * price["in"] + (tokens_out / 1000) * price["out"],
        6,
    )


# ---------------------------------------------------------------------------
# PII masking — never write raw contact details into traces
# ---------------------------------------------------------------------------
# Privacy rule (NFR): phone/email must be masked in traces. We mask on two
# signals: (1) the key name looks like a contact field, or (2) the value itself
# looks like an email or phone number. Nested dicts/lists are walked recursively.
_EMAIL_RE = re.compile(r"[^@\s]+@[^@\s]+\.[^@\s]+")
_PHONE_RE = re.compile(r"\+?\d[\d\s-]{7,}\d")
_PII_KEYS = {"email", "user_email", "phone", "phone_number", "tel", "mobile", "contact"}


def _mask_value(value: Any) -> Any:
    """Mask a single value if it looks like PII; recurse into containers."""
    if isinstance(value, dict):
        return mask_pii(value)
    if isinstance(value, list):
        return [_mask_value(v) for v in value]
    if isinstance(value, str) and (_EMAIL_RE.search(value) or _PHONE_RE.search(value)):
        return "***"
    return value


def mask_pii(args: dict[str, Any]) -> dict[str, Any]:
    """Return a copy of ``args`` with any email/phone content replaced by
    ``"***"`` — either because the key is a known contact field or the value
    matches an email/phone pattern. The original dict is not modified."""
    masked: dict[str, Any] = {}
    for key, value in args.items():
        if key.lower() in _PII_KEYS:
            masked[key] = "***"
        else:
            masked[key] = _mask_value(value)
    return masked


# ---------------------------------------------------------------------------
# log_step — write one trace row to SQLite
# ---------------------------------------------------------------------------
def log_step(trace: StepTrace) -> int:
    """Persist a StepTrace via ``engine.db.insert_trace``. The masked-args dict
    is JSON-encoded to a string for storage; everything else passes straight
    through. Returns the new trace row id."""
    args_json = (
        json.dumps(trace.tool_args_masked) if trace.tool_args_masked is not None else None
    )
    return insert_trace(
        session_id=trace.session_id,
        step=trace.step,
        model=trace.model,
        tokens_in=trace.tokens_in,
        tokens_out=trace.tokens_out,
        cost_usd=trace.cost_usd,
        latency_ms=trace.latency_ms,
        tool=trace.tool,
        tool_args_masked=args_json,
        retries=trace.retries,
        guard_outcome=trace.guard_outcome,
    )


# ---------------------------------------------------------------------------
# timed_step — measure latency around a block and log it on exit
# ---------------------------------------------------------------------------
@contextmanager
def timed_step(session_id: str | None, step: str) -> Iterator[StepTrace]:
    """Context manager that times a workflow step and writes its trace.

    Usage::

        with timed_step(session_id, Step.SYNTHESIZE.value) as t:
            answer = call_model(...)
            t.model = "gpt-4o"
            t.tokens_in, t.tokens_out = 800, 250
            t.cost_usd = cost_of(t.model, t.tokens_in, t.tokens_out)

    The manager yields a fresh ``StepTrace`` pre-filled with ``session_id`` and
    ``step``; the body fills in whatever else it knows. On exit — even if the
    body raises — latency is recorded and the row is written (a failing step
    should still leave a trace). Exceptions are re-raised after logging.
    """
    trace = StepTrace(session_id=session_id, step=step)
    start = time.perf_counter()
    try:
        yield trace
    finally:
        trace.latency_ms = int((time.perf_counter() - start) * 1000)
        log_step(trace)
