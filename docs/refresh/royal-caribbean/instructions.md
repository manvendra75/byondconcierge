# Royal Caribbean — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** royalcaribbean.com (public) / possible partner API · **Login:** none · **Effort:** small (low volume)

No importer yet → RC records answer "day-by-day on request". The committed RC dataset is a
mixed-brand availability list; only ~13 distinct RC-brand itineraries here, so volume is small.

## To build (one-time)

1. **Check for a partner API first** — RC (Royal Caribbean Group) exposes agent tooling that may serve
   itineraries directly; prefer it over scraping.
2. Otherwise **survey** a royalcaribbean.com itinerary page for its day-by-day endpoint
   (see `docs/research/itinerary-acquisition.md`).
3. **Write** `website/scripts/itinerary/fetch-royal-caribbean.mjs`, map via `from-compass.mjs`, emit
   `royal-caribbean-itineraries-<date>.json`; add `royal-caribbean` to the `DAYBYDAY_LINES` / `_DAY_BY_DAY_LINES` sets.

## Once built — refresh

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
node scripts\itinerary\fetch-royal-caribbean.mjs
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring). Cadence: quarterly.

## Notes

- Low volume; day-by-day is enrichment.
- No prices in itinerary data.
