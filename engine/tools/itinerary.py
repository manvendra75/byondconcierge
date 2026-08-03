"""engine.tools.itinerary — deep itinerary detail for one line/sailing (TA.7).

A dedicated read tool for "what's the full itinerary / which ports does it visit /
where does it stop" questions. It combines the two grounded routing sources so the
agent can answer from real data, never invention:

  * the ordered ports of call of matching sailings in the catalogue (surfaced by the
    existing ``search_sailings`` tool — TA.1/TA.2/TA.4/TA.5), and
  * the curated, official-source featured itineraries published in cruise-lines.json
    (TA.3), which backfill concrete port runs for lines whose catalogue rows carry no
    route (e.g. Costa, Royal Caribbean).

Each source is labelled so the agent can cite where a route came from. No LLM here —
just SQL (via search_sailings) and a JSON read.
"""

from __future__ import annotations

import json
import re
import sqlite3

from engine.config import settings
from engine.schemas import (
    FeaturedItinerary,
    ItineraryDay,
    ItineraryResult,
    SailingFilters,
    ToolError,
)
from engine.tools.lines import _lines_by_slug          # cached cruise-lines.json {slug: line}
from engine.tools.sailings import search_sailings      # reuse the row/route/coverage shaping


# ---------------------------------------------------------------------------
# Narrowing a featured itinerary by an optional ship / itinerary name
# ---------------------------------------------------------------------------
def _featured_matches(f: dict, ship: str | None, name: str | None) -> bool:
    """True if a featured itinerary should be included given the optional narrowing.
    With no ship/name filter everything for the line matches; otherwise each supplied
    term must appear somewhere in the itinerary's text (name, region, ship or ports)."""
    if not ship and not name:
        return True
    hay = " ".join([
        f.get("name", ""), f.get("region", ""), f.get("ship", ""),
        " ".join(f.get("ports") or []),
    ]).lower()
    if ship and ship.lower() not in hay:
        return False
    if name and name.lower() not in hay:
        return False
    return True


# ---------------------------------------------------------------------------
# Day-by-day schedule — read the numbered day list for the narrowed sailing
# ---------------------------------------------------------------------------
def _nights_prefix(nights: int | str | None) -> str | None:
    """Leading integer of a nights value ("3", 3, "3 nights", "3-night") -> "3", else None.
    Used to match the stored ``nights`` label ("3 nights") without depending on its exact wording."""
    if nights is None:
        return None
    m = re.match(r"\s*(\d+)", str(nights))
    return m.group(1) if m else None


def _day_by_day(line_slug: str, ship: str | None, name: str | None,
                nights: int | str | None = None, sail_date: str | None = None) -> list[ItineraryDay]:
    """Return the numbered day-by-day schedule for the narrowed sailing (TC.1), read straight
    from the ``sailings`` table's ``itinerary_days_json`` column.

    We deliberately keep this OUT of ``search_sailings``: a normal search returns many rows and
    should never pay to decode a potentially long per-day list — only this deep itinerary tool
    loads it, and only for the one sailing the user asked about. The line is required; ship/name/
    nights/sail_date narrow to a specific sailing when given.

    ``nights`` and ``sail_date`` are what let a caller target ONE departure: a ship of a given
    length runs several distinct routes (e.g. Carnival Freedom sails 3-, 4- and 5-night Bahamas
    loops with different sea-day patterns), so matching only line+ship+name would return an
    arbitrary one — and the caller, seeing a schedule that doesn't fit, would fall back to the
    flat ports route (which omits sea days) and mislabel it as the day-by-day. Passing the
    nights (and/or the exact sail date) pins the real schedule, sea days included. We still take
    the first matching row and never fabricate days: no match yields ``[]`` ("on request").
    """
    clauses = ["line = ?"]
    params: list = [line_slug]
    if ship:
        clauses.append("ship LIKE ?")
        params.append(f"%{ship}%")
    if name:
        clauses.append("name LIKE ?")
        params.append(f"%{name}%")
    np = _nights_prefix(nights)
    if np is not None:
        # Match the stored "N nights" label by its leading integer, so "3" hits "3 nights" but
        # never "13 nights". Bucketed labels ("9-12 nights") still match on their first number.
        clauses.append("nights LIKE ?")
        params.append(f"{np} %")
    if sail_date:
        clauses.append("sail_date = ?")
        params.append(sail_date)
    # Only consider rows that carry a real schedule — skip NULL and the empty-array sentinel.
    clauses.append("itinerary_days_json IS NOT NULL AND itinerary_days_json NOT IN ('', '[]')")
    where = " AND ".join(clauses)

    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    try:
        row = conn.execute(
            f"SELECT itinerary_days_json FROM sailings WHERE {where} LIMIT 1", params
        ).fetchone()
    finally:
        conn.close()
    if not row:
        return []

    # Parse the stored JSON, tolerating a malformed value as "no schedule" rather than crashing.
    try:
        raw = json.loads(row["itinerary_days_json"])
    except (TypeError, json.JSONDecodeError):
        return []
    # Validate each entry into the typed day model; drop anything malformed instead of inventing
    # a day (pydantic's ValidationError is a ValueError subclass, so this catches both).
    days: list[ItineraryDay] = []
    for entry in raw:
        try:
            days.append(ItineraryDay(**entry))
        except (TypeError, ValueError):
            continue
    return days


# ---------------------------------------------------------------------------
# get_itinerary — the tool
# ---------------------------------------------------------------------------
def get_itinerary(line_slug: str, ship: str | None = None, name: str | None = None,
                  nights: int | str | None = None,
                  sail_date: str | None = None) -> ItineraryResult | ToolError:
    """Return the fullest published itinerary detail for one line, optionally narrowed
    to a ship, itinerary name, length (``nights``) and/or exact departure (``sail_date``).

    ``line_slug`` must be a known line slug (the agent wrapper resolves loose input to
    one first). Pass ``nights`` and/or ``sail_date`` when the user asks about a SPECIFIC
    departure — a ship runs several routes of different lengths, so those are what pin
    the correct day-by-day (with its sea days) instead of an arbitrary one. Returns a
    ``ToolError`` for an unknown line; otherwise an ``ItineraryResult`` carrying the
    matching sailings (with their routes), the curated featured itineraries, and the
    day-by-day schedule. When nothing matches, ``note`` tells the agent to offer the desk.
    """
    # The exported content is the authoritative list of represented lines; an unknown
    # slug here means the caller passed something we don't carry.
    line_data = _lines_by_slug().get(line_slug)
    if line_data is None:
        return ToolError(detail=f"unknown line '{line_slug}'")

    # (1) Matching sailings — reuse search_sailings so rows arrive already shaped with
    # ports of call, disembark port and a coverage label (TA.5). `name` isn't a search
    # filter, so we narrow on it here in Python.
    found = search_sailings(SailingFilters(line=line_slug, ship=ship))
    sailings = list(found.rows)
    if name:
        needle = name.lower()
        sailings = [r for r in sailings if needle in r.name.lower()]
    # Narrow the catalogue rows the same way we narrow the day-by-day, so the rows shown match the
    # sailing the day schedule describes (length, then exact departure when given).
    np = _nights_prefix(nights)
    if np is not None:
        sailings = [r for r in sailings if _nights_prefix(r.nights) == np]
    if sail_date:
        sailings = [r for r in sailings if getattr(r, "sail_date", None) == sail_date]

    # (2) Curated featured itineraries for the line (TA.3), narrowed the same way.
    featured = [
        FeaturedItinerary(
            region=f["region"], name=f["name"], ship=f["ship"],
            nights=f["nights"], departs=f["departs"], ports=f.get("ports", []),
        )
        for f in (line_data.get("featuredItineraries") or [])
        if _featured_matches(f, ship, name)
    ]

    # (3) Numbered day-by-day schedule (TC.1) for the narrowed sailing, read from the store.
    # Empty for every line until the builder/ingest start emitting it (TC.2/TC.3) — the renderer
    # then shows "day-by-day schedule on request" rather than inventing days.
    itinerary_days = _day_by_day(line_slug, ship, name, nights=nights, sail_date=sail_date)

    # (4) Nothing routable found anywhere — never invent; signal the agent to defer to the desk.
    note = None
    if not sailings and not featured and not itinerary_days:
        note = ("No itinerary is published for that line/sailing here — offer to confirm "
                "the port-by-port detail with the Byond Borders desk.")

    return ItineraryResult(
        line=line_slug,
        sailings=sailings,
        featured=featured,
        featured_as_of=line_data.get("featuredItinerariesAsOf"),
        itinerary_days=itinerary_days,
        note=note,
    )
