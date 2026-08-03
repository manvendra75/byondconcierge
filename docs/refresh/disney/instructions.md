# Disney — day-by-day refresh

**Status:** ✅ Built · **Source:** Disney Travel Agents portal (`cruiseDetailsResponse`) · **Login:** yes (your PSA agent login) · **Cadence:** quarterly; re-login when the session lapses

**Why it's more involved than Silversea:** Disney's portal is protected by Akamai + a per-sailing
auth token, which blocks every shortcut (bare API replay, headless, cross-sailing replay all 401/403).
The only reliable method is loading **each sailing's own detail page** headed. Your credentials never
leave your machine — only the session **cookies** are saved (git-ignored).

## One-time setup (repeat only if Playwright is missing)

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
npm install -D playwright
npx playwright install chromium
```

## Refresh — run in order (from `conversational-engine\`)

**Step 1 — Log in** (only if the saved session has expired; skip if step 2/3 still authenticate):
```powershell
node scripts\itinerary\auth-disney.mjs
```
A browser opens at the Travel Agents login → **you** log in (+ MFA) → press **ENTER**. Saves the
session to `workdir\disney\.auth\storageState.json` (cookies only, **never your password**).

**Step 2 — Refresh the sailing list + detail URLs** (inventory changes as departures open/close):
```powershell
node scripts\itinerary\survey-disney-search.mjs
```
In the browser: go to **Book a Cruise**, run the **widest** search, **scroll through all results**,
press **ENTER**. Saves `workdir\disney\{sailing-codes.json, disney-urls.json}`.

**Step 3 — Pull the day-by-day** (loads each sailing's own page, headed — a window opens; minimise it):
```powershell
node scripts\itinerary\fetch-disney.mjs --limit 3    # quick test → expect  ✓ [n/…] <code> <ship> — N days
node scripts\itinerary\fetch-disney.mjs              # full (~92 products, ~15–20 min, throttled)
```
- Writes `docs\research\cruise-lines\disney-itineraries-<today>.json` (~91 itineraries).
- **Resumable:** each page is cached under `workdir\disney\raw\`; re-run to resume or retry the odd failure.

## Step 4 — Publish into the engine

Same as every line — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring).

## Troubleshooting

| Symptom | Fix |
|---|---|
| `No session` / everything **401** | session expired → re-run **Step 1** (`auth-disney.mjs`) |
| **403** on every sailing | don't pass `--headless` (Akamai flags headless Chrome; the default headed mode is required) |
| A short URL / faked URL times out | expected — Disney needs each sailing's real URL; that's why Step 2 harvests them |
| a few `! <code>` failures | fine — re-run `fetch-disney.mjs`, it resumes from cache and retries only the misses |

## Notes

- **Wired into the engine (Stage D + TD.16):** `npm run build:index` sources Disney entirely from the
  acquired snapshot (real ships + day-by-day + dest classified from the itinerary name) via the
  generic `buildFromAcquired` path. Disney is a **dated** line with **full date coverage** —
  `fetch-disney` enumerates all ~680 sailings from the search captures and groups each product's
  departures into `dates[]`, so the concierge answers with every exact departure (~678 dated records).
  Unclassifiable names are skipped + logged.
- **Refresh:** re-run the search survey (to refresh the 680 sailing list) then `fetch-disney.mjs` —
  it reuses the `raw/` cache and only fetches new sailings; the browser launches only when something
  is uncached. Full first run is ~40–70 min (throttled, headed; resumable).
- **No prices** are read — only the itinerary (the pricing in the same response is never emitted).
- Git-ignored (session/pricing): `.auth/`, `storageState.json`, `raw/`, `samples/`, `request-shape.json`, `disney-urls.json`.
- Helper scripts: `auth-disney.mjs`, `survey-disney-search.mjs`, `capture-disney-request.mjs`, `fetch-disney.mjs`.
- The **same auth → survey → fetch pattern** applies to the other agent portals (Costa/Carnival/MSC) when built.
