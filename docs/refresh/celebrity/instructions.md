# Celebrity — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** celebritycruises.com (public) · **Login:** none · **Expected effort:** Silversea-easy

robots permits it (no ClaudeBot block). No importer exists yet, so Celebrity records currently answer
"day-by-day on request".

## To build (one-time)

1. **Survey** for a clean data source (like Silversea's Gatsby `page-data.json`): run the
   `cruise-line-scraper` survey on a Celebrity itinerary page, find the JSON/XHR endpoint that carries
   the day list (see `docs/research/itinerary-acquisition.md`).
2. **Write** `website/scripts/itinerary/fetch-celebrity.mjs` (mirror `fetch-silversea.mjs`), mapping via
   the shared adapter `from-compass.mjs`.
3. Emit `docs\research\cruise-lines\celebrity-itineraries-<date>.json`; add `celebrity` to the
   `DAYBYDAY_LINES` (builder) / `_DAY_BY_DAY_LINES` (engine) sets.

## Once built — refresh

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
node scripts\itinerary\fetch-celebrity.mjs        # public, no login
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring). Cadence: quarterly.

## Notes

- ~220 distinct itineraries; catalogue already carries the route, so day-by-day is enrichment.
- No prices in itinerary data.
