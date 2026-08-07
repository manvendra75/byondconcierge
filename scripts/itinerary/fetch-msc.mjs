#!/usr/bin/env node
// fetch-msc.mjs — acquire MSC's dated day-by-day sailings via the third-party Apify actor
// `vulnv/msc-cruises-scraper`. MSC's own site is Akamai/robots bot-walled, so this is the sanctioned
// non-Claude channel: we consume a paid data provider's output, we do NOT scrape MSC ourselves.
//
// A run costs money (~$4/1000 results + compute), so this is a MANUAL, QUARTERLY tool — never wired
// into the build. It writes a price-free canonical snapshot that is COMMITTED to the repo
// (data/acquired/msc-itineraries.json), so rebuilds never need to re-pull and we never re-pay.
// No prices are ever read into the snapshot (every price field is dropped); the raw Apify output
// (which contains prices) is cached only in the git-ignored workdir.
//
// Needs YOUR Apify token in the environment (never committed):
//   $env:APIFY_TOKEN="apify_api_..."; node scripts/itinerary/fetch-msc.mjs --sample 3   # cheap probe
//   $env:APIFY_TOKEN="apify_api_..."; node scripts/itinerary/fetch-msc.mjs               # full pull
//   ... --from 2026-08-06 --to 2027-12-31 --max 20000                                    # tune scope/cost

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mscDest } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ENGINE_DIR = path.resolve(__dirname, "..", "..");                 // conversational-engine/
const ROOT = path.resolve(__dirname, "..", "..", "..");                 // Marketing/
const OUT_PATH = path.join(ENGINE_DIR, "data", "acquired", "msc-itineraries.json");  // committed, price-free
const RAW_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "msc");  // git-ignored (has prices)
const ACTOR = "vulnv~msc-cruises-scraper";
const API = "https://api.apify.com/v2";

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const plusMonths = (iso, n) => { const d = new Date(iso); d.setMonth(d.getMonth() + n); return d.toISOString().slice(0, 10); };

const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/&[a-z]+;/g, " ").replace(/\s+/g, " ").trim();

const isSea = (port, code = "") => !port || /at sea|day at sea|cruising|sea day/i.test(port) || /^(sea|ycs|seaday)$/i.test(code);

// Build the day-by-day as a dateless template [{ day, port, is_sea_day }] — buildFromAcquired re-dates
// it per the sailing's departure date. Prefer the exact scrapeDetails itinerary (cruiseDetails.itinerary
// .days: { port:{ code, name } }); when that wasn't captured (e.g. an OOM-truncated run), fall back to
// the ordered ports-of-call — embark, then portOfCalls[] (codes resolved to names via visitingPorts,
// sea days included), then disembark — which every sailing carries.
function parseDays(item) {
  const list = item?.cruiseDetails?.itinerary?.days || [];
  if (list.length) {
    return list.map((d, i) => {
      const port = decode(d?.port?.name || "");
      const sea = isSea(port, d?.port?.code);
      return { day: i + 1, port: sea ? "At Sea" : port, is_sea_day: sea };
    });
  }
  const nameByCode = {};
  for (const v of item.visitingPorts || []) nameByCode[v.key] = decode(v.value);
  const codes = item.portOfCalls || [];
  const seq = [decode(item.embkPort?.value), ...codes, decode(item.disembkPort?.value)];
  return seq
    .map((c) => ({ code: c, port: nameByCode[c] || c }))
    .filter((x) => x.port)
    .map((x, i) => { const sea = isSea(x.port, x.code); return { day: i + 1, port: sea ? "At Sea" : x.port, is_sea_day: sea }; });
}

// Classify by the real ports of call (from the day-by-day) plus the itinerary's own region description
// ("United States, Bahamas" / "Mediterranean" …) — far more reliable than the empty top-level portOfCalls.
function destOf(s, days) {
  const dayPorts = days.filter((d) => !d.is_sea_day).map((d) => d.port);
  const region = decode(s?.cruiseDetails?.itinerary?.description || "");
  return mscDest(s.embkPort?.value, s.disembkPort?.value, dayPorts, `${s.itineraryName || ""} ${region}`);
}

async function apify(pathAndQuery, opts = {}) {
  const token = (process.env.APIFY_TOKEN || "").trim();
  if (!token) throw new Error("Set APIFY_TOKEN in the environment (your Apify account token).");
  // Pass the token via the Authorization header (Apify's recommended method — keeps it out of URLs/logs).
  const r = await fetch(`${API}${pathAndQuery}`, { ...opts, headers: { ...(opts.headers || {}), Authorization: `Bearer ${token}` } });
  if (!r.ok) throw new Error(`Apify ${r.status} for ${pathAndQuery.split("?")[0]}: ${(await r.text()).slice(0, 160)}`);
  return r.json();
}

async function main() {
  const from = arg("from", new Date().toISOString().slice(0, 10));
  const to = arg("to", plusMonths(from, 18));
  const sample = arg("sample") ? Number(arg("sample")) : 0;
  const max = sample || (arg("max") ? Number(arg("max")) : 20000);
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  const dataset = arg("dataset");   // transform an existing run's dataset (e.g. one configured in the Apify UI)
  let items;
  if (process.argv.includes("--cached")) {
    // Re-transform the most recent raw pull WITHOUT hitting Apify (free — for iterating on the transform).
    const files = fs.existsSync(RAW_DIR) ? fs.readdirSync(RAW_DIR).filter((f) => /^raw-.*\.json$/.test(f)).sort() : [];
    if (!files.length) throw new Error("No cached raw pull found in workdir — run once without --cached first.");
    items = JSON.parse(fs.readFileSync(path.join(RAW_DIR, files[files.length - 1]), "utf8"));
    console.log(`Loaded ${items.length} sailings from cache (${files[files.length - 1]}) — no Apify run.`);
  } else if (dataset) {
    // Pull an already-completed run's dataset (you ran the actor in the Apify console with the right market).
    items = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = await apify(`/datasets/${dataset}/items?clean=true&format=json&limit=1000&offset=${offset}`);
      items.push(...batch); if (batch.length < 1000) break;
    }
    console.log(`Fetched ${items.length} sailings from dataset ${dataset}.`);
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, `raw-${generated}.json`), JSON.stringify(items));
  } else {
    // Market/storefront: the actor's default is Poland (tiny catalogue → ~5 results). Override to a full
    // market via flags (values come from the actor's Input-form dropdowns). `--destinations MED,NOR,CAR,…`
    // filters to specific area codes; omit to let a full market return everything.
    // Default to the UK storefront — the actor's Poland default returns a tiny catalogue; UK is
    // English AND carries MSC's full worldwide inventory (verified). Override via flags for another market.
    const input = {
      departureDateFrom: from, departureDateTo: to, scrapeDetails: true, availableOnly: true, maxResults: max,
      baseUrl: arg("base", "https://www.msccruises.co.uk"),
      marketPath: arg("market-path", "uk"),
      locale: arg("locale", "en_GB"),
      languageCode: arg("lang", "eng"),
      countryCode: arg("country", "GB"),
      currencyCode: arg("currency", "GBP"),
      ...(arg("destinations") ? { destinations: arg("destinations").split(",").map((x) => x.trim()) } : {}),
    };
    console.log(`Starting actor run (${from} → ${to}, market ${input.countryCode}/${input.marketPath}, maxResults ${max}${sample ? " [SAMPLE]" : ""}) …`);
    const run = (await apify(`/acts/${ACTOR}/runs`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) })).data;

    // Poll to completion (async so a large worldwide pull doesn't hit the sync timeout).
    let status = run.status;
    for (let t = 0; t < 240 && !["SUCCEEDED", "FAILED", "ABORTED", "TIMED-OUT"].includes(status); t++) {
      await sleep(10000);
      status = (await apify(`/actor-runs/${run.id}`)).data.status;
      if (t % 6 === 0) console.log(`  … ${status}`);
    }
    if (status !== "SUCCEEDED") throw new Error(`Run ended ${status}.`);

    // Fetch the dataset, paginated.
    items = [];
    for (let offset = 0; ; offset += 1000) {
      const batch = await apify(`/datasets/${run.defaultDatasetId}/items?clean=true&format=json&limit=1000&offset=${offset}`);
      items.push(...batch);
      if (batch.length < 1000) break;
    }
    console.log(`Fetched ${items.length} sailings.`);

    // Cache raw (git-ignored — retains prices) for free re-transforms.
    fs.mkdirSync(RAW_DIR, { recursive: true });
    fs.writeFileSync(path.join(RAW_DIR, `raw-${generated}.json`), JSON.stringify(items));
  }

  if (sample) {
    // Dump the shape so the transform (esp. day-by-day + dest) can be confirmed before a full run.
    const it = items[0] || {};
    console.log("\n=== item top-level keys ===\n", Object.keys(it).join(", "));
    console.log("\n=== cruiseDetails.itinerary (first item) ===\n", JSON.stringify(it.cruiseDetails?.itinerary, null, 1)?.slice(0, 1200));
    console.log("\n=== mapped (first 3) ===");
    for (const s of items.slice(0, 3)) {
      const d = parseDays(s);
      console.log(`  ${s.shipCd?.value} | ${s.itineraryName} | ${s.numberOfNights}n | ${s.embkPort?.value}→${s.disembkPort?.value} | ${s.departureStartDate} | dest=${destOf(s, d)} | route: ${d.map((x) => x.port).join(" > ")}`);
    }
    return;
  }

  // Transform → price-free canonical snapshot.
  const itineraries = [];
  const unmapped = new Set();
  let noDays = 0;
  for (const s of items) {
    const depDate = String(s.departureStartDate || "").slice(0, 10);
    const ship = s.shipCd?.value, depPort = s.embkPort?.value, arrPort = s.disembkPort?.value;
    if (!depDate || !ship || !depPort) continue;
    const days = parseDays(s);
    if (!days.length) noDays++;
    const dest = destOf(s, days);
    if (!dest) unmapped.add(`${depPort}→${arrPort} / ${decode(s.cruiseDetails?.itinerary?.description).slice(0, 30)}`);
    itineraries.push({
      ship, name: decode(s.itineraryName), nights: Number(s.numberOfNights),
      departPort: depPort, arrivePort: arrPort || depPort,
      ...(dest ? { dest } : {}), days, dates: [depDate],
    });
  }
  if (unmapped.size) console.log(`Unmapped dest (omitted): ${[...unmapped].slice(0, 12).join(" | ")}${unmapped.size > 12 ? " …" : ""}`);

  // ACCUMULATE across runs (dedup by ship+date+nights+embark+disembark; a fresh row wins). The
  // all-worldwide + scrapeDetails pull is memory-heavy and can be truncated (OOM), so pulling in
  // date chunks and merging builds the full snapshot up instead of overwriting. Pass --replace to
  // start fresh instead of merging.
  fs.mkdirSync(path.dirname(OUT_PATH), { recursive: true });
  const keyOf = (it) => `${it.ship}|${it.dates[0]}|${it.nights}|${it.departPort}|${it.arrivePort}`;
  const byKey = new Map();
  if (!process.argv.includes("--replace") && fs.existsSync(OUT_PATH)) {
    try { for (const it of (JSON.parse(fs.readFileSync(OUT_PATH, "utf8")).itineraries || [])) byKey.set(keyOf(it), it); } catch { /* start fresh */ }
  }
  const priorCount = byKey.size;
  for (const it of itineraries) byKey.set(keyOf(it), it);
  const merged = [...byKey.values()];

  const obj = { generated, line: "msc", source: "Apify vulnv/msc-cruises-scraper (UK storefront, all destinations, day-by-day, no prices)", itineraries: merged };
  fs.writeFileSync(OUT_PATH, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, OUT_PATH)}`);
  console.log(`  this run: ${itineraries.length} sailings (${itineraries.filter((i) => i.days.length).length} w/ day-by-day, ${unmapped.size} unmapped) · +${merged.length - priorCount} new · ${merged.length} total in snapshot`);
}

main().catch((e) => { console.error(e.message || e); process.exit(1); });
