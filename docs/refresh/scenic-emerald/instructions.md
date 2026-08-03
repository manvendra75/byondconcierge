# Scenic (Emerald) — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** scenic.cruises (public) · **Login:** none · **Effort:** largest (river/expedition/world)

robots permits it (no ClaudeBot block). No importer yet → Scenic records answer "day-by-day on request".

## To build (one-time)

1. **Survey** a Scenic tour page for its day-by-day endpoint — river/expedition/world itineraries almost
   always publish a rich day-by-day (day cruising, excursions). See `docs/research/itinerary-acquisition.md`.
2. **Write** `website/scripts/itinerary/fetch-scenic-emerald.mjs`, map via `from-compass.mjs`, emit
   `scenic-emerald-itineraries-<date>.json`; add `scenic-emerald` to the `DAYBYDAY_LINES` / `_DAY_BY_DAY_LINES` sets.

## Once built — refresh

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
node scripts\itinerary\fetch-scenic-emerald.mjs   # public, no login
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring). Cadence: quarterly.

## Notes

- **Largest fetch** (~358 distinct itineraries; long day lists for world cruises) — cache aggressively.
- No prices in itinerary data.
