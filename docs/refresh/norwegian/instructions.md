# Norwegian (NCL) — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** ncl.com (public) · **Login:** none · **Expected effort:** Silversea-easy (one wrinkle)

robots permits it (no ClaudeBot block; only `/search/`, `/booking`, `/vacation-builder/` disallowed).
No importer yet → NCL records answer "day-by-day on request".

## To build (one-time)

1. **Enumerate:** NCL's sitemaps are **gzipped** (`sitemap_*.xml.gz`) — the importer must gunzip them
   to list itinerary URLs (the one difference from Silversea).
2. **Survey** an NCL itinerary page for its day-by-day JSON/XHR endpoint (see `docs/research/itinerary-acquisition.md`).
3. **Write** `website/scripts/itinerary/fetch-norwegian.mjs`, map via `from-compass.mjs`, emit
   `norwegian-itineraries-<date>.json`; add `norwegian` to the `DAYBYDAY_LINES` / `_DAY_BY_DAY_LINES` sets.

## Once built — refresh

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
node scripts\itinerary\fetch-norwegian.mjs        # public, no login
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring). Cadence: quarterly.

## Notes

- Dedupe by route, not NCL's coarse name patterns.
- No prices in itinerary data.
