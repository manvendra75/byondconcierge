"""Acceptance tests for the sailings loader (T1.2).

The core invariant: after loading, the ``sailings`` table mirrors the source
snapshot exactly — same total, same per-line counts — and re-running doesn't
duplicate anything (idempotent). Asserting against counts *computed from the
source file* (rather than hard-coded numbers) keeps these tests correct when the
cruise data is refreshed.

Run with: ``pytest evals/test_load_sailings.py``.
"""

import json
import sqlite3
from collections import Counter

import pytest

import engine.config as config
import engine.db as db
from engine.ingest.load_sailings import SAILINGS_INDEX, load_sailings


# ---------------------------------------------------------------------------
# Expected counts, read straight from the committed source snapshot
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def source_records():
    with open(SAILINGS_INDEX, encoding="utf-8") as f:
        return json.load(f)["records"]


# ---------------------------------------------------------------------------
# Temp DB so the load never touches the real data/app.db
# ---------------------------------------------------------------------------
@pytest.fixture
def temp_db(tmp_path):
    object.__setattr__(config.settings, "db_path", tmp_path / "test.db")
    db.init_db()
    return config.settings.db_path


def _count(conn, sql, params=()):
    return conn.execute(sql, params).fetchone()[0]


# ---------------------------------------------------------------------------
# Total row count equals the number of source records
# ---------------------------------------------------------------------------
def test_total_matches_source(temp_db, source_records):
    summary = load_sailings()
    assert summary["total"] == len(source_records)          # loader's own report

    conn = sqlite3.connect(temp_db)
    assert _count(conn, "SELECT count(*) FROM sailings") == len(source_records)
    conn.close()


# ---------------------------------------------------------------------------
# Per-line counts match the source exactly (celebrity spot-checked by name)
# ---------------------------------------------------------------------------
def test_per_line_counts_match_source(temp_db, source_records):
    load_sailings()
    expected = Counter(r["line"] for r in source_records)

    conn = sqlite3.connect(temp_db)
    for line, n in expected.items():
        assert _count(conn, "SELECT count(*) FROM sailings WHERE line=?", (line,)) == n
    # explicit celebrity check (the spec names it — value taken live, not hard-coded)
    assert _count(conn, "SELECT count(*) FROM sailings WHERE line='celebrity'") == expected["celebrity"]
    conn.close()


# ---------------------------------------------------------------------------
# Re-running is idempotent (no duplicated rows) and months_json round-trips
# ---------------------------------------------------------------------------
def test_idempotent_and_months_stored_as_json(temp_db, source_records):
    load_sailings()
    load_sailings()   # second run must not double the rows

    conn = sqlite3.connect(temp_db)
    assert _count(conn, "SELECT count(*) FROM sailings") == len(source_records)
    # months_json is valid JSON that parses back to a list
    sample = conn.execute("SELECT months_json FROM sailings WHERE months_json != '[]' LIMIT 1").fetchone()
    conn.close()
    assert isinstance(json.loads(sample[0]), list)
