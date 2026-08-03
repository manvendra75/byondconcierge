# Elixir — day-by-day refresh

**Status:** ✅ Already in the base dataset · **Login:** none · **Cadence:** whenever the Elixir source dataset is refreshed

Elixir is an **undated** line whose day-by-day is **already published in the committed source dataset**
and parsed by the builder (`build-sailings-index.mjs` → `parseElixir`, TC.2). **No separate scraper** —
refreshing Elixir = refreshing its source `.md` and rebuilding.

## 1. Refresh the source

Update `docs\research\cruise-lines\elixir-sailings-*.md` from the official-source research workflow.
The parser reads the `- Day N: Port – Port` lines (undated, Friday–Friday Cyclades yacht routes).

## 2. Publish into the engine

Same as every line — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring):

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
npm run build:index
python -m engine.ingest.load_sailings
python -m engine.validate
```

## Notes

- Undated line: day-by-day carries no per-day dates (day list only), like a template — this is correct, not missing data.
- Guards: `validateItineraryDays` (build) + `day_by_day_coverage` confirm Elixir still carries it.
