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

`data/cruise-lines.json` is the cruise-line corpus, exported from the website repo's
`src/content/cruises.ts` (the single source of truth). It is committed to this repo, so you only
regenerate it when that website content changes. Check out **both repos as sibling folders**:

```
Byond Borders/Marketing/
  website/                 # the website repo
  conversational-engine/   # this repo
```

Then, from `website/`:

```bash
npx tsx scripts/export-cruise-content.mjs   # writes ../conversational-engine/data/cruise-lines.json
```

Commit the updated JSON here, then re-run ingest to rebuild the SQLite + Chroma stores. The export
script strips nothing (there are no prices in the content); it only drops UI-only fields.

## Documentation

- `docs/PRD.md` — product requirements
- `docs/ARCHITECTURE.md` — system design
- `docs/PROJECT_SPEC.md` — the phased, single-prompt task breakdown
