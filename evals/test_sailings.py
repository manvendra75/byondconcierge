"""Acceptance tests for the search_sailings tool (T2.2).

Spec "Done when": Mediterranean + 2027-01 returns rows including at least one
undated line flagged "on request"; a nonsense port returns no_results. Plus the
guard cases (empty filters, line/nights filtering, ranking + cap).

A module fixture loads the sailings into a throwaway DB, so these run without
touching the real data/app.db.

Run with: ``pytest evals/test_sailings.py``.
"""

import re

import pytest

import engine.config as config
import engine.db as db
from engine.ingest.load_sailings import load_sailings
from engine.schemas import SailingFilters
from engine.tools.sailings import MAX_ROWS, search_sailings


# ---------------------------------------------------------------------------
# Load sailings into a temp DB for the whole module
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def temp_sailings(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("sailings")
    object.__setattr__(config.settings, "db_path", tmp / "app.db")
    db.init_db()
    load_sailings()
    return tmp


# ---------------------------------------------------------------------------
# The headline case: Mediterranean + January 2027
# ---------------------------------------------------------------------------
def test_mediterranean_january_returns_capped_page():
    out = search_sailings(SailingFilters(dest="Mediterranean", month="2027-01"))
    assert out.status == "ok"
    assert len(out.rows) == MAX_ROWS                     # capped
    assert out.total_matches > MAX_ROWS                  # more than one page
    assert out.note and out.note.startswith("+")         # "+N more"


# ---------------------------------------------------------------------------
# Undated catalogue lines stay honest — "on request", never a fabricated date
# ---------------------------------------------------------------------------
def test_undated_line_shows_on_request():
    out = search_sailings(SailingFilters(line="celebrity", dest="Mediterranean"))
    assert out.status == "ok"
    assert any("on request" in r.coverage for r in out.rows)


# ---------------------------------------------------------------------------
# A dated line surfaces EXACT departure dates, ranked soonest-first (TB.4)
# ---------------------------------------------------------------------------
def test_dated_line_shows_exact_dates_soonest_first():
    out = search_sailings(SailingFilters(line="costa", month="2027-01"))
    assert out.status == "ok"
    assert all(r.sail_date for r in out.rows)                    # every row is a dated departure
    assert [r.sail_date for r in out.rows] == sorted(r.sail_date for r in out.rows)  # soonest first
    assert all(r.sail_date[:7] == "2027-01" for r in out.rows)   # month filter honoured
    assert all("2027" in r.coverage for r in out.rows)           # coverage shows the exact date


# ---------------------------------------------------------------------------
# Past-date filtering (TB.4): injected `today` hides departed sailings
# ---------------------------------------------------------------------------
def test_past_dates_are_filtered_out():
    unfiltered = search_sailings(SailingFilters(line="costa"))
    assert any(r.sail_date < "2027-01-01" for r in unfiltered.rows)   # early departures exist...
    filtered = search_sailings(SailingFilters(line="costa"), today="2027-01-01")
    assert filtered.status == "ok"
    assert all(r.sail_date >= "2027-01-01" for r in filtered.rows)    # ...and are gone once today is set


def test_past_date_filter_keeps_undated_rows():
    out = search_sailings(SailingFilters(line="celebrity"), today="2027-06-01")
    assert out.status == "ok"
    assert all(r.sail_date is None for r in out.rows)   # undated rows carry no date, never filtered


# ---------------------------------------------------------------------------
# Date-range filter (TB.5): only concrete dated departures inside [from, to]
# ---------------------------------------------------------------------------
def test_date_range_returns_only_in_range_dated_rows():
    # The spec's Done-when: "Costa sailings in the first half of August".
    out = search_sailings(SailingFilters(line="costa", date_from="2026-08-01", date_to="2026-08-15"))
    assert out.status == "ok"
    assert out.rows
    assert all(r.sail_date and "2026-08-01" <= r.sail_date <= "2026-08-15" for r in out.rows)


def test_date_range_excludes_undated_rows():
    # A broad dest date-range must drop catalogue (undated) lines — they have no date to match.
    out = search_sailings(SailingFilters(dest="Caribbean", date_from="2026-09-01", date_to="2026-09-30"))
    assert out.status == "ok"
    assert all(r.sail_date is not None for r in out.rows)


# ---------------------------------------------------------------------------
# Undated-line date-retrieval fallback: a date query on a season-only line falls
# back to a MONTH search (which includes it) instead of reporting "no sailings".
# ---------------------------------------------------------------------------
def test_date_search_falls_back_to_month_for_undated_line():
    from engine.agent import _tool_search_sailings

    # A named sailing on a season-only line (Scenic's "Idyllic Rhône"): the date-range search finds
    # no dated departures, so the tool wrapper retries at month granularity — keeping the name
    # filter — and surfaces the exact sailing with a "confirm via the desk" note, instead of
    # falsely reporting "no sailings".
    out = _tool_search_sailings(line="Scenic", name="Idyllic Rhône", dates="September 2026")
    assert "Idyllic Rhône" in out
    assert "Byond Borders desk" in out


def test_name_filter_finds_a_specific_sailing():
    # The name filter locates a specific itinerary regardless of count-ranking.
    out = search_sailings(SailingFilters(line="scenic-emerald", name="Idyllic Rhône"))
    assert out.status == "ok"
    assert all("idyllic rhône" in r.name.lower() for r in out.rows)


# ---------------------------------------------------------------------------
# A nonsense port matches nothing -> no_results
# ---------------------------------------------------------------------------
def test_nonsense_port_is_no_results():
    out = search_sailings(SailingFilters(port="Narnia-on-Sea"))
    assert out.status == "no_results"
    assert out.total_matches == 0
    assert out.rows == []


# ---------------------------------------------------------------------------
# No filters at all -> invalid_filters (we don't dump the catalogue)
# ---------------------------------------------------------------------------
def test_empty_filters_is_invalid():
    out = search_sailings(SailingFilters())
    assert out.status == "invalid_filters"
    assert out.rows == [] and out.total_matches == 0
    assert "filter" in out.note.lower()


# ---------------------------------------------------------------------------
# Line filter is honoured on every returned row
# ---------------------------------------------------------------------------
def test_line_filter_scopes_rows():
    out = search_sailings(SailingFilters(line="celebrity"))
    assert out.status == "ok"
    assert all(r.line == "celebrity" for r in out.rows)


# ---------------------------------------------------------------------------
# Nights range is applied (all rows fall within the requested band)
# ---------------------------------------------------------------------------
def test_nights_range_filter():
    out = search_sailings(SailingFilters(dest="Mediterranean", nights_min=10, nights_max=14))
    assert out.status == "ok"
    for r in out.rows:
        # Match the tool's CAST semantics: the leading integer ("13–14 nights" -> 13).
        n = int(re.match(r"\d+", r.nights).group())
        assert 10 <= n <= 14


# ---------------------------------------------------------------------------
# Undated rows keep the departure-count ranking (TB.4 leaves them on count DESC)
# ---------------------------------------------------------------------------
def test_undated_rows_ranked_by_count():
    # Celebrity is an undated line, so every row is count-ranked (no dates to sort by).
    out = search_sailings(SailingFilters(line="celebrity"))
    assert all(r.sail_date is None for r in out.rows)
    counts = [r.count for r in out.rows]
    assert counts == sorted(counts, reverse=True)
