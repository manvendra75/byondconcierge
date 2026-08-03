"""engine.tools.sailings — the deterministic sailings search tool.

This is the core read tool: it turns a set of structured filters into a
parameterized SQL query over the ``sailings`` table and returns typed rows. No
LLM, no invention — the model supplies validated filter arguments, and *code*
owns the query, the ranking, and the honesty rules (the guide's "code owns
business rules"). Sailings live in SQL precisely because this kind of exact,
filterable lookup is what relational storage is for — not a vector store.

Key behaviours the spec pins down:

* **Undated lines are never dropped** (FR2.4). Some catalogue lines publish a
  season, not exact months. When a month is requested we still include those
  rows, labelled "departure dates on request" — never silently hidden, never
  given invented dates.
* **Ranked + capped.** Rows sort by ``count`` (how many departures aggregate
  into the row) and cap at 15, with a "+N more" note when there are more.
* **Typed statuses.** ``ok`` / ``no_results`` / ``invalid_filters`` — the
  orchestrator branches on the status, never on a parsed message.
"""

from __future__ import annotations

import json
import re
import sqlite3

from engine.config import settings
from engine.schemas import SailingFilters, SailingRow, SearchSailingsOutput

# The most rows we return; the rest are summarised in a "+N more" note.
MAX_ROWS = 15

# Month-number -> short name, for building human coverage strings.
_MONTH_ABBR = ["", "Jan", "Feb", "Mar", "Apr", "May", "Jun",
               "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------------------
# Coverage string — a human date signal for one row
# ---------------------------------------------------------------------------
def _coverage(months_json: str, season_hint: str | None) -> str:
    """Turn a row's months + season into a readable coverage label.

    * Dated rows -> a month range, e.g. "Nov 2026 – Mar 2027" (or a single month).
    * Undated rows -> the season hint plus "departure dates on request", or just
      "departure dates on request" when there is no hint. We never fabricate a
      date for these.
    """
    months = sorted(json.loads(months_json))
    if months:
        lo, hi = _fmt_month(months[0]), _fmt_month(months[-1])
        return lo if lo == hi else f"{lo} – {hi}"
    if season_hint:
        return f"{season_hint}; departure dates on request"
    return "departure dates on request"


def _fmt_month(ym: str) -> str:
    """"2026-11" -> "Nov 2026"."""
    year, month = ym.split("-")
    return f"{_MONTH_ABBR[int(month)]} {year}"


def _fmt_date(iso: str) -> str:
    """"2026-08-08" -> "8 Aug 2026" — the exact departure date shown for a dated sailing (TB.4)."""
    year, month, day = iso.split("-")
    return f"{int(day)} {_MONTH_ABBR[int(month)]} {year}"


# ---------------------------------------------------------------------------
# Filters -> SQL WHERE clauses (parameterized)
# ---------------------------------------------------------------------------
# Each provided filter contributes one clause and one (or two) bound parameters.
# Only the column names are code — every value is bound with '?', so this is
# injection-safe even though the model chooses the values.
def _build_where(f: SailingFilters) -> tuple[list[str], list]:
    clauses: list[str] = []
    params: list = []

    # Destination: an umbrella-region set (dest IN (...)) takes precedence over a single dest, so a
    # "Europe" query matches every European bucket. One parameterised placeholder per destination
    # (never string-interpolated) keeps it injection-safe.
    if f.dests:                                   # umbrella region -> match any (TE.2)
        placeholders = ", ".join("?" for _ in f.dests)
        clauses.append(f"dest IN ({placeholders})")
        params.extend(f.dests)
    elif f.dest:                                  # single canonical destination -> exact
        clauses.append("dest = ?")
        params.append(f.dest)
    if f.dest_label:                              # line's sub-region wording -> LIKE
        clauses.append("dest_label LIKE ?")
        params.append(f"%{f.dest_label}%")
    if f.port:                                    # port name -> LIKE ("Rome" hits "Rome (Civitavecchia)")
        clauses.append("port LIKE ?")
        params.append(f"%{f.port}%")
    if f.line:                                    # line slug -> exact
        clauses.append("line = ?")
        params.append(f.line)
    if f.ship:                                    # ship name -> LIKE
        clauses.append("ship LIKE ?")
        params.append(f"%{f.ship}%")
    if f.name:                                    # itinerary name -> LIKE (find a specific sailing)
        clauses.append("name LIKE ?")
        params.append(f"%{f.name}%")
    # nights is text ("7 nights", or a range like "13–14 nights"). CAST pulls the
    # leading integer, so ranges filter by their lower bound — a sensible default.
    if f.nights_min is not None:
        clauses.append("CAST(nights AS INTEGER) >= ?")
        params.append(f.nights_min)
    if f.nights_max is not None:
        clauses.append("CAST(nights AS INTEGER) <= ?")
        params.append(f.nights_max)

    # Month: match the month token inside the JSON months array, OR keep undated
    # rows (empty months) so catalogue lines are never dropped (FR2.4). Only
    # applied when the month is a well-formed "YYYY-MM" (an unresolved/ambiguous
    # value is ignored rather than silently zeroing the results).
    if f.month and re.fullmatch(r"\d{4}-\d{2}", f.month):
        clauses.append("(months_json LIKE ? OR months_json = '[]')")
        params.append(f'%"{f.month}"%')

    # Date range (TB.5): filter dated sailings to [date_from, date_to]. Either bound also
    # excludes undated rows for free — in SQL, NULL compared with >=/<= is NULL (not true) — so
    # a date-range query returns ONLY concrete dated departures in the window, never catalogue
    # rows that have no date. Values are validated as strict YYYY-MM-DD before binding.
    if f.date_from and re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.date_from):
        clauses.append("sail_date >= ?")
        params.append(f.date_from)
    if f.date_to and re.fullmatch(r"\d{4}-\d{2}-\d{2}", f.date_to):
        clauses.append("sail_date <= ?")
        params.append(f.date_to)

    return clauses, params


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------
def search_sailings(filters: SailingFilters, today: str | None = None) -> SearchSailingsOutput:
    """Search the sailings catalogue against the given filters.

    ``today`` (a "YYYY-MM-DD" string) is INJECTED by the caller — the tool boundary calls the
    clock, not this function — so search stays deterministic and testable. When given, dated
    sailings that have already departed are dropped; undated catalogue rows are always kept.

    Returns a ``SearchSailingsOutput`` with one of three statuses:
      * ``invalid_filters`` — no usable filter was supplied (we won't dump the
        whole catalogue),
      * ``no_results`` — valid filters, but nothing matched,
      * ``ok`` — up to 15 ranked rows, with ``total_matches`` and a "+N more"
        note when the full match set is larger.
    """
    clauses, params = _build_where(filters)

    # Guard: refuse an unfiltered query (checked BEFORE the date clause, so `today` alone never
    # counts as a filter). Better to ask for a filter than to return an arbitrary slice.
    if not clauses:
        return SearchSailingsOutput(
            status="invalid_filters", total_matches=0,
            note="Provide at least one filter (destination, line, port, month, nights or ship).",
        )

    # Past-date filter (TB.4): a dated sailing is only shown if it departs on/after `today`;
    # undated rows (sail_date IS NULL) carry no date, so they are never filtered out.
    if today:
        clauses = [*clauses, "(sail_date IS NULL OR sail_date >= ?)"]
        params = [*params, today]

    where = " AND ".join(clauses)
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    try:
        # Full match count first (for total_matches + the "+N more" note)...
        total = conn.execute(f"SELECT COUNT(*) FROM sailings WHERE {where}", params).fetchone()[0]
        # ...then the top MAX_ROWS. Ranking (TB.4): dated departures first, soonest date first
        # (a concrete upcoming date is the most actionable thing to show); then undated catalogue
        # rows by departure count. Also pull the itinerary columns (ports/disembark) and sail_date.
        raw = conn.execute(
            f"""SELECT line, ship, name, dest_label, nights, port, months_json, season_hint,
                       count, ports_json, port_disembark, sail_date
                FROM sailings WHERE {where}
                ORDER BY (sail_date IS NULL), sail_date ASC, count DESC
                LIMIT {MAX_ROWS}""",
            params,
        ).fetchall()
    finally:
        conn.close()

    if total == 0:
        # A date-range query returns only dated departures, so lines that publish season/month-level
        # availability (no exact dates) can never match one — steer the caller to a month search,
        # which DOES include them (the undated-line date-retrieval nuance).
        note = "No sailings matched these filters."
        if filters.date_from or filters.date_to:
            note = ("No dated departures in that date range. Lines that publish only season/month-level "
                    "availability are not returned by a date range — search by month to include them.")
        return SearchSailingsOutput(status="no_results", total_matches=0, note=note)

    # Shape each DB row into a display row. Coverage: a dated row shows its EXACT date; an
    # undated row keeps the month-range / season label. The route (ports_json) is decoded,
    # tolerating NULL/empty as [].
    rows = [
        SailingRow(
            line=r["line"], ship=r["ship"], name=r["name"], dest_label=r["dest_label"],
            nights=r["nights"], port=r["port"], count=r["count"],
            coverage=_fmt_date(r["sail_date"]) if r["sail_date"] else _coverage(r["months_json"], r["season_hint"]),
            ports=json.loads(r["ports_json"]) if r["ports_json"] else [],
            port_disembark=r["port_disembark"],
            sail_date=r["sail_date"],
        )
        for r in raw
    ]
    note = f"+{total - MAX_ROWS} more" if total > MAX_ROWS else None
    return SearchSailingsOutput(status="ok", rows=rows, total_matches=total, note=note)
