# MSC — day-by-day refresh

**Status:** 🔲 Not built yet · **Source:** mscbook.com agent portal · **Login:** yes · **Cadence (once built):** quarterly

No importer yet → MSC records answer "day-by-day on request". MSC's day-by-day is behind the
authenticated **mscbook.com** agent portal, so it follows the **Disney pattern**. (MSC is not on the
PSA-partner list — confirm the account basis before automated reads.)

## To build (one-time) — reuse the Disney helper pattern

Generalise `auth-disney` / `survey-disney-search` / `fetch-disney` for mscbook:
1. **`auth-msc.mjs`** — open mscbook login, you log in, save session cookies (never the password).
2. **`survey-msc.mjs`** — find the itinerary endpoint + enumerate current sailings/URLs.
3. **`fetch-msc.mjs`** — pull the day-by-day, map via `from-compass.mjs` →
   `msc-itineraries-<date>.json`; add `msc` to the `DAYBYDAY_LINES` / `_DAY_BY_DAY_LINES` sets.

The current MSC catalogue already carries an arrival port (`portDisembark`); day-by-day adds the
per-day structure. Record the account/terms basis in `skills/cruise-line-scraper/workdir/msc/registry.yaml`.

## Once built — refresh (from `conversational-engine\`)

```powershell
node scripts\itinerary\auth-msc.mjs        # only if session expired
node scripts\itinerary\survey-msc.mjs      # refresh sailing list/URLs
node scripts\itinerary\fetch-msc.mjs       # pull day-by-day
```
Then publish — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring).

## Notes

- Confirm mscbook's agent terms permit automated reads before scaling up.
- Credentials stay local (session-only, git-ignored). **No prices** in itinerary data.
