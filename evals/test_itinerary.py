"""Acceptance tests for the get_itinerary tool (TA.7 / Stage A close-out TA.8).

get_itinerary combines two grounded routing sources for one line: the ordered ports
of call of matching catalogue sailings (from the DB) and the curated featured
itineraries (from cruise-lines.json). It must:
  * return real routes for a line that has them (Aroya),
  * fall back to the curated featured routes when the catalogue has none (Costa),
  * narrow by ship / itinerary name,
  * signal "on request" (a note, never invented stops) when nothing matches, and
  * return a ToolError for an unknown line.

A module fixture loads the sailings into a throwaway DB (like test_sailings); the
featured itineraries come from the committed cruise-lines.json unchanged.

Run with: ``pytest evals/test_itinerary.py``.
"""

import json
import sqlite3

import pytest

import engine.config as config
import engine.db as db
from engine.agent import _render_itinerary
from engine.ingest.load_sailings import load_sailings
from engine.schemas import ItineraryResult, ToolError
from engine.tools.itinerary import get_itinerary


# ---------------------------------------------------------------------------
# Load sailings into a temp DB for the whole module (real cruise-lines.json)
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def temp_sailings(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("itinerary")
    object.__setattr__(config.settings, "db_path", tmp / "app.db")
    db.init_db()
    load_sailings()
    return tmp


# ---------------------------------------------------------------------------
# A rich line returns real catalogue routes, narrowed by itinerary name
# ---------------------------------------------------------------------------
def test_aroya_returns_ordered_ports_for_istanbul():
    res = get_itinerary("aroya", name="Istanbul")
    assert isinstance(res, ItineraryResult)
    # Every returned sailing matches the name narrow and carries an ordered route.
    assert res.sailings
    assert all("istanbul" in r.name.lower() for r in res.sailings)
    assert all(r.ports for r in res.sailings)
    # Aroya is portal-sourced now (SeawareTouch, TD.20): each route is the dated embark -> disembark
    # pair (intermediate ports live only behind the sailing's expanded card), so the disembark is the
    # last port, and a sailing that departs Istanbul keeps Istanbul first.
    assert all(r.port_disembark == r.ports[-1] for r in res.sailings)
    dep = next(r for r in res.sailings if r.ports[0] == "Istanbul")
    assert dep.ports[0] == "Istanbul" and dep.port_disembark == dep.ports[-1]


# ---------------------------------------------------------------------------
# A catalogue-routeless line still answers from the curated featured itineraries
# ---------------------------------------------------------------------------
def test_costa_catalogue_carries_real_routes():
    # TD.12: Costa is now acquisition-sourced from the CostaClick API, so its catalogue rows carry
    # real ports of call AND a numbered day-by-day schedule — it no longer falls back to featured
    # routes the way it did as a markdown line.
    res = get_itinerary("costa", name="Italy")
    assert res.sailings                                   # real catalogue matches
    assert any(r.ports for r in res.sailings)             # with ports of call (not "on request")
    assert res.itinerary_days                             # and a published day-by-day schedule


# ---------------------------------------------------------------------------
# Nothing matches -> a note (never invented stops), both sources empty
# ---------------------------------------------------------------------------
def test_no_match_returns_on_request_note():
    res = get_itinerary("aroya", name="a-sailing-that-does-not-exist")
    assert res.sailings == [] and res.featured == []
    assert res.note and "desk" in res.note.lower()


# ---------------------------------------------------------------------------
# An unknown line is a structured ToolError, not a crash
# ---------------------------------------------------------------------------
def test_unknown_line_returns_tool_error():
    res = get_itinerary("not-a-real-line")
    assert isinstance(res, ToolError)
    assert "unknown line" in res.detail.lower()


# ---------------------------------------------------------------------------
# Day-by-day (TC.1): absent by default -> the renderer says "on request"
# ---------------------------------------------------------------------------
def test_day_by_day_absent_says_on_request():
    # No line publishes a day list yet (that arrives with TC.2/TC.3), so a normal itinerary
    # carries no days and the rendered block offers the schedule on request — never fabricated.
    res = get_itinerary("aroya", name="Istanbul")
    assert res.itinerary_days == []
    assert "Day-by-day schedule on request." in _render_itinerary(res)


# ---------------------------------------------------------------------------
# Day-by-day (TC.3): the committed snapshot now carries Crystal's schedule, so a
# LIVE query returns its numbered, dated day-by-day — no synthetic injection needed.
# ---------------------------------------------------------------------------
def test_crystal_returns_dated_day_by_day_live():
    res = get_itinerary("crystal", name="Vancouver to Seward")
    # Populated straight from the ingested itinerary_days_json (TC.2 built it, TC.3 loads it).
    assert res.itinerary_days
    assert all(d.date for d in res.itinerary_days)                 # Crystal dates every day
    assert [d.day for d in res.itinerary_days][:3] == [1, 2, 3]    # numbered Day 1..N, in order
    # And it renders as a numbered block, not the "on request" fallback.
    rendered = _render_itinerary(res)
    assert "Day-by-day schedule:" in rendered and "Day 1 (" in rendered


# ---------------------------------------------------------------------------
# Day-by-day (TC.1): a sailing WITH a schedule renders Day 1..N, dates + sea days
# ---------------------------------------------------------------------------
def test_day_by_day_present_renders_numbered_list(temp_sailings):
    # Inject one sailing carrying a real day list straight into the temp DB (stands in for what
    # TC.2/TC.3 will load), then prove get_itinerary surfaces it and the renderer numbers Day 1..N.
    days = [
        {"day": 1, "date": "2026-08-08", "port": "Istanbul", "is_sea_day": False},
        {"day": 2, "date": "2026-08-09", "port": "At sea", "is_sea_day": True},
        {"day": 3, "date": "2026-08-10", "port": "Marmaris", "is_sea_day": False},
    ]
    conn = sqlite3.connect(config.settings.db_path)
    try:
        conn.execute(
            """INSERT INTO sailings (line, ship, name, dest, dest_label, nights, port,
                                     months_json, season_hint, count, itinerary_days_json)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
            ("aroya", "Aroya", "3 nights · Day-by-day sample", "Mediterranean", "Med",
             "3 nights", "Istanbul", "[]", None, 1, json.dumps(days)),
        )
        conn.commit()
    finally:
        conn.close()

    res = get_itinerary("aroya", name="Day-by-day sample")
    # The typed day list is surfaced in order...
    assert [d.day for d in res.itinerary_days] == [1, 2, 3]
    assert res.itinerary_days[1].is_sea_day
    # ...and the renderer prints a numbered Day 1..N block with dates and the sea-day label.
    rendered = _render_itinerary(res)
    assert "Day-by-day schedule:" in rendered
    assert "Day 1 (2026-08-08): Istanbul" in rendered
    assert "Day 2 (2026-08-09): At sea" in rendered
    assert "Day 3 (2026-08-10): Marmaris" in rendered


# ---------------------------------------------------------------------------
# Targeting a specific departure by nights/date returns THAT sailing's schedule
# (regression: without it, a ship's first row wins and its sea days go missing)
# ---------------------------------------------------------------------------
def test_get_itinerary_targets_the_right_sailing_by_nights_and_date(temp_sailings):
    # Same line + ship, two different-length routes. Only the 3-night has a sea day; the 4-night
    # does not. Matching on line+ship alone would return whichever row is first — the exact bug that
    # dropped the sea day. nights/date must pin the correct one.
    three = [
        {"day": 1, "date": "2026-08-15", "port": "Port Canaveral", "is_sea_day": False},
        {"day": 2, "date": "2026-08-16", "port": "Nassau", "is_sea_day": False},
        {"day": 3, "date": "2026-08-17", "port": "At sea", "is_sea_day": True},   # the sea day
        {"day": 4, "date": "2026-08-18", "port": "Port Canaveral", "is_sea_day": False},
    ]
    four = [
        {"day": 1, "date": "2026-08-06", "port": "Port Canaveral", "is_sea_day": False},
        {"day": 2, "date": "2026-08-07", "port": "Half Moon Cay", "is_sea_day": False},
        {"day": 3, "date": "2026-08-08", "port": "Celebration Key", "is_sea_day": False},
        {"day": 4, "date": "2026-08-09", "port": "Nassau", "is_sea_day": False},
        {"day": 5, "date": "2026-08-10", "port": "Port Canaveral", "is_sea_day": False},
    ]
    conn = sqlite3.connect(config.settings.db_path)
    try:
        for nights, sail_date, days in [("4 nights", "2026-08-06", four), ("3 nights", "2026-08-15", three)]:
            conn.execute(
                """INSERT INTO sailings (line, ship, name, dest, dest_label, nights, port,
                                         months_json, season_hint, count, sail_date, itinerary_days_json)
                   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)""",
                ("carnival", "Carnival Testboat", "The Bahamas", "Bahamas", "Bahamas",
                 nights, "Port Canaveral", "[]", None, 1, sail_date, json.dumps(days)),
            )
        conn.commit()
    finally:
        conn.close()

    # nights=3 -> the 4-day, sea-day-bearing schedule (NOT the 4-night's 5 days).
    by_nights = get_itinerary("carnival", ship="Carnival Testboat", name="Bahamas", nights=3)
    assert [d.day for d in by_nights.itinerary_days] == [1, 2, 3, 4]
    assert any(d.is_sea_day for d in by_nights.itinerary_days), "the 3-night's sea day must be present"
    assert "Day 3 (2026-08-17): At sea" in _render_itinerary(by_nights)

    # Exact date pins the same departure.
    by_date = get_itinerary("carnival", ship="Carnival Testboat", sail_date="2026-08-15")
    assert [d.day for d in by_date.itinerary_days] == [1, 2, 3, 4]
    assert any(d.is_sea_day for d in by_date.itinerary_days)

    # And the 4-night resolves to its own 5-day, sea-day-free schedule — proof we discriminate.
    by_four = get_itinerary("carnival", ship="Carnival Testboat", nights=4)
    assert [d.day for d in by_four.itinerary_days] == [1, 2, 3, 4, 5]
    assert not any(d.is_sea_day for d in by_four.itinerary_days)


# ---------------------------------------------------------------------------
# Umbrella-region search (TE): "Carnival in Europe, Sept 2026" must find sailings
# that a single-destination resolution would miss (the Greek-Isles Legend cruises).
# ---------------------------------------------------------------------------
def test_umbrella_region_search_finds_carnival_europe(temp_sailings):
    from engine.schemas import SailingFilters
    from engine.tools.resolve import resolve_destination, resolve_region
    from engine.tools.sailings import search_sailings

    europe = resolve_region("Europe")
    assert europe and len(europe) >= 2                 # Europe expands to a SET, not one bucket

    out = search_sailings(SailingFilters(line="carnival", dests=europe, month="2026-09"))
    assert out.status == "ok" and out.total_matches >= 1
    # It surfaces the Greek-Isles sailings — the exact ones a single "Europe" -> one-bucket resolution
    # would drop (resolve_destination("Europe") returns Northern Europe & Baltic, which has none here).
    assert resolve_destination("Europe") == "Northern Europe & Baltic"
    assert any("greek" in r.name.lower() for r in out.rows)
