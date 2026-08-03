# Day-by-day refresh — per-line instructions

One `instructions.md` per cruise line for **populating / refreshing the day-by-day itinerary data**
the concierge answers with. Each line's **acquisition** differs (see its file); **publishing into the
engine** is identical for all (below).

Project root (Windows): `C:\Users\manve\Documents\Projects\Byond Borders\Marketing`
All commands below are PowerShell, run from that root unless noted.

## Status at a glance

| Line | File | Status | Login? |
|---|---|---|---|
| Silversea | [silversea/](silversea/instructions.md) | ✅ Built (public) | No |
| Disney | [disney/](disney/instructions.md) | ✅ Built (agent portal) | Yes |
| Crystal | [crystal/](crystal/instructions.md) | ✅ In base dataset | — |
| Elixir | [elixir/](elixir/instructions.md) | ✅ In base dataset | — |
| Aroya | [aroya/](aroya/instructions.md) | ⛔ Robots blocks us → partner channel | — |
| Celebrity | [celebrity/](celebrity/instructions.md) | 🔲 Not built (public) | No |
| Norwegian | [norwegian/](norwegian/instructions.md) | 🔲 Not built (public) | No |
| Royal Caribbean | [royal-caribbean/](royal-caribbean/instructions.md) | 🔲 Not built (public) | No |
| Scenic (Emerald) | [scenic-emerald/](scenic-emerald/instructions.md) | 🔲 Not built (public) | No |
| Costa | [costa/](costa/instructions.md) | 🔲 Not built (agent portal) | Yes |
| Carnival | [carnival/](carnival/instructions.md) | ✅ Built (agent portal) — 509 itineraries | Yes |
| MSC | [msc/](msc/instructions.md) | 🔲 Not built (agent portal) | Yes |
| StarDream | [dream-star/](dream-star/instructions.md) | ⏸ Deferred (1-night shuttles) | — |

## Publish into the engine (same for EVERY line, after acquiring)

> **The build consumes the acquired `*-itineraries-*.json` files (TC.6 — done).** On
> `npm run build:index`, Carnival & Silversea schedules are **enriched** onto matching base
> departures and Disney's base records are **replaced** by the acquired real-ship itineraries; the
> concierge then answers day-by-day via `get_itinerary`. Drop a fresh snapshot into
> `docs/research/cruise-lines/` and rebuild to update.

The pipeline now lives in **this repo** (`conversational-engine/`) — no website checkout needed to
rebuild. `npm run build:index` writes the index to both `data/sailings-index.json` (which ingest
reads) and the website's bundle in one step.

```powershell
cd "C:\Users\manve\Documents\Projects\Byond Borders\Marketing\conversational-engine"
npm run build:index                    # rebuild the index → data\ + website bundle
python -m engine.ingest.load_sailings  # re-ingest
python -m engine.validate              # confirm: day_by_day_coverage / no_currency / etc. green
```

## Canonical acquired-file format

Every importer writes `<slug>-itineraries-<YYYY-MM-DD>.json` into `docs/research/cruise-lines/`.
Shape is pinned in [docs/research/itinerary-acquisition.md](../../../docs/research/itinerary-acquisition.md) §3 —
one entry **per route** carrying all its departures:
`{ship, name, nights, departPort, arrivePort, dates?:[…], days:[{day, port, is_sea_day}]}`. The
`dates[]` array is what gives full per-departure coverage at merge time; the `days` are a dateless
template. (A legacy single-`date` snapshot still merges.)

## Cadence

- **Base sailings data** (dates/ports): ~**monthly** — dated departures sell out / sail away.
- **Day-by-day**: ~**quarterly** — a ship sails the same route all season; the day list is stable.
- The engine tells you when it's stale: `stale_snapshot` (snapshot >30 days), `day_by_day_coverage`
  (which lines carry it), and — once TC.7 lands — `itinerary_freshness` (per-line dataset age).

## Compliance (applies to every line)

- **Never scrape a source whose robots.txt blocks us** (e.g. Aroya blocks ClaudeBot → partner channel).
- **Authenticated portals**: use your own partner login. Credentials never leave your machine —
  only the session cookies are saved (git-ignored). Automated reads only where the trade terms allow.
- **No prices are ever fetched** into itinerary data (the `no_currency_in_itinerary` guard enforces it).
