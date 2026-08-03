# Silversea — day-by-day refresh

**Status:** ✅ Built · **Source:** silversea.com Gatsby `page-data.json` (public, static) · **Login:** none · **Cadence:** quarterly

Silversea is the easy case — a public static JSON endpoint, so it's a single headless command, no login.

## 1. Acquire

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
node scripts\itinerary\fetch-silversea.mjs --limit 5     # quick test (a few voyages)
node scripts\itinerary\fetch-silversea.mjs               # full refresh (~343 voyages, ~15 min, throttled)
```

- Writes `docs\research\cruise-lines\silversea-itineraries-<today>.json`.
- **Idempotent / resumable:** raw responses are cached under `skills\cruise-line-scraper\workdir\silversea\raw\`; re-running skips what's already fetched.
- Optional knobs: `--delay 5000` (ms between requests), `--date 2026-08-01` (stamp the output filename).

## 2. Publish into the engine

Same for every line — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring):

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
npm run build:index
python -m engine.ingest.load_sailings
python -m engine.validate
```

## Notes

- **Wired into the engine (TC.6):** `npm run build:index` enriches the day-by-day onto matching
  Silversea departures (by exact date, then named itinerary / unambiguous ship+nights+embark with a
  disembark-consistency guard); the concierge then answers via `get_itinerary`.
- **Route-grouped for full-date coverage:** the importer groups a route's many voyages into one
  entry carrying every departure in `dates[]` (like Carnival), so each base departure matches by its
  exact date. **Current coverage is low only because the committed *base* Silversea extract is dated
  2026 while this acquired snapshot is 2027 — the date sets don't overlap.** Refresh the base
  Silversea sailings (the markdown extract) to the same window to unlock it; the mechanism is ready.
- **No prices** are ever fetched — only the day-by-day.
- robots.txt permits these pages (checked; only PDFs / `insider` / `refinement` params disallowed).
- **Past sailings' URLs 404** — the importer always enumerates *current* voyages from the sitemap, so this is self-correcting on each run.
- Survey + registry: `skills\cruise-line-scraper\workdir\silversea\`.
