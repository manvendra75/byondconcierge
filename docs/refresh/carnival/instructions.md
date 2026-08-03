# Carnival — day-by-day refresh

**Status:** ✅ Built · **Source:** GoCCL Navigator agent portal (goccl.com) · **Login:** yes (PSA) · **Cadence:** quarterly
**Last snapshot:** `carnival-itineraries-2026-08-03.json` — **509 itineraries**, 30 ships, 2–23 nights (no prices).

Carnival's day-by-day lives behind the authenticated **GoCCL Navigator** agent portal. Unlike Disney
(Akamai + per-sailing tokens), GoCCL is a **clean JSON API**, so the importer reads it directly with the
session cookies — no per-page navigation needed. The three reusable portal helpers do the whole job:
`auth-portal.mjs` → `survey-portal.mjs` → `fetch-carnival.mjs` (maps via `from-compass.mjs`).

## Refresh (from `conversational-engine\`)

```powershell
# 1. Session (only if expired — cookies live in workdir\carnival\.auth\, git-ignored)
node scripts\itinerary\auth-portal.mjs --line carnival --url "https://www.goccl.com/"
#    → log in yourself in the browser that opens, then press ENTER.

# 2. Refresh the sailing list (open ONE cruise's day-by-day, run the widest search, scroll ALL
#    results so every distinct itinerary is captured), then press ENTER.
node scripts\itinerary\survey-portal.mjs --line carnival --url "https://www.goccl.com/app/cruise-search"

# 3. Pull day-by-day → docs\research\cruise-lines\carnival-itineraries-<date>.json
node scripts\itinerary\fetch-carnival.mjs --limit 3    # smoke test first
node scripts\itinerary\fetch-carnival.mjs              # full run (~500 itineraries, throttled)
```

Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring).

## How it works

- **Enumerate** — `fetch-carnival.mjs` reads the captured `samples\*cruises*.json`, taking ONE
  representative per distinct route (`itineraryCode`/`embarkationPortCode`/`durDays`) **and collecting
  every departure date for it** into `dates[]` — this is what gives ~full per-departure coverage
  (currently ~85% of base Carnival departures; the rest are dates not in the live search).
- **Fetch** — the day-by-day is pulled ONCE per route via
  `GET /app/bookingengine/api/v1.0/itinerary?…` (`context.request`, session cookies). Sea days =
  portCode `FS1/FS2…` or "Fun Day At Sea".
- **Cache + offline re-emit** — raw responses cached in `workdir\carnival\raw\`; re-runs are
  **idempotent and resumable**. When every route is already cached, `fetch-carnival.mjs` runs
  **fully offline** (no portal/session) — useful to re-emit after a code change. Delete `raw\` to
  force a fresh pull.

## Notes

- Carnival is a PSA partner — authorized login under the trade agreement; keep the rate polite
  (default 2 s between calls). Basis recorded in `skills\cruise-line-scraper\workdir\carnival\registry.yaml`.
- Credentials stay local (session-only, git-ignored). **No prices** in itinerary data — enforced by
  `validateOutput()` in `from-compass.mjs` and the engine's `no_currency_in_itinerary` guard.
- **Wired into the engine (TC.6):** `npm run build:index` enriches the day-by-day onto matching
  Carnival departures by exact `(ship, nights, date)` (then unambiguous ship+nights+embark), so the
  concierge answers Carnival day-by-day via `get_itinerary`. Publish per the steps above to refresh.
