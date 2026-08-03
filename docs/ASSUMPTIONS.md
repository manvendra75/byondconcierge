# Assumptions & hard-coded values

This engine hard-codes some values that **mirror the source data or the model
provider**. They are correct today, but a data refresh (new sailing season, a
line added/removed, a renamed field) or a provider change can make them stale.

Every data-coupled assumption below is guarded by a check in
[`engine/validate.py`](../engine/validate.py). Run the guard any time:

```bash
python -m engine.validate          # standalone report (exits non-zero on error)
pytest evals/test_assumptions.py   # the same checks as tests
```

It also runs automatically at the end of `python -m engine.ingest.load`, and in
the eval suite — so drift surfaces at rebuild time, not in production.

**Severity:** `error` = drift that breaks behaviour (search drops data, ingest
crashes). `warn` = tolerated (cost/quality only).

---

## Guarded assumptions (checked against live data)

| # | Assumption | Where it's hard-coded | Depends on | Guard check | Severity |
|---|---|---|---|---|---|
| 1 | Sailable months are **Jul 2026 – Dec 2027** | `resolve.py` `_WINDOW_START` / `_WINDOW_END` | `months[]` in `sailings-index.json` | `month_window` | error |
| 2 | **22 canonical destinations** | `resolve.py` `_DESTINATIONS` | `dest` values in `sailings-index.json` (and website `searchTypes.ts`) | `destinations` | error |
| 2a | **Umbrella regions expand to a SET of canonical destinations** (TE) — "Europe" → the 5 European buckets; each umbrella spans ≥2 real destinations, so a broad search never collapses to one sub-region | `resolve.py` `_REGION_DESTINATIONS` + `resolve_region`; `search_sailings` `dest IN (…)` | `_REGION_DESTINATIONS` values vs `_DESTINATIONS` | `region_expansion` | error |
| 3 | **13 line slugs** agree across data, content, resolver | `resolve.py` `_LINE_ALIASES` | `line` in sailings + `slug` in `cruise-lines.json` | `line_slugs` | error |
| 4 | Each sailing record carries **9 required fields** | `load_sailings.py` (`_row_from_record`), listed in `validate.py` `_REQUIRED_SAILING_FIELDS` | `sailings-index.json` record shape | `sailing_fields` | error |
| 4b | Every `nights` value **starts with a number** (so `CAST(nights AS INTEGER)` works) | `sailings.py` `_build_where` (nights range) | `nights` text in `sailings-index.json` | `nights_numeric` | error |
| 4c | A **floor share of records carry a ports-of-call route** (the builder keeps routes, doesn't drop them) | `build-sailings-index.mjs` route emit (TA.1); floor `_PORTS_COVERAGE_FLOOR` in `validate.py` | `ports[]` in `sailings-index.json` | `ports_coverage` | warn |
| 4d | A **floor share of records carry an arrival/disembark port** (per-line endpoint reads still work) | `build-sailings-index.mjs` per-parser `portTo` + aggregate emit (TA.2); floor `_DISEMBARK_COVERAGE_FLOOR` in `validate.py` | `portDisembark` in `sailings-index.json` | `disembark_coverage` | warn |
| 4e | Each **featured itinerary carries the 6 keys** the itinerary tool reads (region, name, ship, nights, departs, ports) | `export-cruise-content.mjs` (TA.3); `_FEATURED_ITINERARY_FIELDS` in `validate.py` | `featuredItineraries[]` in `cruise-lines.json` | `featured_itinerary_fields` | warn |
| 4f | **No currency in any rendered itinerary text** (sailing name/ship/port/season + routes, disembark ports, day-by-day port labels, featured itineraries) — the no-price rule | `build-sailings-index.mjs` (never reads prices), `export-cruise-content.mjs` (TA.3), agent renderer (TA.6/TC.1); scan reuses `guards.currency_scan` | rendered sailing fields + `ports`/`portDisembark`/`itineraryDays[].port` in `sailings-index.json`, `featuredItineraries[]` in `cruise-lines.json` | `no_currency_in_itinerary` | error |
| 4g | **Committed sail dates are sound** — every `date` is a strict 10-char `YYYY-MM-DD` (so TB.4's string-based filter/sort is chronologically correct) and a real calendar date, dated records are `count:1`, and dates are all-or-nothing per line (this subsumes the planned `sail_date_format` check) | `load_sailings.py` maps `date`→`sail_date` (TB.3); de-aggregation (TB.2); string date compare in `sailings.py` search (TB.4) | `date` in `sailings-index.json` | `sail_dates` | error |
| 4h | The committed **sailings snapshot isn't stale** — its `generated` date is within `_STALE_SNAPSHOT_DAYS`; dated departures rot, so aging data should prompt a rebuild (time-relative check) | `validate.py` `_STALE_SNAPSHOT_DAYS`; `generated` in `sailings-index.json` | `generated` date vs today | `stale_snapshot` | warn |
| 4i | The **lines expected to publish a day-by-day schedule still do** (Crystal + Elixir from source markdown; Carnival, Silversea, Disney from the acquired merge — TC.6) — a missing one means the builder dropped `itineraryDays`, the acquired merge stopped matching, or a stale publish; a new line gaining it is noted, not failed | `build-sailings-index.mjs` `parseCrystal`/`parseElixir` (TC.2) + `enrichWithAcquired`/`buildDisneyReplacement` (TC.6), `load_sailings.py` maps `itineraryDays`→`itinerary_days_json` (TC.3); `DAYBYDAY_LINES` (builder) ↔ `_DAY_BY_DAY_LINES` (`validate.py`) | `itineraryDays[]` in `sailings-index.json` | `day_by_day_coverage` | warn |
| 5 | Each line carries the **5 prose fields** (intro, description, highlights, faqs, atAGlance) | `load_knowledge.py` `_CONTENT_FIELDS` | `cruise-lines.json` shape | `content_fields` | warn |
| 5b | Each line has non-empty **overview fields** (name, tagline, relationship, ships, bestFor, faqs + atAGlance.fleetSize/homePorts/gccAccess) | `lines.py` (`get_line_overview`, `compare_lines`) | `cruise-lines.json` shape | `line_overview_fields` | error |
| 5c | Each line's **relationship** is `PSA` or `Wholesale` | `lines.py`, tests, UI | `cruise-lines.json` values | `relationship_values` | warn |
| 6 | **14 briefs** exist (one `<slug>.md` per line + `gcc-cruise-facts.md`) | `load_knowledge.py` (`_brief_chunks`) | files in `data/knowledge/` | `brief_files` | error |
| 7 | Every **routed model is priced** | `config.py` `MODEL_ROUTES` vs `PRICE_PER_1K` | provider pricing | `model_pricing` | warn |

## Guarded assumptions (code & config consistency)

These aren't data drift — they're internal contracts between two pieces of code
(or the code and the OpenAI SDK) that must stay in step. Same guard, same runner.

| # | Assumption | Where | Guard check | Severity |
|---|---|---|---|---|
| 8 | The scope-gate prompt **teaches every intent** `IntentResult` allows | `guards.py` `_GATE_SYSTEM` vs `schemas.py` `IntentResult` | `gate_intents` | error |
| 8b | The orchestrator has a **reply for every non-`in_scope` intent** (`_canned` covers them) | `orchestrator.py` `_canned` vs `schemas.py` `IntentResult` | `orchestrator_intents` | error |
| 8c | The **sailings loader tuple lines up with the INSERT columns** (no silent column-order drift; value-checks `ports_json`/`port_disembark`/`sail_date`/`itinerary_days_json`) | `load_sailings.py` `_row_from_record` vs `_INSERT_COLUMNS` | `sailings_load_columns` | error |
| 9 | Every **routed model is `model_small` or `model_large`** (so small→large escalation applies) | `config.py` `MODEL_ROUTES` vs `settings` | `routed_models` | warn |
| 10 | The **transient error names exist in the OpenAI SDK** (so backoff triggers) | `model.py` `_TRANSIENT` vs `openai` | `transient_errors` | warn |
| 11 | The **date-range resolver emits what search accepts** — strict, in-window, ordered `YYYY-MM-DD` (else `_build_where` silently drops the filter and returns unfiltered results) | `resolve.py` `resolve_date_range` vs `sailings.py` `_build_where` format check (TB.5) | `date_range_resolver` | error |
| 12 | **Every `SailingFilters` field is honored by search** — a field in the schema but not turned into a WHERE clause is silently ignored (wrong results, no error) | `schemas.py` `SailingFilters` vs `sailings.py` `_build_where` | `search_filters_applied` | error |
| 13 | **The day-by-day model, column and renderer stay in step** — the `itinerary_days_json` column the reader queries is declared in both the schema and the migration map, and the renderer prints one `Day N` line per published day (else falls back to "on request", never a fabricated day) | `db.py` `_SCHEMA`/`_ADDED_COLUMNS` + `schemas.py` `ItineraryDay` vs `agent.py` `_render_itinerary` (TC.1) | `itinerary_days_render` | error |
| 14 | **The committed day-by-day data deserializes into `ItineraryDay`** — every `itineraryDays[]` entry parses the same way the reader constructs it, and the model preserves each source value (catches a builder-key vs model-field drift the reader would otherwise swallow silently, vanishing the schedule to "on request") | `sailings-index.json` `itineraryDays[]` vs `schemas.py` `ItineraryDay` (TC.3), as read by `itinerary.py` `_day_by_day` | `day_by_day_parses` | error |

## Build-time guards (website repo, not `engine/validate.py`)

A few Phase 4B assumptions can only be checked where the data is produced — inside
`website/scripts/build-sailings-index.mjs` — because they concern per-row values that the
aggregation collapses before the engine ever sees them. These `throw` and fail the build
(`npm run build:index`), the same way the parsers already reject unmapped ports/regions.

| Assumption | Where | Guard | Effect |
|---|---|---|---|
| The **6 dated lines carry a real `YYYY-MM-DD` sail date whose month matches the row month**, and **no undated line carries a date** | `build-sailings-index.mjs` `validateDates` / `DATED_LINES` (TB.1) | build-time assertion | build fails |
| **De-aggregation is 1:1** — each dated line emits exactly one record per departure (`count: 1`, valid `date`, `months` reflecting the date), and **no catalogue line record carries a date** | `build-sailings-index.mjs` `validateRecords` (TB.2) | build-time assertion | build fails |
| **Day-by-day schedules are well-formed** — only Crystal & Elixir carry `itineraryDays` and both still do; every day is `{day:int≥1, port:non-empty, is_sea_day:bool}` with day numbers non-decreasing; Crystal (dated) dates every day with a real `YYYY-MM-DD`, Elixir (undated) dates none (no fabricated dates) | `build-sailings-index.mjs` `validateItineraryDays` / `DAYBYDAY_LINES` (TC.2); negative tests in `website/scripts/build-guards.test.mjs` | build-time assertion | build fails |
| **Acquired day-by-day datasets conform before merge** — the Compass→engine adapter's output matches the canonical format (required fields, ordered days, boolean `is_sea_day`, strict/real dates, all-or-nothing per-day dating, no currency), and every `SLUG_MAP` target is a real engine line slug | `from-compass.mjs` `validateOutput` + `SLUG_MAP` (TC.5a); tests in `website/scripts/itinerary/from-compass.test.mjs` | pre-write assertion (throws) | adapter fails |

## Refresh runbook

When the website data changes and is re-published into `data/` (see the README),
run `python -m engine.validate`. If a check fails, update the matching hard-coded
value:

- **`month_window`** → new season: bump `_WINDOW_START` / `_WINDOW_END` in `resolve.py`.
- **`destinations`** → new bucket: add it to `_DESTINATIONS` (and mirror the website taxonomy).
- **`line_slugs`** → line added/removed: update `_LINE_ALIASES` (slug + aliases).
- **`sailing_fields` / `content_fields`** → field renamed: update the loader + the field list.
- **`nights_numeric`** → a nights value lost its leading number: fix it in the source dataset, or make the loader normalise nights to a numeric column.
- **`ports_coverage`** → coverage dropped: a `build-sailings-index.mjs` change re-introduced route dropping/capping — restore the full-route emit (TA.1: keep `ports` on every record, `capRoute(..., 12)`), or lower `_PORTS_COVERAGE_FLOOR` in `validate.py` if the source genuinely publishes fewer routes.
- **`stale_snapshot`** → the committed snapshot is aging: rebuild the data (`npm run build:index` in the website repo, then re-publish into `data/`) so dated departures are current; adjust `_STALE_SNAPSHOT_DAYS` if the refresh cadence changed. This is the expected cadence — refresh the dated-sailing data roughly monthly.
- **`disembark_coverage`** → coverage dropped: a parser's endpoint read broke (e.g. a source table changed column order, so MSC's `cols[6]` Arrival Port or Costa's `cols[7]` To no longer align) or the aggregate stopped carrying `portTo` — fix the affected parser's `portTo` in `build-sailings-index.mjs` (TA.2), or lower `_DISEMBARK_COVERAGE_FLOOR` if a newly added line genuinely lacks arrival data.
- **`featured_itinerary_fields`** → a featured itinerary lost a key: a `FeaturedItinerary` field was renamed/removed in `cruises.ts` — restore it (and re-run the export), or update `_FEATURED_ITINERARY_FIELDS` if the shape deliberately changed (also update the itinerary tool that reads it).
- **`no_currency_in_itinerary`** → **a price leaked into itinerary data (must be fixed, error-level):** find the offending route/disembark/day-by-day/featured text in the source (`build-sailings-index.mjs` should never read a price column; a featured itinerary in `cruises.ts` may have a stray fare) and remove the amount. Never mask here — the no-price rule means the data must not carry it in the first place.
- **`day_by_day_coverage`** → an expected day-by-day line has no schedule in the snapshot: rebuild (`npm run build:index`) and re-publish `sailings-index.json` into `data/` — the build's own `validateItineraryDays` guard would have failed first if `parseCrystal`/`parseElixir` or the TC.6 acquired merge broke, so this usually means a stale publish. For an acquired line (Carnival/Silversea/Disney), coverage also drops to zero if its `*-itineraries-*.json` snapshot is missing from `docs/research/cruise-lines/` at build time. When the acquisition adds day-by-day for a new line, add it to **both** `DAYBYDAY_LINES` (builder) and `_DAY_BY_DAY_LINES` (`validate.py`).
- **`day_by_day_parses`** → a committed `itineraryDays[]` entry no longer fits the `ItineraryDay` model: the builder's day-object keys (`day`/`date`/`port`/`is_sea_day` in `build-sailings-index.mjs` `makeItineraryDay`) and the `schemas.py` `ItineraryDay` fields have drifted apart — realign them (they are one contract, like the loader/INSERT pair) so the reader (`_day_by_day`) can construct the model instead of silently dropping days.
- **`line_overview_fields`** → a line dropped a field the tools read: restore it in `cruises.ts` and re-publish, or update `_LINE_OVERVIEW_FIELDS` / `_AT_A_GLANCE_FIELDS` if the schema deliberately changed.
- **`relationship_values`** → a new relationship type: add it to `_VALID_RELATIONSHIPS` (and wherever the UI/tools branch on it).
- **`brief_files`** → publish the missing brief from the website repo.
- **`model_pricing`** → new model in `.env`: add its rates to `PRICE_PER_1K`.
- **`gate_intents`** → intent added/renamed in `IntentResult`: mirror it in `_GATE_SYSTEM`.
- **`orchestrator_intents`** → intent added to `IntentResult`: handle it in `orchestrator._canned` (or route it explicitly in `handle_turn`).
- **`sailings_load_columns`** → the loader row tuple no longer matches the INSERT: when adding a sailings column, update `_INSERT_COLUMNS` **and** `_row_from_record` **and** the table schema in `db.py` (plus `_ADDED_COLUMNS` so existing DBs migrate) together — they are one contract.
- **`routed_models`** → a route points at a third model: give it an escalation rule, or fold it into small/large.
- **`transient_errors`** → an OpenAI SDK upgrade renamed an exception: update `_TRANSIENT`.
- **`date_range_resolver`** → the resolver's output drifted from the search's expected format: make `resolve_date_range` emit strict, ordered, in-window `YYYY-MM-DD` again (or update `_build_where`'s validation to match) so the date filter isn't silently dropped.
- **`search_filters_applied`** → a `SailingFilters` field isn't reaching a WHERE clause: wire it into `sailings.py` `_build_where` (and add a probe to `_FILTER_PROBES` in `validate.py`) so the filter is actually applied.
- **`itinerary_days_render`** → the day-by-day model/renderer drifted: if you rename an `ItineraryDay` field (`day`/`date`/`port`/`is_sea_day`), update `agent.py` `_render_itinerary` to match; if the check reports the column missing, keep `itinerary_days_json` declared in **both** `db.py` `_SCHEMA` and `_ADDED_COLUMNS` (the reader `itinerary.py` `_day_by_day` SELECTs it).

---

## Un-guarded assumptions (contracts, not data drift)

These are internal contracts with nothing external to validate against — noted
here for the record. They only change by deliberate code edit.

| Assumption | Where | Note |
|---|---|---|
| Phone format `+` then 8–15 digits | `schemas.py` `UserProfile._check_phone` | Registration contract |
| Intent labels (`in_scope`, `greeting`, `price_intent`, `out_of_scope`, `injection_suspect`) | `schemas.py` `IntentResult` | Scope-gate output contract; their sync with the gate prompt IS guarded (`gate_intents`) |
| Search status labels (`ok`, `no_results`, `invalid_filters`) | `schemas.py` `SearchSailingsOutput` | Tool output contract |
| Field length bounds (agency 2–120, name 2–80, etc.) | `schemas.py` | Form validation |
| Skipped brief heading `"hero image urls"` | `load_knowledge.py` `_SKIP_SECTIONS` | RAG noise filter; extend if new noise headings appear |
| `gcc-cruise-facts` → `general` line bucket | `load_knowledge.py` | Shared-knowledge convention |
| Default models `gpt-4o-mini` / `gpt-4o` | `config.py` (env-overridable) | Provider defaults, not data |
| Destination / line **synonyms** | `resolve.py` `_DEST_SYNONYMS`, alias tables | Additive; missing synonyms degrade gracefully to `None` |
