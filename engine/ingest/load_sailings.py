"""engine.ingest.load_sailings — load the sailings catalogue into SQLite.

The deterministic sailings search (T2.x) filters over a plain SQL table, not a
vector store (the guide's "storage by access pattern" rule: structured data →
structured store). This module fills that table from the exported index.

Source of truth: ``data/sailings-index.json`` — a snapshot generated in the
*website* repo (`npm run build:index`) and committed into this repo, exactly like
``cruise-lines.json``. Reading it from our own ``data/`` folder (rather than
reaching into a sibling website checkout) keeps this repo self-contained: a fresh
clone can ingest and run with no website present.

Run it directly:

    python -m engine.ingest.load_sailings

It is idempotent — it clears the table and reloads, so running twice leaves the
same rows.
"""

from __future__ import annotations

import json
import sqlite3
from collections import Counter

from engine.config import PROJECT_ROOT, settings
from engine.db import init_db

# The committed snapshot this loader reads. Kept alongside the other engine data.
SAILINGS_INDEX = PROJECT_ROOT / "data" / "sailings-index.json"


def snapshot_date() -> str | None:
    """The date the committed sailings index was generated (its top-level ``generated`` field),
    or None if the file is missing/unreadable. Used to show data freshness in the UI and to warn
    when the snapshot is stale (TB.6). Read fresh each call so freshness is never cached across a
    data rebuild."""
    try:
        return json.loads(SAILINGS_INDEX.read_text(encoding="utf-8")).get("generated")
    except (OSError, json.JSONDecodeError):
        return None


# ---------------------------------------------------------------------------
# Column order — a single source of truth for the INSERT and the row tuple
# ---------------------------------------------------------------------------
# _row_from_record returns its values in THIS exact order, and the INSERT below is
# generated from this same list, so the two can never silently drift apart. The
# `sailings_load_columns` validation hook asserts _row_from_record stays aligned with
# this list — a mismatch (a column added to one but not the other, or reordered) would
# otherwise land data in the wrong column with no error.
_INSERT_COLUMNS = (
    "line", "ship", "name", "dest", "dest_label", "nights", "port",
    "months_json", "season_hint", "count", "ports_json", "port_disembark", "sail_date",
    "itinerary_days_json",
)
_INSERT_SQL = (
    f"INSERT INTO sailings ({', '.join(_INSERT_COLUMNS)}) "
    f"VALUES ({', '.join(['?'] * len(_INSERT_COLUMNS))})"
)


# ---------------------------------------------------------------------------
# Shape one JSON record into the sailings table's column order
# ---------------------------------------------------------------------------
# We map the JSON field names onto the columns in _INSERT_COLUMNS order: months[] ->
# months_json, seasonHint -> season_hint, ports[] -> ports_json, portDisembark ->
# port_disembark, itineraryDays[] -> itinerary_days_json. All of the itinerary fields are
# optional in the source (a line without route/endpoint/day data omits them), so we use .get()
# and store an empty array / NULL rather than requiring them (TA.4 / TC.3).
def _row_from_record(rec: dict) -> tuple:
    """Return a record as a tuple of values in ``_INSERT_COLUMNS`` order."""
    return (
        rec["line"],
        rec["ship"],
        rec["name"],
        rec["dest"],
        rec["destLabel"],
        rec["nights"],
        rec["port"],
        json.dumps(rec.get("months", [])),        # store the months[] array as JSON text
        rec.get("seasonHint"),                     # None when the line publishes no months
        rec["count"],
        json.dumps(rec.get("ports", [])),          # ordered ports of call as JSON text (TA.4)
        rec.get("portDisembark"),                  # arrival port, None when unpublished (TA.4)
        rec.get("date"),                           # exact sail date, None for catalogue lines (TB.3)
        json.dumps(rec.get("itineraryDays", [])),  # numbered day-by-day schedule as JSON text (TC.3);
                                                   # "[]" for the lines that publish none, so the
                                                   # itinerary reader treats them as "on request"
    )


# ---------------------------------------------------------------------------
# The load itself — clear then bulk-insert, in one transaction
# ---------------------------------------------------------------------------
def load_sailings() -> dict:
    """Load every record from the index into the ``sailings`` table.

    Idempotent: deletes existing rows first, so the table always mirrors the
    current snapshot exactly (no duplicates on re-run). Returns a small summary
    dict — total loaded plus per-line counts — for the caller to print/verify.
    """
    init_db()   # make sure the table exists (harmless if it already does)

    # Load the snapshot and pull out the records array.
    with open(SAILINGS_INDEX, encoding="utf-8") as f:
        records = json.load(f)["records"]

    rows = [_row_from_record(r) for r in records]

    conn = sqlite3.connect(settings.db_path)
    try:
        # One transaction: clear the table, then bulk-insert all rows. If
        # anything fails, the whole thing rolls back and the old data stays.
        conn.execute("DELETE FROM sailings")
        conn.executemany(_INSERT_SQL, rows)   # column list + placeholders from _INSERT_COLUMNS
        conn.commit()
    finally:
        conn.close()

    # Per-line counts, sorted high-to-low, for the report.
    per_line = dict(Counter(r[0] for r in rows).most_common())
    return {"total": len(rows), "per_line": per_line}


# ---------------------------------------------------------------------------
# CLI entry point — print a human-readable report
# ---------------------------------------------------------------------------
def main() -> None:
    summary = load_sailings()
    print(f"Loaded {summary['total']} sailings from {SAILINGS_INDEX.name}")
    for line, n in summary["per_line"].items():
        print(f"  {line:<16} {n}")


if __name__ == "__main__":
    main()
