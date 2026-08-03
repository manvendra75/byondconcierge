"""engine.reports — read-only exports of the application store, for the team.

A small CLI over the SQLite tables the app fills. Today it exposes the two the
sales/ops team asks for by hand otherwise:

* ``python -m engine.reports users``  — every registered agency + its enquiry count
* ``python -m engine.reports leads``  — every captured enquiry (with the agency)

Add ``--csv`` to emit CSV to stdout (pipe to a file / spreadsheet); without it you
get an aligned console table. Data comes from ``engine.db`` read-helpers, so the DB
path always follows ``settings.db_path`` — nothing is hard-coded.

PII note: unlike ``engine.trace`` (which masks email/phone before storing), these
reports show REAL contact details on purpose — that's the point of the export, and
it is for authorized internal use only.

This module is deliberately structured as an argparse sub-command dispatcher so the
T7.1 observability reports (cost/turn, cost/lead, p50/p95 latency from ``traces``)
can be added later as further sub-commands on the same parser.
"""

from __future__ import annotations

import argparse
import csv
import io
import sys

from engine.db import list_leads, list_users

# Each report = the ordered columns to show and the read-helper that supplies rows.
# Keeping the column order here (not relying on dict order) makes the CSV header and
# the table columns explicit and stable.
_REPORTS = {
    "users": {
        "columns": ["agency", "full_name", "email", "phone", "created_at", "enquiries"],
        "fetch": list_users,
    },
    "leads": {
        "columns": ["created_at", "agency", "user_email", "line_slug", "month",
                    "party_size", "email_status", "summary"],
        "fetch": list_leads,
    },
}


# ---------------------------------------------------------------------------
# Rendering — CSV or an aligned text table, from the same (rows, columns)
# ---------------------------------------------------------------------------
def _render(rows: list[dict], columns: list[str], as_csv: bool) -> str:
    """Format rows into either CSV (header + one line per row) or a padded
    console table. Missing/None cells render as an empty string ("") so a lead
    with no month/party doesn't break the alignment."""
    def cell(row: dict, col: str) -> str:
        v = row.get(col)
        return "" if v is None else str(v)

    if as_csv:
        # Write CSV to a string via the stdlib writer (handles quoting/commas in
        # free-text fields like the enquiry summary).
        buf = io.StringIO()
        writer = csv.DictWriter(buf, fieldnames=columns, extrasaction="ignore")
        writer.writeheader()
        for row in rows:
            writer.writerow({c: cell(row, c) for c in columns})
        return buf.getvalue()

    if not rows:
        return "(no rows)"

    # Aligned table: each column as wide as its widest cell (or its header).
    widths = {c: max(len(c), *(len(cell(r, c)) for r in rows)) for c in columns}
    header = "  ".join(c.ljust(widths[c]) for c in columns)
    rule = "  ".join("-" * widths[c] for c in columns)
    body = "\n".join("  ".join(cell(r, c).ljust(widths[c]) for c in columns) for r in rows)
    return f"{header}\n{rule}\n{body}\n\n{len(rows)} row(s)"


# ---------------------------------------------------------------------------
# CLI — one sub-command per report, a shared --csv flag
# ---------------------------------------------------------------------------
def main(argv: list[str] | None = None) -> None:
    """Parse args and print the requested report. ``argv`` is accepted so tests
    can drive it directly; it defaults to the process arguments."""
    parser = argparse.ArgumentParser(
        prog="python -m engine.reports",
        description="Export the registered agencies / captured leads from the app store.",
    )
    sub = parser.add_subparsers(dest="report", required=True)
    for name in _REPORTS:
        p = sub.add_parser(name, help=f"list all {name}")
        p.add_argument("--csv", action="store_true", help="emit CSV to stdout instead of a table")

    args = parser.parse_args(argv)
    spec = _REPORTS[args.report]
    rows = spec["fetch"]()
    # print without a trailing extra newline for CSV; the table already spaces itself.
    sys.stdout.write(_render(rows, spec["columns"], as_csv=args.csv))
    if not args.csv:
        sys.stdout.write("\n")


if __name__ == "__main__":
    main()
