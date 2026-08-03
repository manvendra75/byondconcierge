"""Acceptance tests for the ingest orchestrator (T1.4).

The spec's "Done when": a clean run reports counts, and a second run produces
identical counts (the whole pipeline is idempotent). Both stores are pointed at
throwaway temp locations so the real data/ is untouched.

Run with: ``pytest evals/test_load.py``.
"""

import json

import pytest

import engine.config as config
import engine.db as db
from engine.ingest.load import run
from engine.ingest.load_knowledge import KNOWLEDGE_DIR
from engine.ingest.load_sailings import SAILINGS_INDEX


# ---------------------------------------------------------------------------
# Point BOTH stores (SQLite + Chroma) at temp dirs for the whole module
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def temp_stores(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("ingest")
    object.__setattr__(config.settings, "db_path", tmp / "app.db")
    object.__setattr__(config.settings, "chroma_dir", tmp / "chroma")
    db.init_db()
    return tmp


# ---------------------------------------------------------------------------
# A clean run reports the expected counts (checked against the source files)
# ---------------------------------------------------------------------------
def test_clean_run_reports_counts(temp_stores):
    result = run()

    # sailings total equals the number of records in the source snapshot
    source_records = json.loads(SAILINGS_INDEX.read_text(encoding="utf-8"))["records"]
    assert result["sailings"]["total"] == len(source_records)

    # knowledge total is >100 and splits into briefs + content
    assert result["knowledge"]["total"] > 100
    assert result["knowledge"]["briefs"] + result["knowledge"]["content"] == result["knowledge"]["total"]

    # every brief file contributed at least one chunk to some line (14 md files)
    assert len(list(KNOWLEDGE_DIR.glob("*.md"))) == 14


# ---------------------------------------------------------------------------
# Idempotent: a second run yields identical counts
# ---------------------------------------------------------------------------
def test_second_run_is_identical(temp_stores):
    first = run()
    second = run()
    assert first["sailings"]["total"] == second["sailings"]["total"]
    assert first["knowledge"] == second["knowledge"]
    assert first["knowledge_per_line"] == second["knowledge_per_line"]
