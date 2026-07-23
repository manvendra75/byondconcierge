# Byond Borders Cruise Concierge — Architecture

Companion to `PRD.md`. Describes the system design, how it maps to the production-agent guide
(`building-production-agentic-ai-systems.md`), the component inventory, and the build order.

---

## 1. System diagram

```
 Streamlit UI (app.py)
 ┌──────────────────────────────────────────────────────────────┐
 │ Registration gate (Pydantic form) → chat (streaming +        │
 │ progress states) · session_state = hot conversation state    │
 └──────────────┬───────────────────────────────────────────────┘
                │ user turn
 ┌──────────────▼───────────────────────────────────────────────┐
 │ ORCHESTRATION (code — engine/agent.py + guards.py)           │
 │ 1. cheap scope gate  — small model intent classify           │
 │    (greeting / out_of_scope / price_intent short-circuits)   │
 │ 2. Pydantic AI agent — large model + typed tools             │
 │ 3. output guards     — currency regex → regenerate/mask      │
 │ 4. trace log         — SQLite traces table                   │
 └───────┬──────────────┬──────────────┬────────────────────────┘
         │              │              │
 ┌───────▼─────┐ ┌──────▼──────┐ ┌────▼─────────────────────────┐
 │ MODEL LAYER │ │ TOOLS (all  │ │ STORAGE (by access pattern)  │
 │ config.py   │ │ Pydantic    │ │ SQLite: users · leads ·      │
 │ MODEL_ROUTES│ │ contracts)  │ │  messages · traces · sailings│
 │ small: gate │ │ R search_   │ │ Chroma (local): 14 briefs +  │
 │  + extract  │ │   sailings  │ │  line content chunks,        │
 │ large:      │ │ R line_info │ │  metadata={line, doc_type}   │
 │  synthesis  │ │ R compare   │ │ st.session_state: hot chat   │
 │ env-config  │ │ R search_   │ └──────────────────────────────┘
 │  model names│ │   knowledge │
 └─────────────┘ │ W create_   │  Offline data pipeline:
                 │   lead ──►  │  website/scripts/export-cruise-content.mjs
                 │  (only write│    cruises.ts → data/cruise-lines.json
                 │   user-con- │  engine/ingest/load.py
                 │   firmed +  │    sailings-index.json → SQLite
                 │   code-val- │    briefs *.md + line JSON → Chroma
                 │   idated)   │
                 └─────────────┘
```

---

## 2. Guide principles → design decisions

| Guide principle | Applied here |
|---|---|
| Start single-agent (§3) | One Pydantic AI agent; specialization lives in tools |
| Storage by access pattern, vector ≠ default (§6.2) | Sailings = SQL table + deterministic filters; vector store ONLY for prose knowledge |
| Pipeline first (§7.2) | Fixed code path gate→agent→guards→trace; model decides within steps only |
| Model routing (§4.1) | `MODEL_ROUTES` table: gate/extract = small; synthesis/compare = large |
| Structured outputs (§4.2) | Every model↔system boundary is a Pydantic schema (`IntentResult`, `SailingFilters`, `LeadEnquiry`) |
| Tool contracts (§5.1) | Each tool: name, description, input/output schema, risk tier, timeout, retry policy |
| Read → write ladder (§5.3) | Four read tools; ONE low-risk write (`create_lead_enquiry`) behind user confirmation + code validation |
| Code owns business rules (§9.2) | No-price rule = regex guard in code; lead validation = code; model never sends email |
| Injection boundary (§12.3) | `fence_data()` wraps all retrieved/tool content in labeled `<data>` blocks |
| Traces from day one (§13.1) | `StepTrace` on every model + tool step, PII-masked |
| Evals before automation (§8, §14.2) | Scenario suite + deterministic trace checks land before the pilot opens |

---

## 3. Component inventory & file layout

```
conversational-engine/
  README.md · requirements.txt · .env.example     # OPENAI_API_KEY, OPENAI_MODEL_SMALL,
  app.py                                          # OPENAI_MODEL_LARGE, RESEND_API_KEY?,
  data/                                           # SALES_EMAIL, DB_PATH
    cruise-lines.json        (generated)          # ← export script output
    app.db · chroma/         (generated)
  engine/
    config.py       # env loading + MODEL_ROUTES {step: model, max_tokens, temperature}
    schemas.py      # UserProfile · IntentResult · SailingFilters · SailingRecord ·
                    # SearchSailingsOutput(status,…) · KnowledgeHit · LeadEnquiry · contracts
    db.py           # SQLite bootstrap + typed helpers (users, leads, messages, traces, sailings)
    trace.py        # StepTrace + log_step(); token/cost accounting; PII masking
    guards.py       # cheap_scope_gate() · currency_scan() · fence_data()
    agent.py        # Pydantic AI Agent: system prompt, tool registration, run_turn() streaming
    ingest/load.py  # idempotent: sailings→SQLite, briefs+line JSON→Chroma (chunk by heading)
    tools/
      sailings.py   # search_sailings — SQL; month resolver (word→YYYY-MM vs data window)
      lines.py      # get_line_overview · compare_lines — from cruise-lines.json (cached)
      knowledge.py  # search_knowledge — Chroma query, metadata filter, fenced return
      leads.py      # create_lead_enquiry — validate → insert → Resend (dev fallback)
  evals/
    scenarios/      # YAML: med_jan_search · price_question_to_lead · injection_in_question ·
                    # out_of_scope_visa · undated_line_search · comparison_grounded ·
                    # no_results_alternatives · greeting_short_circuit
    test_tools.py   # unit tests for deterministic tools (no LLM needed)
    test_traces.py  # scenario runner + deterministic trace assertions
  docs/
    PRD.md          # product requirements
    ARCHITECTURE.md # this file

website/scripts/export-cruise-content.mjs   # lives in the SEPARATE website repo (run via npx tsx):
                                            # imports cruiseLines from src/content/cruises.ts,
                                            # writes ../conversational-engine/data/cruise-lines.json
```

**Two-repo boundary.** The website (Next.js, on Vercel) and this engine (Python) are separate
repositories, coupled only by the exported cruise content — a **build-time** artifact, not a runtime
dependency. `data/cruise-lines.json` is generated in the website repo but **committed here**, so this
repo runs from a fresh clone with no website checkout. The export script is a refresh-only bridge run
when both repos are checked out as sibling folders (see the engine README).

### 3.1 Storage design (by access pattern — the guide's §6.2 rule)

| Data | Access pattern | Store |
|---|---|---|
| Active chat state (profile, messages, pending lead) | hot, per-session | `st.session_state` |
| Users, leads, messages, traces | transactional, relational | SQLite (`data/app.db`) |
| Sailings (~3,020 rows) | structured filter queries | SQLite `sailings` table — **not** vector |
| Line briefs + prose line content | semantic retrieval | ChromaDB (`data/chroma/`), metadata `{line, doc_type}` |

### 3.2 Tool contracts (the guide's §5.1)

| Tool | Risk | Input → Output | Notes |
|---|---|---|---|
| `search_sailings` | read | `SailingFilters` → `SearchSailingsOutput{status, rows[], note}` | SQL only; model supplies filters, code runs query |
| `get_line_overview` | read | `{line_slug}` → line facts | from `cruise-lines.json`, cached |
| `compare_lines` | read | `{line_slugs[≤3]}` → comparison rows | verified content only |
| `search_knowledge` | read | `{query, line_slug?}` → `KnowledgeHit[]` (fenced) | Chroma, metadata-filtered |
| `create_lead_enquiry` | write (low) | `LeadEnquiry` → `{status, lead_id}` | validate → insert → Resend; user-confirmed first |

### 3.3 Control flow (per turn)

```
user message
  → cheap_scope_gate()          (small model, temp 0, max ~50 tok)
       greeting        → canned friendly reply (no tools)
       out_of_scope    → one-line scope statement (no tools)
       price_intent    → enter lead flow (confirm → create_lead_enquiry)
       injection       → refuse (no tools)
       in_scope        ↓
  → Pydantic AI agent run       (large model; may call read tools; retrieved content fenced)
  → currency_scan(answer)       (regex; violation → 1 regen w/ error → else mask)
  → persist message + log StepTrace(s)
  → stream to UI
```

---

## 4. Build order (step by step)

Read→write risk ladder applied to the whole project; every phase independently verifiable.

| Phase | Build | Done when |
|---|---|---|
| **0. Contracts & skeleton** | Scaffold, `requirements.txt`, `.env.example`, `schemas.py` (ALL contracts first), `db.py`, `trace.py` | `pytest` schema round-trips pass; tables create |
| **1. Data pipeline** | `export-cruise-content.mjs`; `ingest/load.py` (SQLite sailings + Chroma chunks) | Counts match source; spot queries return expected rows/chunks; re-run idempotent |
| **2. Deterministic tools** | `sailings.py` (+ month resolver), `lines.py`, `knowledge.py` — pure Python, LLM-free | `test_tools.py` green: Med+Jan → correct rows; undated lines included; Chroma filtered by line |
| **3. Agent core** | `config.py` routing, `guards.py`, `agent.py` (Pydantic AI, tools, fencing, no-price guard, retry/fallback wrapper) | Scripted console conversations behave; trace rows written with cost/latency |
| **4. Streamlit UI** | Registration gate, streaming chat, progress states, message persistence | Manual E2E in browser; refresh keeps session |
| **5. Lead flow** | `leads.py`, confirmation turn, Resend + dev fallback | Price question → confirm → `leads` row + email logged/sent with transcript context |
| **6. Eval harness** | Scenario YAMLs + `test_traces.py`; cost/latency summary script over traces | Full suite green; currency-scan violations = 0 across all scenario outputs |
| **7. Hardening** | lru-cache line lookups, token-cap audit, PII masking verification, README runbook | Suite re-green; fresh-clone setup works from README alone |

---

## 5. End-to-end verification (after phase 7)

1. `node website/scripts/export-cruise-content.mjs && python -m engine.ingest.load` → counts reported, idempotent.
2. `pytest evals/ -v` → all green; zero currency matches.
3. `streamlit run app.py` → register → canonical flows: Med-in-Jan (cross-check against the site search widget), Celebrity inclusions, MSC-vs-Costa comparison, price question → lead (check DB row + email log), injection attempt refused, visa question politely scoped-out with no tool calls (verify in trace).
4. `traces` table answers cost/turn, latency, and "which step" for any answer.
