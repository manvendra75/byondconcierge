# Costa — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** CostaExtra agent portal (int.costaextra.com) · **Login:** yes (PSA) · **Cadence (once built):** quarterly

No importer yet → Costa records answer "day-by-day on request". Costa's day-by-day is behind the
authenticated **CostaExtra** booking portal, so it follows the **Disney pattern** (auth → survey →
fetch), expecting portal-specific bot protection.

## To build (one-time) — reuse the Disney helper pattern

Generalise the Disney scripts (`auth-disney` / `survey-disney-search` / `fetch-disney`) for CostaExtra:
1. **`auth-costa.mjs`** — open CostaExtra login, you log in, save session cookies (never the password).
2. **`survey-costa.mjs`** — find the itinerary endpoint + enumerate current sailings/URLs.
3. **`fetch-costa.mjs`** — pull the day-by-day (load each sailing's page, or replay the API if the portal
   allows it), map via `from-compass.mjs` → `costa-itineraries-<date>.json`; add `costa` to the
   `DAYBYDAY_LINES` / `_DAY_BY_DAY_LINES` sets.

Record the trade-agreement basis in `skills/cruise-line-scraper/workdir/costa/registry.yaml`.

## Once built — refresh (from `conversational-engine\`)

```powershell
node scripts\itinerary\auth-costa.mjs        # only if session expired
node scripts\itinerary\survey-costa.mjs      # refresh sailing list/URLs
node scripts\itinerary\fetch-costa.mjs       # pull day-by-day
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring).

## Notes

- Costa is a PSA partner — authorized login access under the trade agreement; keep the rate polite.
- Credentials stay local (session-only, git-ignored). **No prices** in itinerary data.
