"""engine.ingest.load — one command to (re)build all engine data.

Runs the full ingest pipeline in order and prints a reconciliation table, so a
single command populates every store and shows you it worked:

    python -m engine.ingest.load

Steps (each already idempotent, so the whole thing is safe to re-run):

  1. init_db()        — ensure the SQLite schema exists
  2. load_sailings()  — fill the `sailings` table from the committed index
  3. load_knowledge() — (re)build the Chroma `knowledge` collection

A second run prints identical counts.
"""

from __future__ import annotations

from collections import Counter

import chromadb

from engine.config import settings
from engine.db import init_db
from engine.ingest.load_knowledge import (
    COLLECTION_NAME,
    get_embedding_function,
    load_knowledge,
)
from engine.ingest.load_sailings import load_sailings
from engine.validate import summarize, validate_assumptions


# ---------------------------------------------------------------------------
# Per-line knowledge counts — read back from the built collection's metadata
# ---------------------------------------------------------------------------
# load_knowledge() reports totals but not a per-line breakdown; we get that by
# reading the collection's metadata after it is built, then counting by `line`.
def _knowledge_per_line() -> Counter:
    client = chromadb.PersistentClient(path=str(settings.chroma_dir))
    col = client.get_collection(COLLECTION_NAME, embedding_function=get_embedding_function())
    metas = col.get(include=["metadatas"])["metadatas"]
    return Counter(m["line"] for m in metas)


# ---------------------------------------------------------------------------
# The pipeline — run every step, return the combined counts
# ---------------------------------------------------------------------------
def run() -> dict:
    """Execute the full ingest and return a summary dict (no printing), so tests
    can assert on the numbers and main() can format them."""
    init_db()
    sailings = load_sailings()
    knowledge = load_knowledge()
    return {
        "sailings": sailings,                           # {total, per_line}
        "knowledge": knowledge,                         # {total, briefs, content}
        "knowledge_per_line": dict(_knowledge_per_line()),
    }


# ---------------------------------------------------------------------------
# CLI — run the pipeline and print the reconciliation table
# ---------------------------------------------------------------------------
def main() -> None:
    result = run()
    sail, know, kpl = result["sailings"], result["knowledge"], result["knowledge_per_line"]

    print()
    print("Ingest complete")
    print(f"  Sailings rows : {sail['total']}")
    print(f"  Chroma chunks : {know['total']} "
          f"({know['briefs']} brief + {know['content']} content)")
    print()

    # Per-line coverage: sailings rows vs knowledge chunks, side by side. The
    # union of keys includes 'general' (shared knowledge with no sailings).
    print(f"  {'line':<16}{'sailings':>10}{'knowledge':>11}")
    print(f"  {'-' * 16}{'-' * 10:>10}{'-' * 11:>11}")
    for line in sorted(set(sail["per_line"]) | set(kpl)):
        print(f"  {line:<16}{sail['per_line'].get(line, 0):>10}{kpl.get(line, 0):>11}")
    print()

    # Drift guard: re-check the hard-coded assumptions against this data. Any
    # failing check is printed so a refresh that outgrew an assumption is obvious.
    checks = validate_assumptions()
    passed, warnings, errors = summarize(checks)
    print(f"  Assumptions   : {passed} ok · {warnings} warnings · {errors} errors")
    for c in checks:
        if not c.ok:
            print(f"    [{'FAIL' if c.severity == 'error' else 'WARN'}] {c.name}: {c.detail}")
    print()


if __name__ == "__main__":
    main()
