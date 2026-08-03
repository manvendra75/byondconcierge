#!/usr/bin/env node
// TC.5b — Carnival day-by-day importer (GoCCL Navigator, authenticated).
//
// GoCCL is a clean JSON API. Each search result carries `itineraryUrlData` + `departureDate.iso8601`,
// and the day-by-day is a simple GET:
//   /app/bookingengine/api/v1.0/itinerary?duration=&embarkationPortCode=&itineraryCode=&sailDate=<ISO>&shipCode=
// returning `schedule[] = {day, date, portCode, port}` (sea day = portCode "FS…" / "Fun Day At Sea").
//
// We enumerate ONE representative per distinct itinerary from the captured search samples, then GET
// each itinerary endpoint FROM a loaded GoCCL page (page.evaluate → same-origin XHR: cookies + any
// bot clearance apply, the lesson from Disney). Only the itinerary is read — never pricing.
//
// Run (after auth-portal.mjs --line carnival … and survey-portal.mjs --line carnival …):
//   node scripts/itinerary/fetch-carnival.mjs --limit 3     # test
//   node scripts/itinerary/fetch-carnival.mjs               # full

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched, so offline cache
// re-emits (all routes cached) run without playwright installed in the engine repo.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

import { carnivalDest } from "./classify.mjs";
import { mapCompass, validateOutput } from "./from-compass.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "carnival");
const STATE_PATH = path.join(DIR, ".auth", "storageState.json");
const SAMPLES_DIR = path.join(DIR, "samples");
const CACHE_DIR = path.join(DIR, "raw");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const ORIGIN = "https://www.goccl.com";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
const iso = (d) => (d && (d.iso8601 || (typeof d.rawValue === "string" && d.rawValue.slice(0, 10)))) || undefined;
// Carnival marks a sea day as portCode "FS1/FS2…" or port name "Fun Day At Sea".
const isSea = (port, code) => /at sea|fun day/i.test(port || "") || /^FS\d*$/i.test(code || "");

// ---------------------------------------------------------------------------------------
// Enumerate ONE representative per distinct itinerary, from the captured cruise-search samples
// ---------------------------------------------------------------------------------------
function enumerateFromSamples() {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  const byItin = new Map();
  for (const f of fs.readdirSync(SAMPLES_DIR).filter((x) => x.includes("cruises"))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), "utf8")); } catch { continue; }
    for (const s of j.sailings || []) {
      const u = s.itineraryUrlData;
      if (!u || !u.itinCode) continue;
      const key = `${u.itinCode}-${u.embkCode}-${u.durDays}`;
      const d = iso(s.departureDate);
      let e = byItin.get(key);
      if (!e) {
        e = { itineraryCode: u.itinCode, duration: u.durDays, embarkationPortCode: u.embkCode,
              shipCode: u.shipCode, sailDate: d, dates: new Set() };   // sailDate = a representative for the fetch
        byItin.set(key, e);
      }
      // Collect EVERY departure date for this itinerary (the coverage upgrade): the day-by-day is
      // fetched once per itinerary, but the search lists it on many dates — carry all of them so the
      // TC.6 merge can match each base departure by its exact date.
      if (d) { e.dates.add(d); if (!e.sailDate) e.sailDate = d; }
    }
  }
  return [...byItin.values()]
    .map((e) => ({ ...e, dates: [...e.dates].sort() }))
    .filter((x) => x.sailDate);
}

// ---------------------------------------------------------------------------------------
// Extract one itinerary response into Compass canonical fragments
// ---------------------------------------------------------------------------------------
function extractItinerary(j) {
  if (!j || !Array.isArray(j.schedule) || !j.schedule.length) return null;
  const shipId = `carnival:ship:${slug(j.shipName || j.shipCode)}`;
  const ports = [], days = [];
  for (const e of j.schedule) {
    if (e.isExcluded) continue;
    const sea = isSea(e.port, e.portCode);
    const portId = `carnival:port:${slug(e.portCode || e.port)}`;
    ports.push({ id: portId, line: "carnival", name: sea ? "At Sea" : e.port });
    days.push({ day: e.day, port_id: portId, is_sea_day: sea });
  }
  if (!days.length) return null;
  return {
    ship: { id: shipId, line: "carnival", name: j.shipName || null },
    ports,
    itinerary: {
      id: `carnival:itin:${j.itineraryCode}`, line: "carnival",
      name: j.itineraryTitle || `${j.destinationName} from ${j.embarkationPortName}`,
      // Canonical destination from GoCCL's stable destinationCode (TD.4) — carried on the snapshot so
      // the generic builder path reads it directly. Throws on an unmapped code (a new GoCCL region).
      dest: carnivalDest(j.destinationCode),
      ship_id: shipId, nights: j.duration, embark_port_id: days[0].port_id, days,
    },
    sailing: {
      id: `carnival:sailing:${j.itineraryCode}-${iso(j.departure)}`, line: "carnival",
      itinerary_id: `carnival:itin:${j.itineraryCode}`, ship_id: shipId,
      depart_date: iso(j.departure), return_date: iso(j.arrival), status: "on_sale",
    },
  };
}

function parseArgs(argv) { const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1]; return a; }

const cacheFileFor = (it) =>
  path.join(CACHE_DIR, `${it.itineraryCode}-${it.embarkationPortCode}-${it.duration}.json`);

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const delay = Number(args.delay ?? 2000);
  const generated = args.date || new Date().toISOString().slice(0, 10);
  const outDir = args.out || OUT_DIR;

  let itins = enumerateFromSamples();
  if (!itins.length) throw new Error("no itineraries enumerated — run survey-portal.mjs --line carnival … (scroll all search results).");
  if (args.limit) itins = itins.slice(0, Number(args.limit));
  const totalDepartures = itins.reduce((n, it) => n + it.dates.length, 0);
  console.log(`Importing ${itins.length} Carnival itineraries (${totalDepartures} departures, delay ${delay}ms)…`);

  // The day-by-day is fetched once per itinerary and cached in raw/, so a re-emit that only needs to
  // pick up new dates can run fully offline. Launch a browser ONLY if something is still uncached.
  const needFetch = itins.filter((it) => !fs.existsSync(cacheFileFor(it)));
  let browser = null, rc = null;
  if (needFetch.length) {
    if (!fs.existsSync(STATE_PATH)) throw new Error(`No session for ${needFetch.length} uncached itineraries — run auth-portal.mjs --line carnival … first.`);
    // GoCCL is a clean JSON API (no Akamai), so we GET each itinerary directly with the session
    // cookies via the context's request API — no page navigation needed.
    browser = await chromium.launch({ headless: Boolean(args.headless), channel: "chrome" });
    const context = await browser.newContext({ storageState: STATE_PATH });
    rc = context.request;
    console.log(`  ${needFetch.length} uncached → fetching from the portal; ${itins.length - needFetch.length} from cache.`);
  } else {
    console.log("  All itineraries cached — offline re-emit, no portal session needed.");
  }

  const shipsById = new Map(), portsById = new Map(), itineraries = [], sailingsOut = [];
  let ok = 0, failed = 0;
  for (const [i, it] of itins.entries()) {
    const cacheFile = cacheFileFor(it);
    let json;
    try {
      if (fs.existsSync(cacheFile)) {
        json = JSON.parse(fs.readFileSync(cacheFile, "utf8"));
      } else {
        const qs = new URLSearchParams({ duration: it.duration, embarkationPortCode: it.embarkationPortCode,
          itineraryCode: it.itineraryCode, sailDate: it.sailDate, shipCode: it.shipCode }).toString();
        const res = await rc.get(`${ORIGIN}/app/bookingengine/api/v1.0/itinerary?${qs}`, {
          headers: { accept: "application/json", referer: `${ORIGIN}/app/cruise-search` },
        });
        if (!res.ok()) throw new Error(`HTTP ${res.status()}`);
        json = await res.json();
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(json));
        await sleep(delay);
      }
      const ex = extractItinerary(json);
      if (!ex) { failed++; console.warn(`  ! ${it.itineraryCode}: no schedule`); continue; }
      shipsById.set(ex.ship.id, ex.ship);
      for (const p of ex.ports) if (!portsById.has(p.id)) portsById.set(p.id, p);
      // Make the itinerary id unique per ROUTE key (code + embark + duration), not per code — a code
      // can recur with a different embark/length, and collapsing those to one id would double-count
      // dates in mapCompass. This keeps each distinct route its own entry.
      const itinId = `carnival:itin:${it.itineraryCode}-${it.embarkationPortCode}-${it.duration}`;
      ex.itinerary.id = itinId;
      itineraries.push(ex.itinerary);
      // One sailing per departure DATE (all referencing this route): mapCompass groups them back by
      // itinerary_id and emits a single route carrying every date in `dates[]`.
      for (const dt of it.dates) {
        sailingsOut.push({
          id: `carnival:sailing:${it.itineraryCode}-${it.embarkationPortCode}-${it.duration}-${dt}`,
          line: "carnival", itinerary_id: itinId, ship_id: ex.ship.id, depart_date: dt, status: "on_sale",
        });
      }
      ok++;
      console.log(`  ✓ [${i + 1}/${itins.length}] ${it.itineraryCode} ${ex.ship.name || ""} — ${ex.itinerary.name} (${it.dates.length} dates)`);
    } catch (e) { failed++; console.warn(`  ! ${it.itineraryCode}: ${e.message}`); }
  }
  if (browser) await browser.close();
  console.log(`Fetched ${ok} ok, ${failed} failed — ${sailingsOut.length} departures across ${ok} itineraries.`);

  const obj = mapCompass(
    { itineraries, ships: [...shipsById.values()], sailings: sailingsOut, ports: [...portsById.values()] },
    { line: "carnival", generated, source: "cruise-line-scraper: carnival (GoCCL itinerary API)" },
  );
  validateOutput(obj);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `carnival-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`Wrote ${path.relative(ROOT, outPath)} — ${obj.itineraries.length} itineraries`);
}

export { extractItinerary, enumerateFromSamples };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
