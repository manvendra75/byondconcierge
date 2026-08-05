"""engine.validate — validation hooks for hard-coded assumptions.

Several places in the engine hard-code values that mirror the source data: the
month window, the 22 canonical destinations, the 13 line slugs, the expected
JSON field names, the model price table. These are correct today, but if the
website data is refreshed they can silently drift out of sync — a stale month
window would drop real sailings, an unknown destination would break search.

This module is the safety net. ``validate_assumptions()`` re-checks every such
assumption against the *live committed data* and reports mismatches. It is run
three ways:

* as a CLI       — ``python -m engine.validate`` (prints a report, exits non-zero
  on any error),
* by the ingest  — a summary line at the end of ``python -m engine.ingest.load``,
* by the tests   — ``evals/test_assumptions.py`` fails on any error-level drift.

Each assumption is also catalogued in ``docs/ASSUMPTIONS.md`` with a pointer to
the check that guards it.
"""

from __future__ import annotations

import json
import re
from dataclasses import dataclass

from engine.config import MODEL_ROUTES, PRICE_PER_1K, settings
from engine.guards import currency_scan   # reuse the single production currency pattern (T3.1)
from engine.schemas import SailingFilters
from engine.tools.sailings import _build_where
from engine.ingest.load_knowledge import CRUISE_LINES_JSON, KNOWLEDGE_DIR, _CONTENT_FIELDS
from engine.ingest.load_sailings import (
    _INSERT_COLUMNS,
    _row_from_record,
    SAILINGS_INDEX,
    snapshot_date,
)
from engine.tools.resolve import (
    _DESTINATIONS,
    _LINE_ALIASES,
    _REGION_DESTINATIONS,
    _WINDOW_END,
    _WINDOW_START,
    resolve_date_range,
)

# The fields load_sailings.py reads off every record (if one goes missing the
# loader would KeyError). Kept here as the documented contract for the data shape.
_REQUIRED_SAILING_FIELDS = ("line", "ship", "name", "dest", "destLabel", "nights", "port", "months", "count")

# The fields the line tools (get_line_overview / compare_lines) read off every
# line; a missing one silently degrades an answer to "None".
_LINE_OVERVIEW_FIELDS = ("name", "tagline", "relationship", "ships", "bestFor", "faqs")
_AT_A_GLANCE_FIELDS = ("fleetSize", "homePorts", "gccAccess")
_VALID_RELATIONSHIPS = {"PSA", "Wholesale"}


# ---------------------------------------------------------------------------
# A single check result
# ---------------------------------------------------------------------------
@dataclass
class Check:
    """One assumption's verdict. ``severity`` is 'error' (drift that breaks
    behaviour) or 'warn' (tolerated, cost/quality only). ``ok`` False means the
    assumption no longer holds."""

    name: str
    ok: bool
    severity: str          # 'error' | 'warn'
    detail: str


# ---------------------------------------------------------------------------
# Small loaders (read the committed snapshots once per validation run)
# ---------------------------------------------------------------------------
def _sailings() -> list[dict]:
    return json.loads(SAILINGS_INDEX.read_text(encoding="utf-8"))["records"]


def _cruise_lines() -> list[dict]:
    return json.loads(CRUISE_LINES_JSON.read_text(encoding="utf-8"))


# ---------------------------------------------------------------------------
# The individual checks — each returns one Check
# ---------------------------------------------------------------------------
def _check_month_window(records: list[dict]) -> Check:
    """resolve.py hard-codes the sailable month window. Assert every month that
    actually appears in the data falls inside it — otherwise resolve_month would
    silently reject real, bookable months."""
    months = sorted({m for r in records for m in r.get("months", [])})
    lo = f"{_WINDOW_START[0]:04d}-{_WINDOW_START[1]:02d}"
    hi = f"{_WINDOW_END[0]:04d}-{_WINDOW_END[1]:02d}"
    outside = [m for m in months if not (lo <= m <= hi)]
    if outside:
        return Check("month_window", False, "error",
                     f"data months {outside} fall outside window {lo}..{hi} "
                     f"(update _WINDOW_START/_WINDOW_END in resolve.py)")
    return Check("month_window", True, "error",
                 f"data {months[0]}..{months[-1]} within window {lo}..{hi}")


def _check_destinations(records: list[dict]) -> Check:
    """resolve.py hard-codes 22 canonical destinations. Assert every `dest` value
    in the data is one of them — an unmapped destination can't be searched."""
    canonical = set(_DESTINATIONS)
    data_dests = {r["dest"] for r in records}
    unknown = sorted(data_dests - canonical)
    if unknown:
        return Check("destinations", False, "error",
                     f"data destinations not in _DESTINATIONS: {unknown}")
    return Check("destinations", True, "error",
                 f"all {len(data_dests)} data destinations are canonical")


def _check_region_expansion(_records: list[dict]) -> Check:
    """Umbrella regions (TE) expand to a SET of canonical destinations. Assert every expansion
    target is a real canonical destination and that each umbrella genuinely spans >= 2 — a typo or a
    single-destination entry would silently under-report a region search, which is exactly the bug
    this feature fixes, so it's error-level."""
    canonical = set(_DESTINATIONS)
    problems = []
    for region, dests in _REGION_DESTINATIONS.items():
        bad = [d for d in dests if d not in canonical]
        if bad:
            problems.append(f"'{region}' -> non-canonical {bad}")
        if len(dests) < 2:
            problems.append(f"'{region}' expands to < 2 destinations ({dests})")
    if problems:
        return Check("region_expansion", False, "error", "; ".join(problems))
    return Check("region_expansion", True, "error",
                 f"all {len(_REGION_DESTINATIONS)} umbrella regions expand to canonical destination sets")


def _check_line_slugs(records: list[dict], lines: list[dict]) -> Check:
    """Three lists of line slugs must agree: the sailings data, cruise-lines.json,
    and resolve.py's alias table. Any disagreement means a line the resolvers or
    knowledge base can't handle."""
    in_sailings = {r["line"] for r in records}
    in_content = {l["slug"] for l in lines}
    in_resolver = set(_LINE_ALIASES)
    problems = []
    if in_sailings != in_resolver:
        problems.append(f"sailings vs resolver differ: {in_sailings ^ in_resolver}")
    if in_content != in_resolver:
        problems.append(f"content vs resolver differ: {in_content ^ in_resolver}")
    if problems:
        return Check("line_slugs", False, "error", "; ".join(problems))
    return Check("line_slugs", True, "error", f"all {len(in_resolver)} line slugs agree")


def _check_sailing_fields(records: list[dict]) -> Check:
    """The loader reads a fixed set of fields off each record. Assert they are all
    present (a missing field would KeyError the whole ingest)."""
    missing = sorted({f for r in records for f in _REQUIRED_SAILING_FIELDS if f not in r})
    if missing:
        return Check("sailing_fields", False, "error",
                     f"records missing required fields: {missing}")
    return Check("sailing_fields", True, "error",
                 f"all {len(_REQUIRED_SAILING_FIELDS)} required record fields present")


def _check_nights_numeric(records: list[dict]) -> Check:
    """search_sailings filters nights with ``CAST(nights AS INTEGER)``, which only
    works if every `nights` value starts with a digit ("7 nights", "13–14
    nights"). A value with no leading digit would CAST to 0 and silently break
    nights-range filtering, so assert they all begin numerically."""
    bad = sorted({r["nights"] for r in records if not re.match(r"\s*\d", str(r.get("nights", "")))})
    if bad:
        return Check("nights_numeric", False, "error",
                     f"nights values without a leading number (break CAST filtering): {bad}")
    return Check("nights_numeric", True, "error",
                 "all nights values start with a number (CAST filtering safe)")


# The floor share of sailing records that must carry a ports-of-call route. TA.1 stopped
# the builder discarding routes; TB.2 then de-aggregated the 6 dated lines (one record per
# departure), diluting the share to ~23% — the high-volume routeless dated lines (Costa/
# Carnival/Silversea) each contribute many records with no port run. Only lines with route
# data in the source can ever carry one, so the floor sits well below that share; it exists
# to catch a *regression* (routes silently dropping toward 0%), not to demand universal coverage.
_PORTS_COVERAGE_FLOOR = 0.15


def _check_ports_coverage(records: list[dict]) -> Check:
    """Assert a healthy share of records still carry a ports-of-call route. After TA.1
    the builder keeps the full ordered route on every record that has one; a coverage
    collapse means routes were dropped upstream again and itinerary answers silently
    thinned out. Warn-level: a route is a quality signal search never filters on, so a
    dip degrades answers but doesn't break behaviour."""
    with_ports = sum(1 for r in records if r.get("ports"))
    share = with_ports / len(records) if records else 0.0
    if share < _PORTS_COVERAGE_FLOOR:
        return Check("ports_coverage", False, "warn",
                     f"only {share:.0%} of records carry a ports route "
                     f"(floor {_PORTS_COVERAGE_FLOOR:.0%}) — did the builder drop routes?")
    return Check("ports_coverage", True, "warn",
                 f"{share:.0%} of records carry a ports-of-call route (floor {_PORTS_COVERAGE_FLOOR:.0%})")


# The floor share of sailing records that must carry an arrival/disembark port. TA.2
# derives it per line (an explicit arrival column like MSC's, a one-way route's last
# stop, or a stated round trip returning to the embark port), reaching ~97%. Lines with
# no arrival signal in the source (e.g. Royal Caribbean's region-only rows) legitimately
# lack it, so the floor sits below 100% — it exists to catch a *regression* (an endpoint
# read breaking, or the aggregate carry-through dropping the value), not to demand 100%.
_DISEMBARK_COVERAGE_FLOOR = 0.85


def _check_disembark_coverage(records: list[dict]) -> Check:
    """Assert a healthy share of records carry an arrival/disembark port. A coverage
    collapse means a parser's endpoint read broke or the aggregate stopped carrying
    `portDisembark`. Warn-level: disembark is a display detail search never filters on,
    so a dip degrades answers but doesn't break behaviour."""
    with_dis = sum(1 for r in records if r.get("portDisembark"))
    share = with_dis / len(records) if records else 0.0
    if share < _DISEMBARK_COVERAGE_FLOOR:
        return Check("disembark_coverage", False, "warn",
                     f"only {share:.0%} of records carry a disembark port "
                     f"(floor {_DISEMBARK_COVERAGE_FLOOR:.0%}) — did an endpoint read break?")
    return Check("disembark_coverage", True, "warn",
                 f"{share:.0%} of records carry a disembark port (floor {_DISEMBARK_COVERAGE_FLOOR:.0%})")


# Lines that publish a day-by-day schedule today. Crystal (dated) and Elixir (undated) come from
# the source markdown (TC.2); Carnival, Silversea and Disney come from the acquired snapshots
# merged by the builder in TC.6 (Carnival/Silversea enriched onto base departures, Disney records
# replaced outright). Kept here as the documented expectation so a refresh that silently drops
# day-by-day for one of them is caught. Mirror the builder's `DAYBYDAY_LINES`; this set grows as
# the acquisition track lands day-by-day for more lines.
_DAY_BY_DAY_LINES = {"crystal", "elixir", "carnival", "silversea", "disney", "costa", "royal-caribbean"}


def _check_day_by_day_coverage(records: list[dict]) -> Check:
    """Assert the lines expected to publish a day-by-day schedule still do, and report the full set
    that carries one. A missing expected line means the builder dropped `itineraryDays` (TC.2) or a
    publish shipped a stale snapshot — the engine would then silently fall back to "day-by-day on
    request" for it. Warn-level: day-by-day is a display enrichment search never filters on, so a
    gap degrades answers without breaking behaviour. A line carrying day-by-day that ISN'T expected
    is not an error — it just means new data landed (TC.5/TC.6) and ``_DAY_BY_DAY_LINES`` should be
    updated; we note it rather than fail."""
    have = {r["line"] for r in records if r.get("itineraryDays")}
    missing = sorted(_DAY_BY_DAY_LINES - have)
    if missing:
        return Check("day_by_day_coverage", False, "warn",
                     f"expected day-by-day lines with none in the snapshot: {missing} "
                     "(builder dropped itineraryDays, or a stale publish?)")
    extra = sorted(have - _DAY_BY_DAY_LINES)
    detail = f"day-by-day present for {sorted(have)}"
    if extra:
        detail += f" — NEW lines gained it: {extra} (update _DAY_BY_DAY_LINES)"
    return Check("day_by_day_coverage", True, "warn", detail)


def _check_day_by_day_parses(records: list[dict]) -> Check:
    """Every committed ``itineraryDays`` entry must deserialize into the engine's ``ItineraryDay``
    model — the SAME way the reader (``itinerary.py`` ``_day_by_day``) does. This guards the data→model
    contract that the other day-by-day checks miss: ``day_by_day_coverage`` only checks presence, the
    build-time guard validates the JSON against hard-coded JS keys, and ``itinerary_days_render``
    round-trips SYNTHETIC model instances. If the builder's day keys and the ``ItineraryDay`` fields
    ever drift apart (a rename on one side only), ``_day_by_day`` swallows the resulting pydantic
    error and the schedule silently vanishes to "on request" — no failure anywhere. Assert the REAL
    committed data parses, and that the parsed model actually captured each source value (so a
    silently-ignored/renamed key is caught too, not just a hard validation error). Error-level: a
    silent drift would make the whole day-by-day feature disappear for the affected line."""
    from engine.schemas import ItineraryDay

    checked = 0
    for r in records:
        for entry in r.get("itineraryDays") or []:
            # (1) The entry must satisfy the model the reader constructs (pydantic ValidationError is a
            # ValueError, so this catches a missing required field / wrong type).
            try:
                day = ItineraryDay(**entry)
            except (TypeError, ValueError) as e:
                return Check("day_by_day_parses", False, "error",
                             f"{r.get('line')} \"{r.get('name')}\" has a day that fails ItineraryDay: {entry} ({e})")
            # (2) The model must have CAPTURED each source key, not silently ignored a renamed/extra one —
            # else is_sea_day / date would drift to a default without ever raising.
            for key in ("day", "port", "is_sea_day", "date"):
                if key in entry and getattr(day, key, None) != entry[key]:
                    return Check("day_by_day_parses", False, "error",
                                 f"{r.get('line')} day key '{key}' not preserved by ItineraryDay "
                                 f"({entry.get(key)!r} -> {getattr(day, key, None)!r}) — builder/model drift")
            checked += 1
    return Check("day_by_day_parses", True, "error",
                 f"all {checked} committed day-by-day entries parse into ItineraryDay")


# The keys get_line_overview's sibling get_itinerary (TA.7) reads off each curated
# featured itinerary exported by TA.3. A missing key silently degrades a rendered route
# (a stop list with no ship, etc.), so surface it — warn-level, since the tool still
# renders whatever keys ARE present.
_FEATURED_ITINERARY_FIELDS = ("region", "name", "ship", "nights", "departs", "ports")


def _check_featured_itinerary_fields(lines: list[dict]) -> Check:
    """Assert every featured itinerary carries the keys the itinerary tool reads. Lines
    that publish no featuredItineraries are simply skipped (the field is optional)."""
    problems: dict[str, list[str]] = {}
    for line in lines:
        for fi in line.get("featuredItineraries") or []:
            absent = [f for f in _FEATURED_ITINERARY_FIELDS if f not in fi]
            if absent:
                problems.setdefault(line["slug"], [])
                for f in absent:
                    if f not in problems[line["slug"]]:
                        problems[line["slug"]].append(f)
    if problems:
        return Check("featured_itinerary_fields", False, "warn",
                     f"featured itineraries missing keys: {problems}")
    total = sum(len(line.get("featuredItineraries") or []) for line in lines)
    return Check("featured_itinerary_fields", True, "warn",
                 f"all {total} featured itineraries carry the {len(_FEATURED_ITINERARY_FIELDS)} expected keys")


# The free-text sailing fields the agent's renderer emits per row (TA.6). These reach
# the model as reference data, so the no-price rule must hold on them too — not just on
# the route/disembark added in TA.1/TA.2.
_RENDERED_SAILING_FIELDS = ("name", "ship", "port", "seasonHint")


def _check_no_currency_in_itinerary(records: list[dict], lines: list[dict]) -> Check:
    """The no-price rule is absolute — no fare or currency may reach the engine. Scan
    every itinerary text the engine surfaces to the model: the fields the sailings
    renderer emits per row — name, ship, embark port, season hint (TA.6) plus the ports
    of call and disembark port (TA.1/TA.2) — the day-by-day schedule (TC.3), and the
    curated featured itineraries (TA.3). Reuses the one production currency pattern
    (guards.currency_scan). Error-level: a leaked price would break the hardest product constraint."""
    hits: list[str] = []
    for r in records:
        for field in _RENDERED_SAILING_FIELDS:           # rendered free-text fields
            value = r.get(field)
            if value and currency_scan(str(value)):
                hits.append(f"{field}:{value!r}")
        for port in r.get("ports") or []:                # route (ports of call)
            if currency_scan(port):
                hits.append(f"ports:{port!r}")
        disembark = r.get("portDisembark")               # arrival port
        if disembark and currency_scan(disembark):
            hits.append(f"portDisembark:{disembark!r}")
        for day in r.get("itineraryDays") or []:         # day-by-day schedule port labels (TC.3)
            port = day.get("port")
            if port and currency_scan(str(port)):
                hits.append(f"itineraryDays:{port!r}")
    for line in lines:                                   # curated featured itineraries
        for fi in line.get("featuredItineraries") or []:
            blob = " ".join(str(fi.get(f, "")) for f in ("name", "ship", "nights", "departs"))
            blob += " " + " ".join(fi.get("ports") or [])
            if currency_scan(blob):
                hits.append(f"{line['slug']} featured:{fi.get('name')!r}")
    if hits:
        return Check("no_currency_in_itinerary", False, "error",
                     f"currency found in itinerary data (violates no-price rule): {hits[:5]}")
    return Check("no_currency_in_itinerary", True, "error",
                 "no currency in rendered sailing fields, routes, day-by-day, or featured itineraries")


def _check_sailings_load_columns(records: list[dict]) -> Check:
    """The loader builds each row as a positional tuple (`_row_from_record`) that must line
    up with the sailings INSERT column list (`_INSERT_COLUMNS`). If the two drift — a column
    added to one but not the other, or reordered — data lands in the wrong column *silently*
    (no error, just corrupted rows). Assert the tuple length matches the column count and
    that the two itinerary columns (TA.4) carry the right source values on every record.
    Error-level: silent column corruption is a correctness bug, not a cosmetic one."""
    ncols = len(_INSERT_COLUMNS)
    i_ports = _INSERT_COLUMNS.index("ports_json")
    i_disembark = _INSERT_COLUMNS.index("port_disembark")
    i_sail_date = _INSERT_COLUMNS.index("sail_date")
    i_days = _INSERT_COLUMNS.index("itinerary_days_json")
    for rec in records:
        row = _row_from_record(rec)
        if len(row) != ncols:
            return Check("sailings_load_columns", False, "error",
                         f"_row_from_record returns {len(row)} values but the INSERT lists "
                         f"{ncols} columns — a column add/reorder drifted")
        if row[i_ports] != json.dumps(rec.get("ports", [])):
            return Check("sailings_load_columns", False, "error",
                         "ports_json position is not aligned with the source `ports` field")
        if row[i_disembark] != rec.get("portDisembark"):
            return Check("sailings_load_columns", False, "error",
                         "port_disembark position is not aligned with the source `portDisembark` field")
        if row[i_sail_date] != rec.get("date"):
            return Check("sailings_load_columns", False, "error",
                         "sail_date position is not aligned with the source `date` field")
        if row[i_days] != json.dumps(rec.get("itineraryDays", [])):
            return Check("sailings_load_columns", False, "error",
                         "itinerary_days_json position is not aligned with the source `itineraryDays` field")
    return Check("sailings_load_columns", True, "error",
                 f"loader tuple aligns with all {ncols} INSERT columns")


def _check_sail_dates(records: list[dict]) -> Check:
    """The de-aggregated dated records (TB.2/TB.3) carry an exact `date`. Assert the committed
    index's dates are sound, so the date filtering/ranking in TB.4 can trust them:
      * every `date` is a STRICT 10-char zero-padded `YYYY-MM-DD` that is also a real calendar
        date — TB.4's past-date filter (`sail_date >= today`) and `ORDER BY sail_date` compare
        the value as a STRING, so the format must sort lexicographically the same as it does
        chronologically. A lenient form like '20260808' (which datetime.fromisoformat actually
        accepts) would sort wrong and silently break date search, so we regex-check strictly
        BEFORE the calendar-validity check;
      * a dated record is a single departure (`count == 1` — de-aggregation didn't collapse it);
      * dates are all-or-nothing per line (a line's records are either all dated or all
        catalogue — never a partial de-aggregation from a stale/hand-edited snapshot).
    Error-level: a malformed or half-loaded date would corrupt date search. Note we do NOT
    bound dates to the month-picker window — genuine 2028+ departures exist (they keep their
    exact date but clip `months` to [])."""
    from datetime import date as _date

    has_date_by_line: dict[str, set[bool]] = {}
    for rec in records:
        date = rec.get("date")
        has_date_by_line.setdefault(rec.get("line"), set()).add(date is not None)
        if date is None:
            continue
        # Strict dashed 10-char format first — this is what makes string comparison sort-correct
        # for TB.4 (fromisoformat alone would wave through '20260808').
        if not (isinstance(date, str) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", date)):
            return Check("sail_dates", False, "error",
                         f"sail date {date!r} is not strict YYYY-MM-DD ({rec.get('line')}) — "
                         "TB.4 sorts/filters dates as strings, so the format must be exact")
        try:
            _date.fromisoformat(date)                 # ...and a real calendar date (rejects 2026-02-31)
        except (ValueError, TypeError):
            return Check("sail_dates", False, "error", f"invalid sail date {date!r} ({rec.get('line')})")
        if rec.get("count") != 1:
            return Check("sail_dates", False, "error",
                         f"dated record has count {rec.get('count')} (expected 1): {rec.get('line')} {date}")
    mixed = sorted(l for l, flags in has_date_by_line.items() if len(flags) > 1)
    if mixed:
        return Check("sail_dates", False, "error",
                     f"lines mixing dated + catalogue records (partial de-aggregation): {mixed}")
    n_dated = sum(1 for r in records if r.get("date"))
    return Check("sail_dates", True, "error",
                 f"{n_dated} dated records have valid, consistent sail dates")


# How many days before the committed sailings snapshot is considered stale. Cruise dated
# departures rot (sell out / sail away), so ~a month is a sensible refresh cadence.
_STALE_SNAPSHOT_DAYS = 30


def _check_stale_snapshot(today: str | None = None) -> Check:
    """Warn when the committed sailings snapshot's ``generated`` date is older than
    ``_STALE_SNAPSHOT_DAYS`` (TB.6). Dated departures rot, so a stale snapshot should prompt a
    data refresh. This is the ONE time-relative check, so it reads the clock — or an injected
    ``today`` ("YYYY-MM-DD") for deterministic tests. Warn-level: stale data still works, just
    ages."""
    from datetime import date

    generated = snapshot_date()
    if not generated:
        return Check("stale_snapshot", False, "warn", "sailings index has no `generated` date")
    try:
        gen = date.fromisoformat(generated)
    except (ValueError, TypeError):
        return Check("stale_snapshot", False, "warn", f"unparseable `generated` date {generated!r}")
    ref = date.fromisoformat(today) if today else date.today()
    age = (ref - gen).days
    if age > _STALE_SNAPSHOT_DAYS:
        return Check("stale_snapshot", False, "warn",
                     f"sailings snapshot is {age} days old (generated {generated}) — "
                     f"refresh recommended (> {_STALE_SNAPSHOT_DAYS}d)")
    return Check("stale_snapshot", True, "warn",
                 f"sailings snapshot is {age} days old (generated {generated})")


def _check_content_fields(lines: list[dict]) -> Check:
    """load_knowledge chunks a fixed set of prose fields per line. Assert each line
    carries them (warn-level: a genuinely absent field is just skipped, but it's
    worth surfacing in case a rename dropped content silently)."""
    missing = {}
    for line in lines:
        absent = [f for f in _CONTENT_FIELDS if f not in line]
        if absent:
            missing[line["slug"]] = absent
    if missing:
        return Check("content_fields", False, "warn",
                     f"cruise-lines.json entries missing prose fields: {missing}")
    return Check("content_fields", True, "warn",
                 f"all lines carry the {len(_CONTENT_FIELDS)} content fields")


def _check_line_overview_fields(lines: list[dict]) -> Check:
    """The line tools read a fixed set of fields off each line, including the
    atAGlance sub-keys (fleetSize/homePorts/gccAccess). Assert each line has them
    non-empty — a missing one silently renders as 'None' in a line overview or
    comparison table."""
    problems: dict[str, list[str]] = {}
    for line in lines:
        missing = [f for f in _LINE_OVERVIEW_FIELDS if not line.get(f)]
        missing += [f"atAGlance.{k}" for k in _AT_A_GLANCE_FIELDS
                    if not line.get("atAGlance", {}).get(k)]
        if missing:
            problems[line["slug"]] = missing
    if problems:
        return Check("line_overview_fields", False, "error",
                     f"lines missing overview fields: {problems}")
    return Check("line_overview_fields", True, "error",
                 f"all lines carry the {len(_LINE_OVERVIEW_FIELDS) + len(_AT_A_GLANCE_FIELDS)} overview fields")


def _check_relationship_values(lines: list[dict]) -> Check:
    """Every line's `relationship` should be one of the known values the UI/tools
    expect (PSA | Wholesale). An unexpected value still displays, so warn-level."""
    unexpected = sorted({l["relationship"] for l in lines
                         if l.get("relationship") not in _VALID_RELATIONSHIPS})
    if unexpected:
        return Check("relationship_values", False, "warn",
                     f"unexpected relationship values (expected {sorted(_VALID_RELATIONSHIPS)}): {unexpected}")
    return Check("relationship_values", True, "warn",
                 "all relationship values are PSA/Wholesale")


def _check_brief_files(lines: list[dict]) -> Check:
    """The RAG store expects one <slug>.md brief per line plus gcc-cruise-facts.md.
    Assert they all exist on disk — a missing brief silently shrinks the knowledge
    base."""
    expected = [f"{l['slug']}.md" for l in lines] + ["gcc-cruise-facts.md"]
    missing = [f for f in expected if not (KNOWLEDGE_DIR / f).exists()]
    if missing:
        return Check("brief_files", False, "error",
                     f"missing briefs in data/knowledge/: {missing}")
    return Check("brief_files", True, "error", f"all {len(expected)} briefs present")


def _check_gate_intents() -> Check:
    """The scope-gate prompt must teach exactly the intents IntentResult allows.
    If the schema gains/renames an intent but the prompt (or vice-versa) doesn't
    follow, the gate mis-routes turns (a missed 'price_intent' skips the lead
    flow). Assert every allowed intent literal appears in the gate prompt."""
    from typing import get_args

    from engine.guards import _GATE_SYSTEM
    from engine.schemas import IntentResult

    intents = get_args(IntentResult.model_fields["intent"].annotation)
    missing = [i for i in intents if i not in _GATE_SYSTEM]
    if missing:
        return Check("gate_intents", False, "error",
                     f"IntentResult intents not described in the scope-gate prompt: {missing}")
    return Check("gate_intents", True, "error",
                 f"all {len(intents)} intents are described in the gate prompt")


def _check_orchestrator_intents() -> Check:
    """The orchestrator must produce a reply for every intent. in_scope runs the
    agent; every OTHER intent is answered by _canned(). If an intent is added to
    IntentResult but not handled in _canned, the orchestrator's else-branch would
    send an empty reply. Assert each non-in_scope intent yields a non-empty canned
    reply."""
    from typing import get_args

    from engine.orchestrator import _canned
    from engine.schemas import IntentResult, UserProfile

    probe = UserProfile(agency="Probe Co", full_name="Probe User",
                        email="probe@example.com", phone="+10000000000")
    intents = get_args(IntentResult.model_fields["intent"].annotation)
    unhandled = [i for i in intents if i != "in_scope" and not _canned(i, probe)]
    if unhandled:
        return Check("orchestrator_intents", False, "error",
                     f"intents with no canned reply (would send empty text): {unhandled}")
    return Check("orchestrator_intents", True, "error",
                 f"all {len(intents) - 1} non-in_scope intents have a canned reply")


def _check_routed_models() -> Check:
    """call_structured's small->large escalation assumes every routed model is
    either model_small or model_large. A third model would silently get no
    escalation path. Warn-level: calls still work, just without escalation."""
    valid = {settings.model_small, settings.model_large}
    unexpected = sorted({r["model"] for r in MODEL_ROUTES.values()} - valid)
    if unexpected:
        return Check("routed_models", False, "warn",
                     f"routed models outside small/large (no escalation): {unexpected}")
    return Check("routed_models", True, "warn",
                 "all routed models are model_small or model_large")


def _check_transient_errors() -> Check:
    """The model wrapper backs off on the OpenAI exceptions named in _TRANSIENT.
    If the SDK renames one, backoff/escalation silently stops for it. Assert each
    name still exists on the openai module. Warn-level: calls still succeed, just
    without graceful transient handling."""
    import openai

    from engine.model import _TRANSIENT

    missing = sorted(n for n in _TRANSIENT if not hasattr(openai, n))
    if missing:
        return Check("transient_errors", False, "warn",
                     f"_TRANSIENT names not found in the openai SDK (backoff won't trigger): {missing}")
    return Check("transient_errors", True, "warn",
                 f"all {len(_TRANSIENT)} transient error names exist in the openai SDK")


def _check_date_range_resolver() -> Check:
    """resolve_date_range (TB.5) feeds date_from/date_to into search_sailings, which APPLIES a
    bound only when it matches the strict ``YYYY-MM-DD`` the SQL string-comparison needs — else
    ``_build_where`` silently drops the filter and returns UNFILTERED results. Assert the resolver
    keeps that contract for representative phrases: each resolvable one yields two strict,
    in-window, correctly-ordered (from <= to) dates; an unresolvable one yields (None, None).
    Error-level: a format drift here would silently ignore the user's timeframe."""
    lo = f"{_WINDOW_START[0]:04d}-{_WINDOW_START[1]:02d}"
    hi = f"{_WINDOW_END[0]:04d}-{_WINDOW_END[1]:02d}"
    for phrase in ("first half of August", "second half of August", "first week of September",
                   "last week of December", "early October", "mid October", "late February",
                   "August 2027"):
        df, dt = resolve_date_range(phrase)
        if not (df and dt and re.fullmatch(r"\d{4}-\d{2}-\d{2}", df) and re.fullmatch(r"\d{4}-\d{2}-\d{2}", dt)):
            return Check("date_range_resolver", False, "error",
                         f"'{phrase}' -> ({df}, {dt}) is not a strict YYYY-MM-DD range (search would drop it)")
        if df > dt:
            return Check("date_range_resolver", False, "error",
                         f"'{phrase}' -> from {df} is after to {dt}")
        if not (lo <= df[:7] <= hi and lo <= dt[:7] <= hi):
            return Check("date_range_resolver", False, "error",
                         f"'{phrase}' -> ({df}, {dt}) falls outside the window {lo}..{hi}")
    if resolve_date_range("no month here") != (None, None):
        return Check("date_range_resolver", False, "error",
                     "an unresolvable phrase must return (None, None), not a range")
    return Check("date_range_resolver", True, "error",
                 "date-range resolver emits strict, in-window, ordered ranges")


# One valid probe value per SailingFilters field, so each can be exercised in isolation. A field
# added to the schema (and populated by the search tool) but NOT turned into a WHERE clause would
# be silently ignored — the bug the `name` filter fix nearly hit. Keep this in step with the schema.
_FILTER_PROBES = {
    "dest": "Mediterranean", "dests": ["Mediterranean", "Greek Isles & Aegean"],
    "dest_label": "Western", "port": "Rome", "line": "costa",
    "month": "2026-09", "nights_min": 7, "nights_max": 14, "ship": "Costa",
    "date_from": "2026-09-01", "date_to": "2026-09-30", "name": "Idyllic Rhône",
}


def _check_search_filters_applied() -> Check:
    """Every ``SailingFilters`` field must be HONORED by ``_build_where`` — a field present in the
    schema but not turned into a SQL clause is silently ignored (wrong results, no error). Assert
    (a) every schema field has a probe here (so a newly added filter isn't forgotten) and (b) each
    probe, set alone, produces at least one WHERE clause. Error-level: a dropped filter is a
    correctness bug."""
    untested = sorted(set(SailingFilters.model_fields) - set(_FILTER_PROBES))
    if untested:
        return Check("search_filters_applied", False, "error",
                     f"SailingFilters fields with no probe (add them here + to _build_where): {untested}")
    for field, value in _FILTER_PROBES.items():
        clauses, _params = _build_where(SailingFilters(**{field: value}))
        if not clauses:
            return Check("search_filters_applied", False, "error",
                         f"SailingFilters.{field} produced no WHERE clause — it is silently ignored by search")
    return Check("search_filters_applied", True, "error",
                 f"all {len(_FILTER_PROBES)} SailingFilters fields are honored by search")


def _check_itinerary_days_render() -> Check:
    """TC.1 wired a numbered day-by-day schedule end to end — the ``itinerary_days_json`` column the
    itinerary reader queries, the typed ``ItineraryDay`` model, and the agent renderer that prints
    "Day 1..N". Guard both couplings that can silently break it:

      * the column stays declared in BOTH the CREATE schema and the migration map — else
        ``_day_by_day``'s SELECT would throw on a fresh (or an upgraded) DB;
      * the renderer round-trips the model: a published list prints one "Day N" line per day
        (honouring the exact date and the sea-day label), and an EMPTY list falls back to
        "day-by-day schedule on request" — never a fabricated day.

    DB-free and deterministic (like the other code-consistency checks). Error-level: a break here
    silently drops the schedule the whole feature exists to surface, or — worse — invents days.
    """
    from engine.agent import _render_itinerary
    from engine.db import _ADDED_COLUMNS, _SCHEMA
    from engine.schemas import FeaturedItinerary, ItineraryDay, ItineraryResult

    # (1) The column the reader depends on must be declared in the schema AND the migration map,
    # so a fresh DB and one upgraded from an older build both carry it.
    added = dict(_ADDED_COLUMNS.get("sailings", []))
    if "itinerary_days_json" not in _SCHEMA or "itinerary_days_json" not in added:
        return Check("itinerary_days_render", False, "error",
                     "itinerary_days_json column missing from the sailings schema or migration map "
                     "(TC.1) — the day-by-day reader's SELECT would fail")

    # (2) A published schedule renders one numbered line per day, with the date + sea-day label.
    days = [
        ItineraryDay(day=1, date="2026-08-08", port="Istanbul", is_sea_day=False),
        ItineraryDay(day=2, date="2026-08-09", port="At sea", is_sea_day=True),
        ItineraryDay(day=3, date="2026-08-10", port="Marmaris", is_sea_day=False),
    ]
    rendered = _render_itinerary(ItineraryResult(line="probe", itinerary_days=days))
    for d in days:
        label = "At sea" if d.is_sea_day else d.port
        if f"Day {d.day} ({d.date}): {label}" not in rendered:
            return Check("itinerary_days_render", False, "error",
                         f"renderer dropped day {d.day} — ItineraryDay/_render_itinerary drifted")

    # (3) With SOME itinerary content but no day list, the renderer must offer it on request —
    # never fabricate a day. A featured itinerary stands in for "some content".
    empty = _render_itinerary(ItineraryResult(
        line="probe",
        featured=[FeaturedItinerary(region="Med", name="Sample", ship="Ship",
                                    nights="7 nights", departs="Rome", ports=["Rome"])],
    ))
    if "Day-by-day schedule on request." not in empty or "Day 1" in empty:
        return Check("itinerary_days_render", False, "error",
                     "an absent day list did not fall back to 'on request' (or invented a day)")

    return Check("itinerary_days_render", True, "error",
                 "day-by-day column, model and renderer are in step (Day 1..N ↔ on request)")


def _check_model_pricing() -> Check:
    """Every model routed in MODEL_ROUTES should have a PRICE_PER_1K entry, else its
    traced cost silently reads $0. Warn-level: costs are informational only."""
    routed = {route["model"] for route in MODEL_ROUTES.values()}
    unpriced = sorted(routed - set(PRICE_PER_1K))
    if unpriced:
        return Check("model_pricing", False, "warn",
                     f"routed models with no price (cost logs as $0): {unpriced}")
    return Check("model_pricing", True, "warn",
                 f"all {len(routed)} routed models are priced")


# ---------------------------------------------------------------------------
# Run all checks
# ---------------------------------------------------------------------------
def validate_assumptions() -> list[Check]:
    """Run every assumption check and return the list of results. Reads the
    committed data snapshots; no DB, no network, no LLM."""
    records = _sailings()
    lines = _cruise_lines()
    return [
        _check_month_window(records),
        _check_destinations(records),
        _check_region_expansion(records),
        _check_line_slugs(records, lines),
        _check_sailing_fields(records),
        _check_nights_numeric(records),
        _check_ports_coverage(records),
        _check_disembark_coverage(records),
        _check_day_by_day_coverage(records),
        _check_day_by_day_parses(records),
        _check_featured_itinerary_fields(lines),
        _check_no_currency_in_itinerary(records, lines),
        _check_sailings_load_columns(records),
        _check_sail_dates(records),
        _check_stale_snapshot(),
        _check_content_fields(lines),
        _check_line_overview_fields(lines),
        _check_relationship_values(lines),
        _check_brief_files(lines),
        _check_model_pricing(),
        _check_gate_intents(),
        _check_orchestrator_intents(),
        _check_routed_models(),
        _check_transient_errors(),
        _check_date_range_resolver(),
        _check_search_filters_applied(),
        _check_itinerary_days_render(),
    ]


def summarize(checks: list[Check]) -> tuple[int, int, int]:
    """Return (passed, warnings, errors) counts from a checks list."""
    passed = sum(1 for c in checks if c.ok)
    warnings = sum(1 for c in checks if not c.ok and c.severity == "warn")
    errors = sum(1 for c in checks if not c.ok and c.severity == "error")
    return passed, warnings, errors


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------
def main() -> None:
    import sys

    checks = validate_assumptions()
    for c in checks:
        tag = "OK  " if c.ok else ("FAIL" if c.severity == "error" else "WARN")
        print(f"  [{tag}] {c.name:<16} {c.detail}")

    passed, warnings, errors = summarize(checks)
    print(f"\n  {passed} ok · {warnings} warnings · {errors} errors")
    # Non-zero exit on any error so this can gate CI / a pre-refresh check.
    sys.exit(1 if errors else 0)


if __name__ == "__main__":
    main()
