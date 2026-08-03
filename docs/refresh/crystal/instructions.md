# Crystal — day-by-day refresh

**Status:** ✅ Already in the base dataset · **Login:** none · **Cadence:** whenever the Crystal source dataset is refreshed

Crystal is a **dated** line whose day-by-day is **already published in the committed source dataset**
and parsed by the builder (`build-sailings-index.mjs` → `parseCrystal`, TC.2). There is **no separate
scraper** — refreshing Crystal = refreshing its source `.md` and rebuilding.

## 1. Refresh the source

Update the Crystal dataset file in `docs\research\cruise-lines\crystal-sailings-*.md` from the
official-source research workflow (same as any base-data refresh). The parser reads the
`- Day N (Mon DD, YYYY): Port` lines directly.

## 2. Publish into the engine

Same as every line — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring):

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
npm run build:index
python -m engine.ingest.load_sailings
python -m engine.validate
```

## Notes

- Dated line: each departure carries its exact date **and** day-by-day; scenic "Cruising …" days are flagged as sea days.
- Guards: the build-time `validateItineraryDays` checks the day list; `day_by_day_coverage` confirms Crystal still carries it after a rebuild.
