"""Validation hooks for hard-coded assumptions (drift guard).

These tests fail the moment a hard-coded value in the code (month window,
canonical destinations, line slugs, expected fields, model prices) no longer
matches the committed source data — i.e. when a data refresh has drifted past an
assumption. See engine/validate.py for the checks and docs/ASSUMPTIONS.md for the
registry.

Run with: ``pytest evals/test_assumptions.py``.
"""

from engine.validate import (
    _DAY_BY_DAY_LINES,
    _check_day_by_day_coverage,
    _check_day_by_day_parses,
    _check_disembark_coverage,
    _check_featured_itinerary_fields,
    _check_no_currency_in_itinerary,
    _check_ports_coverage,
    _check_region_expansion,
    _check_sail_dates,
    summarize,
    validate_assumptions,
)


# ---------------------------------------------------------------------------
# No error-level drift: every hard-coded assumption still holds against the data
# ---------------------------------------------------------------------------
def test_no_assumption_errors():
    checks = validate_assumptions()
    errors = [c for c in checks if not c.ok and c.severity == "error"]
    # Build a readable message so a failure names exactly which assumption drifted.
    assert not errors, "assumption drift:\n" + "\n".join(f"  - {c.name}: {c.detail}" for c in errors)


# ---------------------------------------------------------------------------
# Warnings are surfaced (not fatal) — this asserts the summary wiring works and
# prints any warnings so they show in -s output rather than passing invisibly.
# ---------------------------------------------------------------------------
def test_warnings_are_reported(capsys):
    checks = validate_assumptions()
    passed, warnings, errors = summarize(checks)
    assert passed + warnings + errors == len(checks)      # every check is accounted for
    for c in checks:
        if not c.ok and c.severity == "warn":
            print(f"WARN {c.name}: {c.detail}")


# ---------------------------------------------------------------------------
# ports_coverage (TA.1) — catches a builder regression that drops routes again
# ---------------------------------------------------------------------------
def test_ports_coverage_flags_when_routes_are_dropped():
    # A dataset where almost no record carries a route — as if the builder regressed
    # to dropping ports of call — must trip the warn-level ports_coverage check.
    starved = [{"ports": []} for _ in range(90)] + [{"ports": ["Athens", "Santorini"]} for _ in range(10)]
    starved_check = _check_ports_coverage(starved)
    assert not starved_check.ok and starved_check.severity == "warn"

    # A dataset comfortably above the floor passes.
    healthy = [{"ports": ["Athens", "Santorini"]} for _ in range(50)] + [{"ports": []} for _ in range(50)]
    assert _check_ports_coverage(healthy).ok


# ---------------------------------------------------------------------------
# disembark_coverage (TA.2) — catches an endpoint read breaking
# ---------------------------------------------------------------------------
def test_disembark_coverage_flags_when_endpoints_break():
    # Half the records lost their disembark port (as if a parser's endpoint read broke) —
    # below the floor, so the warn-level check must trip.
    starved = [{} for _ in range(50)] + [{"portDisembark": "Barcelona"} for _ in range(50)]
    starved_check = _check_disembark_coverage(starved)
    assert not starved_check.ok and starved_check.severity == "warn"

    # A dataset at ~95% coverage (RC-style gaps aside) passes.
    healthy = [{"portDisembark": "Barcelona"} for _ in range(95)] + [{} for _ in range(5)]
    assert _check_disembark_coverage(healthy).ok


# ---------------------------------------------------------------------------
# day_by_day_coverage (TC.3) — catches an expected day-by-day line losing its schedule
# ---------------------------------------------------------------------------
def test_region_expansion_targets_are_canonical():
    # The live umbrella-region map (TE) must expand only to canonical destinations, each to >= 2.
    assert _check_region_expansion([]).ok

    # A broken map (non-canonical target / single-destination umbrella) must be caught (error-level).
    import engine.validate as v
    good = v._REGION_DESTINATIONS
    try:
        v._REGION_DESTINATIONS = {"atlantis": ["Nowhere Land"]}
        bad = _check_region_expansion([])
        assert not bad.ok and bad.severity == "error"
    finally:
        v._REGION_DESTINATIONS = good


def test_day_by_day_coverage_flags_missing_line():
    # Every expected day-by-day line carries a schedule -> passes; a non-expected line carries none.
    # Built from _DAY_BY_DAY_LINES so the fixture tracks the set as acquisition adds lines (TC.6).
    healthy = [
        {"line": line, "itineraryDays": [{"day": 1, "port": "Somewhere", "is_sea_day": False}]}
        for line in _DAY_BY_DAY_LINES
    ] + [{"line": "costa", "itineraryDays": []}]
    assert _check_day_by_day_coverage(healthy).ok

    # A builder regression / stale publish drops one expected line's day lists -> warn-level trip.
    starved = [
        {"line": line, "itineraryDays": [{"day": 1, "port": "Somewhere", "is_sea_day": False}]}
        for line in sorted(_DAY_BY_DAY_LINES)[1:]                    # omit one expected line
    ]
    check = _check_day_by_day_coverage(starved)
    assert not check.ok and check.severity == "warn"


# ---------------------------------------------------------------------------
# day_by_day_parses (TC.3) — committed day JSON must deserialize into ItineraryDay
# ---------------------------------------------------------------------------
def test_day_by_day_parses_flags_bad_entry():
    # Well-formed entries parse cleanly.
    good = [{"line": "crystal", "name": "x",
             "itineraryDays": [{"day": 1, "date": "2026-07-11", "port": "Vancouver", "is_sea_day": False}]}]
    assert _check_day_by_day_parses(good).ok

    # A day missing the required `port` (as if the builder keys drifted from the ItineraryDay model)
    # fails model construction — the reader would silently drop it, so the check must catch it (error).
    bad = [{"line": "crystal", "name": "x", "itineraryDays": [{"day": 1, "is_sea_day": False}]}]
    check = _check_day_by_day_parses(bad)
    assert not check.ok and check.severity == "error"


# ---------------------------------------------------------------------------
# featured_itinerary_fields (TA.3) — catches a renamed/missing key
# ---------------------------------------------------------------------------
def test_featured_itinerary_fields_flags_missing_key():
    good = {"region": "Med", "name": "Greece & Turkey", "ship": "Costa Fortuna",
            "nights": "7 nights", "departs": "Piraeus", "ports": ["Piraeus", "Mykonos"]}
    # A complete entry passes; a copy missing the ship key trips the warn-level check.
    assert _check_featured_itinerary_fields([{"slug": "costa", "featuredItineraries": [good]}]).ok
    broken = {k: v for k, v in good.items() if k != "ship"}
    check = _check_featured_itinerary_fields([{"slug": "costa", "featuredItineraries": [broken]}])
    assert not check.ok and check.severity == "warn"


# ---------------------------------------------------------------------------
# no_currency_in_itinerary (TA.1/TA.2/TA.3) — the hard no-price guard
# ---------------------------------------------------------------------------
def test_no_currency_in_itinerary_catches_a_price():
    clean_records = [{"ports": ["Piraeus", "Mykonos"], "portDisembark": "Piraeus"}]
    clean_lines = [{"slug": "costa", "featuredItineraries": [
        {"name": "Greece & Turkey", "ship": "Costa Fortuna",
         "nights": "7 nights · 57 departures", "departs": "Piraeus", "ports": ["Piraeus"]}]}]
    # Clean data (note "57 departures" is not currency) passes at error-level.
    assert _check_no_currency_in_itinerary(clean_records, clean_lines).ok

    # A price leaking into a featured itinerary must fail (error-level).
    priced_lines = [{"slug": "costa", "featuredItineraries": [
        {"name": "Greece from €349", "ship": "Costa Fortuna",
         "nights": "7 nights", "departs": "Piraeus", "ports": ["Piraeus"]}]}]
    check = _check_no_currency_in_itinerary(clean_records, priced_lines)
    assert not check.ok and check.severity == "error"

    # And a price sneaking into a sailing route also fails.
    priced_records = [{"ports": ["Piraeus", "from $1,299"], "portDisembark": "Piraeus"}]
    assert not _check_no_currency_in_itinerary(priced_records, clean_lines).ok

    # A price hidden in a rendered free-text field (the sailing name) also fails (TA.6).
    named_records = [{"name": "Greek Isles cruise from $999", "ports": [], "portDisembark": None}]
    assert not _check_no_currency_in_itinerary(named_records, clean_lines).ok

    # A price sneaking into a day-by-day port label also fails (TC.3).
    day_priced = [{"ports": [], "portDisembark": None,
                   "itineraryDays": [{"day": 1, "port": "Santorini from €499", "is_sea_day": False}]}]
    assert not _check_no_currency_in_itinerary(day_priced, clean_lines).ok


# ---------------------------------------------------------------------------
# sailings_load_columns (TA.4) — catches the loader tuple drifting from the INSERT
# ---------------------------------------------------------------------------
def test_sailings_load_columns_flags_tuple_drift(monkeypatch):
    import engine.validate as v

    rec = {"line": "aroya", "ship": "Aroya", "name": "n", "dest": "Mediterranean",
           "destLabel": "Med", "nights": "6 nights", "port": "Istanbul", "count": 1,
           "ports": ["Istanbul", "Marmaris"], "portDisembark": "Marmaris",
           "itineraryDays": [{"day": 1, "port": "Istanbul", "is_sea_day": False}]}
    # The real loader tuple aligns with the INSERT column list (incl. itinerary_days_json, TC.3).
    assert v._check_sailings_load_columns([rec]).ok

    # Simulate a drift: a loader that returns the wrong number of values (as if a column
    # was added to the INSERT but not to _row_from_record). The check must fail, error-level.
    monkeypatch.setattr(v, "_row_from_record", lambda r: ("too", "short"))
    drifted = v._check_sailings_load_columns([rec])
    assert not drifted.ok and drifted.severity == "error"


# ---------------------------------------------------------------------------
# sail_dates (TB.3) — committed dates must be valid, count:1, all-or-nothing per line
# ---------------------------------------------------------------------------
def test_sail_dates_flags_bad_data():
    dated = {"line": "aroya", "count": 1, "date": "2026-08-08"}
    undated = {"line": "norwegian", "count": 5}
    # A clean mix (one dated line, one catalogue line) passes.
    assert _check_sail_dates([dated, undated]).ok

    # An impossible calendar date fails.
    assert not _check_sail_dates([{"line": "aroya", "count": 1, "date": "2026-02-31"}]).ok
    # A non-strict format that datetime.fromisoformat WOULD accept ('20260808') must still fail —
    # TB.4 compares dates as strings, so only the dashed 10-char form sorts correctly.
    assert not _check_sail_dates([{"line": "aroya", "count": 1, "date": "20260808"}]).ok
    # A dated record that wasn't de-aggregated (count != 1) fails.
    assert not _check_sail_dates([{"line": "aroya", "count": 4, "date": "2026-08-08"}]).ok
    # A line mixing a dated and an undated record (partial de-aggregation) fails.
    mixed = [{"line": "aroya", "count": 1, "date": "2026-08-08"}, {"line": "aroya", "count": 3}]
    assert not _check_sail_dates(mixed).ok


# ---------------------------------------------------------------------------
# stale_snapshot (TB.6) — warns once the committed snapshot ages past the threshold
# ---------------------------------------------------------------------------
def test_stale_snapshot_flags_old_generated():
    from datetime import date, timedelta

    from engine.ingest.load_sailings import snapshot_date
    from engine.validate import _STALE_SNAPSHOT_DAYS, _check_stale_snapshot

    gen = snapshot_date()
    assert gen, "committed sailings snapshot must carry a `generated` date"
    g = date.fromisoformat(gen)

    # A reference date a few days after `generated` is fresh (passes).
    assert _check_stale_snapshot(today=(g + timedelta(days=5)).isoformat()).ok

    # Well past the threshold, it warns (warn-level, not an error).
    stale = _check_stale_snapshot(today=(g + timedelta(days=_STALE_SNAPSHOT_DAYS + 10)).isoformat())
    assert not stale.ok and stale.severity == "warn"


# ---------------------------------------------------------------------------
# date_range_resolver (TB.5) — resolver output must match what search accepts
# ---------------------------------------------------------------------------
def test_date_range_resolver_flags_bad_output(monkeypatch):
    import engine.validate as v

    # The real resolver satisfies the contract.
    assert v._check_date_range_resolver().ok

    # A resolver emitting a non-strict format ('2026-8-1') — which _build_where would silently
    # drop, returning unfiltered results — must fail the check.
    monkeypatch.setattr(v, "resolve_date_range", lambda t: ("2026-8-1", "2026-8-15"))
    assert not v._check_date_range_resolver().ok

    # A resolver emitting from > to (an empty/backwards range) must also fail.
    monkeypatch.setattr(v, "resolve_date_range", lambda t: ("2026-08-31", "2026-08-01"))
    assert not v._check_date_range_resolver().ok


# ---------------------------------------------------------------------------
# search_filters_applied — every SailingFilters field must reach a WHERE clause
# ---------------------------------------------------------------------------
def test_search_filters_applied_flags_ignored_filter(monkeypatch):
    import engine.validate as v

    # The real search honors every filter.
    assert v._check_search_filters_applied().ok

    # A _build_where that drops filters (returns no clauses) — i.e. a field silently ignored —
    # must be caught, error-level.
    monkeypatch.setattr(v, "_build_where", lambda f: ([], []))
    check = v._check_search_filters_applied()
    assert not check.ok and check.severity == "error"


# ---------------------------------------------------------------------------
# itinerary_days_render (TC.1) — the day-by-day model/renderer must stay in step
# ---------------------------------------------------------------------------
def test_itinerary_days_render_flags_renderer_drift(monkeypatch):
    import engine.agent as agent
    import engine.validate as v

    # The real column + model + renderer are in step.
    assert v._check_itinerary_days_render().ok

    # A renderer that drops the day list (no "Day N" line) — i.e. ItineraryDay and the renderer
    # drifted apart — must be caught, error-level. The check re-imports _render_itinerary from
    # engine.agent at call time, so patching it there takes effect.
    monkeypatch.setattr(agent, "_render_itinerary", lambda res: "no days rendered here")
    check = v._check_itinerary_days_render()
    assert not check.ok and check.severity == "error"
