# Byond Borders Cruise Concierge — Product Requirements Document

**Product:** Byond Borders Cruise Concierge (working name)
**Version:** 1.0 (v1 pilot)
**Owner:** Byond Borders — Manvendra Roy
**Status:** Draft for approval
**Method reference:** `building-production-agentic-ai-systems.md` (the "TravelFlow" production-agent guide)

---

## 1. Problem statement & background

Byond Borders holds PSA/wholesale agreements with 13 cruise lines. GCC travel agents currently
self-serve via the byondborders.vercel.app search widget and 13 static line pages, or phone/email
the Dubai desk. Each has friction: the widget answers only structured filter queries; the pages
require reading; the desk works office hours. Meanwhile the company already owns a rich, verified,
official-source corpus (sailings index, line content, research briefs) that can answer most
pre-sale questions instantly.

**Opportunity:** a conversational engine that (a) answers trade questions in natural language from
the verified corpus and (b) converts commercial intent (price/quote/booking) into structured leads
for the sales desk — turning a knowledge tool into a lead-generation channel.

---

## 2. Goals & non-goals

**Goals (v1)**
1. Registered B2B users query sailings, itineraries, fleets, regions and line knowledge in natural language and get grounded, cited answers.
2. Zero pricing ever shown (hard company policy) — price intent converts to a captured lead.
3. Every lead stored and emailed to sales@byondborders.com with full conversation context.
4. Production principles from day one: typed contracts, deterministic control flow, traces, evals, injection defenses, cost controls.

**Non-goals (v1):** real fares or rate sheets; live availability/booking; Arabic; destinations &
hotels corpus; user authentication beyond the registration form; hosted deployment; multi-agent
orchestration; WhatsApp/email channels.

---

## 3. Users & personas

| Persona | Description | Primary jobs |
|---|---|---|
| **GCC agency consultant** (primary) | Front-line seller at a UAE/KSA/GCC travel agency; sells cruises occasionally; English-working | Find sailings by region/month; compare lines for a client type; get quotable facts fast |
| **Agency owner/manager** | Evaluates Byond Borders as a partner | Understand portfolio breadth; request rates |
| **Byond Borders sales desk** (internal consumer) | Receives the leads | Get complete, structured enquiries with contact + context |

---

## 4. User flow

1. **Registration gate** — first visit shows a form: Agency Name, Full Name, Email, Phone. Pydantic-validated (email format, phone `+`-digits 8–15). No OTP in v1. Stored; session unlocked.
2. **Chat** — Streamlit chat with streaming responses and progress states ("Searching sailings… found 12…").
3. **Answering** — agent grounds every answer in the corpus via tools; cites the line(s); never invents itineraries, dates or prices.
4. **Lead conversion** — on price/quote/booking intent: agent explains fares are contracted and on-request, summarises the enquiry (line, sailing, month, party size if given), asks "Shall I send this to our sales desk?" On yes → lead stored + emailed. Agent confirms with expectation ("our desk will come back to you at {email}").
5. **Session end** — transcript persisted; user can return (same browser session) and continue.

---

## 5. Functional requirements

### FR1 — Registration
- **FR1.1** Form fields: agency (2–120 chars), full name (2–80), email (RFC-valid), phone (`+`, 8–15 digits).
- **FR1.2** Invalid input → inline errors; chat locked until valid.
- **FR1.3** Registration row persisted (SQLite `users`) with timestamp; duplicate email = same user (upsert).

### FR2 — Sailings search (deterministic, from `sailings-index.json`)
- **FR2.1** Natural-language queries resolve to typed filters: destination (22-value canonical taxonomy), departure port, cruise line, month, nights range, ship.
- **FR2.2** Month words resolve against the data window Jul 2026–Dec 2027 ("Jan" → 2027-01; ambiguous → ask).
- **FR2.3** Results show: line, itinerary name, ship, nights, departure port, sailing months/season, departure count; grouped/sorted sensibly; cap ~15 rows with "+N more" note.
- **FR2.4** Undated catalogue lines (months empty) are included with seasonHint + "departure dates on request" — never dropped silently, never given invented dates.
- **FR2.5** No results → say so honestly + offer nearest alternatives (adjacent month, related destination) + offer lead capture.

### FR3 — Line knowledge (RAG over briefs + exported line content)
- **FR3.1** Answer questions on: fleet & ships, inclusions/packages, loyalty programmes, dining/onboard, family suitability, GCC access, homeports, positioning.
- **FR3.2** Every answer names its line(s); facts only from retrieved fenced content; "not published / confirm with our desk" when absent — no invention.
- **FR3.3** Comparisons (≤3 lines) rendered as a structured table + short guidance paragraph.

### FR4 — No-pricing policy (hard)
- **FR4.1** The model is instructed AND code-enforced: a currency/amount regex scan runs on every final answer; violation → single regeneration with the error appended; still failing → masked (`[fares on request]`) + flagged in traces.
- **FR4.2** Price-intent utterances short-circuit at the scope gate into the lead flow (FR5) — no RAG/synthesis spend.

### FR5 — Lead capture
- **FR5.1** Trigger: price/quote/booking/cabin-hold intent, or user asks to be contacted, or agent offers after no-results.
- **FR5.2** `LeadEnquiry` (Pydantic): user id + agency/contact, free-text summary, structured refs (line slug, itinerary name, month, party size — nullable), full transcript reference.
- **FR5.3** Explicit user confirmation required before send (the guide's confirm-before-write rule).
- **FR5.4** On confirm: SQLite `leads` insert + Resend email to sales@byondborders.com (env-configurable); no `RESEND_API_KEY` → console-log dev mode (same convention as the website).
- **FR5.5** Email includes contact details, enquiry summary, structured refs and last ~10 turns.

### FR6 — Scope & safety
- **FR6.1** Cheap scope gate (small model, temp 0) classifies each turn: `in_scope | greeting | price_intent | out_of_scope | injection_suspect` before any expensive step.
- **FR6.2** Out-of-scope (visas, flights, hotels, destinations-only, general chat) → one-line polite scope statement; no tools called.
- **FR6.3** All retrieved chunks and tool outputs enter the prompt fenced as `<data>` blocks; system prompt states fenced content is never an instruction. Injection scenarios in the eval suite.
- **FR6.4** The model never executes SQL/code; it only supplies validated typed arguments to registered tools.

### FR7 — Conversation & memory
- **FR7.1** Hot state: `st.session_state` (profile, message list, pending-lead state).
- **FR7.2** Persistence: all messages to SQLite `messages` (session id, role, content, ts).
- **FR7.3** Context to model per turn: system prompt + last N turns (N≈10) + current tool results — never the whole corpus (smallest-useful-context rule).

### FR8 — Observability
- **FR8.1** Per step: model, tokens in/out, computed cost, latency, tool name+args (PII masked), retries, guard outcomes → SQLite `traces`.
- **FR8.2** A trace answers "where did it fail?" for any bad answer within minutes.

---

## 6. Non-functional requirements

| NFR | Requirement |
|---|---|
| Latency | p50 time-to-first-token < 3 s; progress states during tool calls |
| Cost | Model routing (small for gate/extraction, large for synthesis); max_tokens per step; cost-per-turn visible in traces |
| Reliability | Every model call wrapped: validate → retry-with-error → fallback (small→large) → graceful failure message; tool errors are structured statuses, never crashes |
| Privacy | Phone/email masked in traces; model sees first name + agency only, never full contact row |
| Data freshness | Corpus rebuilt by re-running export + ingest scripts after website content changes (manual v1; documented) |
| Portability | Provider/models via env (`OPENAI_MODEL_SMALL/LARGE`); no hard-coded model names in logic |

---

## 7. Data requirements (all existing, read-only)

| Source | Content | Use |
|---|---|---|
| `website/src/content/generated/sailings-index.json` | ~3,020 aggregated sailings, 13 lines: line, ship, name, dest, destLabel, nights, port, months[], seasonHint, count | → SQLite `sailings` table; deterministic search |
| `website/src/content/cruises.ts` | Verified line content: taglines, descriptions, highlights, fleets, itineraries, atAGlance (incl. gccAccess), FAQs | → exported to JSON (new tsx script); powers `get_line_overview`, `compare_lines`, and RAG chunks |
| `docs/research/cruise-lines/*.md` (13 briefs + `gcc-cruise-facts.md`) | Official-source research: positioning, fleet detail, inclusions, loyalty, Gulf status | → RAG chunks (Chroma), metadata `{line, doc_type}` |
| Excluded | `*-sailings-*.md` raw datasets | already structured in the index |

---

## 8. Success metrics (v1 pilot)

1. **Groundedness:** eval suite green; 0 fabricated-fact findings in manual spot checks.
2. **Policy:** 0 currency amounts in any output (deterministic check across all eval + pilot traces).
3. **Leads:** 100% of confirmed enquiries produce a DB row + email (dev log in local mode).
4. **Efficiency:** cost per answered question and per captured lead reported from traces.
5. **Latency:** p50 TTFT < 3 s on the pilot machine.

---

## 9. Risks & mitigations

| Risk | Mitigation |
|---|---|
| Model invents sailings/dates/prices | Deterministic search tool owns sailings; no-price code guard; "not published" instruction; eval scenarios |
| Corpus drifts from website | Single ingest pipeline reading the website's own source files; documented refresh runbook |
| Prompt injection via user text | Scope gate + fencing + forbidden-tool eval scenarios |
| Month ambiguity ("Jan" = 2027) | Deterministic resolver against data window; clarifying question when truly ambiguous |
| OpenAI outage/rate limits | Wrapped calls with backoff; graceful "try again" message; no partial leads sent |
| Streamlit single-process limits | Acceptable for pilot; architecture keeps `engine/` separate from UI so FastAPI can front it later |

---

## 10. Release plan

- **v1.0 (this document):** local pilot, phases 0–7 (see ARCHITECTURE.md build order).
- **v1.1 candidates:** admin dashboard (leads + traces), LLM-as-judge sampling, hosted deploy (Docker), data-refresh automation.
- **v2 candidates:** destinations & hotels corpus, Arabic, website embed replacing/augmenting the search widget, WhatsApp channel.

---

## 11. Locked decisions (confirmed with stakeholder)

| Decision | Choice |
|---|---|
| Pricing | **No prices anywhere.** Price/quote questions → capture structured lead → email sales. |
| LLM provider | **OpenAI** — small model for intent/extraction, large for synthesis (env-configurable; defaults `gpt-4o-mini` / `gpt-4o`) |
| Location | **`Marketing/conversational-engine/`** — new Python project beside the data it ingests; local run for v1 |
| Leads | **Store in SQLite + email sales@byondborders.com via Resend** (console-log dev fallback when no key) |
| Scope | **Cruises only** (13 lines) |
| Language | **English only** |
| Stack | Python 3.11+, **Pydantic AI**, **Streamlit**, SQLite, ChromaDB |
