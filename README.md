# Byond Borders Cruise Concierge

A conversational engine for Byond Borders' B2B travel-agent partners. Registered users ask, in
plain English, about the 13 cruise lines Byond Borders represents — sailings, itineraries, fleets,
regions, comparisons — and get grounded answers from the company's own verified data. Fare and
booking questions are captured as structured leads and emailed to the sales desk (the site's
strict **no-pricing** policy carries over).

Built to the principles in the "Building production agentic AI systems" guide: single agent,
deterministic control flow, typed tool contracts, storage by access pattern, model routing,
injection fencing, and traces from day one.

> **Status:** Phase 0 complete (contracts, config, SQLite store, traces); Phase 1 in progress. The
> runbook below fills in as the build progresses. See `docs/PROJECT_SPEC.md` for the full task
> breakdown.

## Repository layout

This engine is its **own repository**, separate from the Byond Borders **website** repo
(`github.com/manvendra75/byondborders`). The two are coupled by exactly one artifact — the cruise
content — and that coupling is **build-time only**, never at runtime:

- **To run the engine:** this repo already ships `data/cruise-lines.json` (committed), so a fresh
  clone needs no website checkout. Install, ingest, run.
- **To refresh cruise content:** regenerate the JSON from the website's source (see below). This is
  a manual, occasional step done on a machine that has both repos checked out side by side.

The other data files — `data/app.db` (SQLite) and `data/chroma/` (vector store) — are local build
output, git-ignored, and rebuilt by the ingest pipeline on each machine.

## Stack

Python 3.11+ · Pydantic AI (agent) · Streamlit (UI) · SQLite (app data + traces) ·
ChromaDB (local RAG) · OpenAI.

## Quick start (will grow with each phase)

```bash
# 1. Create and activate a virtualenv, then install dependencies
python -m venv .venv && source .venv/Scripts/activate   # Windows Git Bash
pip install -r requirements.txt

# 2. Configure secrets
cp .env.example .env        # then edit .env and add your OPENAI_API_KEY
```

Data build, running the app, and the eval suite are documented as those pieces land
(tasks T1.x onward).

## Refreshing cruise content

The engine reads committed source snapshots in `data/`:

- `data/sailings-index.json` — the sailings search index, **built here** by `npm run build:index`
  (`scripts/build-sailings-index.mjs`) from the datasets in `docs/research/cruise-lines/`. The
  sailings **data pipeline** (acquisition + build) lives in this repo (`scripts/`, Node build-time only).
- `data/cruise-lines.json` — cruise-line content, still shaped from the website's `src/content/cruises.ts`
- `data/knowledge/*.md` — the 13 research briefs + `gcc-cruise-facts.md`, the RAG source prose

All are committed here, so you only regenerate them when content changes.

**Rebuild the sailings index (no website checkout needed):**

```bash
npm install               # one-time: Node build tooling (playwright for the live fetch scripts)
npm run build:index       # writes data/sailings-index.json AND publishes a copy to the website bundle
```

**Publish the cruise-line content + knowledge briefs** (only when the website's `cruises.ts` changes) —
this step still lives in the website repo because it reads the site's TypeScript source:

```bash
cd ../website && npx tsx scripts/export-cruise-content.mjs   # writes cruise-lines.json + knowledge/ here
```

Commit the updated files here, then re-run ingest to rebuild the SQLite + Chroma stores:

```bash
python -m engine.ingest.load_sailings     # -> data/app.db  (sailings table)
python -m engine.ingest.load_knowledge    # -> data/chroma/ (knowledge collection)
```

The export strips nothing (there are no prices in the content); it only drops UI-only fields.

## Accessing captured data (agencies & leads)

When an agency signs in (agency, name, email, phone) it's saved to the **`users`** table in
`data/app.db` (SQLite); fare/booking enquiries land in the **`leads`** table. To read them without
writing SQL, use the report command — a console table by default, or `--csv` to pipe to a file:

```bash
python -m engine.reports users          # every registered agency + its enquiry count
python -m engine.reports users --csv    # same, as CSV (e.g. > agencies.csv)
python -m engine.reports leads --csv    # every captured enquiry, with the agency name
```

These show **real contact details** (for authorized internal use) — unlike `traces`, which mask PII.
Note `data/app.db` is local to wherever the app runs; on an ephemeral host it won't persist across
redeploys (leads are also emailed to the sales desk, but registrations live only in this file).

## Deploying to production (Railway)

The app is deployed on Railway from this repo via the **`Dockerfile`** (`railway.json` sets the builder,
start command, and healthcheck). The image **bakes the Chroma knowledge store at build time** (local
embeddings, no key needed), so boot is fast: it only loads the sailings table into the app DB, then
launches Streamlit. The `/_stcore/health` healthcheck holds traffic until Streamlit is actually ready.

Persistence: mount a Railway **volume at `/data`** (not `/app/data`, which would hide the committed
source snapshots). Only the app DB lives there — the read-only Chroma store is baked into the image.

| Variable | Value | Notes |
|---|---|---|
| `OPENAI_API_KEY` | `sk-…` | the chat models (agent) |
| `DB_PATH` | `/data/app.db` | on the volume, so registrations/leads persist |
| `PORT` | `8080` | app binds this and Railway routes to it |
| `RESEND_API_KEY` | `re_…` | omit → leads are console-logged, not emailed |
| `SALES_EMAIL` | the desk inbox | where lead notifications go |

**Do NOT set** `CHROMA_DIR` or `EMBEDDINGS_PROVIDER`: the store is baked at `/app/data/chroma` with the
local model, and queries must use the same defaults to match it.

Push to `main` → Railway auto-deploys. Pull the captured data anytime with the report commands above,
run against the service (Railway shell or `railway run`).

## Documentation

- `docs/PRD.md` — product requirements
- `docs/ARCHITECTURE.md` — system design
- `docs/PROJECT_SPEC.md` — the phased, single-prompt task breakdown
