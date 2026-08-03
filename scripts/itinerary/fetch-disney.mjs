#!/usr/bin/env node
// TC.5b — Disney day-by-day importer (authenticated, session-based).
//
// Disney's day-by-day lives in the agent portal's cruise-details response
// (cruiseDetailsResponse.cruiseSailingsListResource) which the page fires on load. Unlike Silversea
// there is no plain static endpoint, so this importer drives a browser using the session captured by
// auth-disney.mjs (never credentials): for each sailing it loads the detail page, captures the
// cruise-details JSON, and extracts ONLY the itinerary (never the co-located prices).
//
//   node scripts/itinerary/fetch-disney.mjs [--limit N] [--delay 3000] [--date YYYY-MM-DD]
//                                           [--codes WT0101,DW2216] [--region INTL]
// Requires: a valid session (run auth-disney.mjs first) and playwright (npm i -D playwright).
//
// Enumeration note: the public sitemap lists only a few FUTURE sailings (it is stale), so by default
// we import those. A complete current list needs the portal's cruise-search API (a later survey);
// pass --codes to import specific sailings meanwhile.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

import { mapCompass, validateOutput } from "./from-compass.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DISNEY_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "disney");
const STATE_PATH = path.join(DISNEY_DIR, ".auth", "storageState.json");
const SAMPLES_DIR = path.join(DISNEY_DIR, "samples");   // captured available-products search responses
const URLS_PATH = path.join(DISNEY_DIR, "disney-urls.json");   // real detail URLs harvested by the search survey
const CACHE_DIR = path.join(DISNEY_DIR, "raw");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const ORIGIN = "https://disneycruise.disney.go.com";
const UA = "ByondCompassBot/1.0 (+ops@byondborders.com)";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const codeOf = (entityId) => String(entityId || "").split(";")[0];   // "556;entityType=…" -> "556"
const nameOf = (o) => (o && (typeof o.name === "string" ? o.name : o.name?.localized)) || null;
// A sea day: Disney marks these portCode 558 / name "Day at Sea" / sailEventType "AT SEA".
const isSea = (portName, evt) => /day at sea|at sea/i.test(portName || "") || /AT SEA/i.test(evt || "");

// ---------------------------------------------------------------------------------------
// Enumerate future sailings (code + detail URL) from the sitemap
// ---------------------------------------------------------------------------------------
async function enumerateSailings(today) {
  const xml = await (await fetch(`${ORIGIN}/sitemap.xml`, { headers: { "User-Agent": UA } })).text();
  const urls = [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1])
    .filter((u) => /\/cruises-destinations\/list\//.test(u));
  const out = [];
  for (const url of urls) {
    const m = url.match(/\/list\/([A-Z0-9]+)\/[^/]+\/(\d{4}-\d{2}-\d{2})-Disney-/);
    if (m && m[2] > today) out.push({ code: m[1], date: m[2], url });     // future only
  }
  return out.sort((a, b) => a.date.localeCompare(b.date));
}

// ---------------------------------------------------------------------------------------
// Enumerate EVERY sailing (all dates) from the captured search responses (TD.16)
// ---------------------------------------------------------------------------------------
// The portal's cruise-search (survey-disney-search.mjs) saved its `available-products` responses to
// samples/. The search groups by product (~92) but lists EVERY sailing under each product's
// `itineraries[].sailings[]` (680 total). Each sailing's own date lives only in its cruise-details
// response, so — for FULL date coverage (TD.16) — we enumerate all 680 sailingIds and fetch each; the
// builder then groups a product's sailings into one route carrying every date in `dates[]`. The
// sailingId IS the detail-endpoint code (verified: the cached codes are all search sailingIds), and
// the SPA fires get-cruise-details-availability/<code> off the code segment of the URL, so the
// title/date-ship path segments are cosmetic placeholders.
function enumerateFromSamples() {
  if (!fs.existsSync(SAMPLES_DIR)) return [];
  const byCode = new Map();                                  // dedupe by sailingId across search pages
  for (const f of fs.readdirSync(SAMPLES_DIR).filter((x) => /^search-\d+-hit\.json$/.test(x))) {
    let j; try { j = JSON.parse(fs.readFileSync(path.join(SAMPLES_DIR, f), "utf8")); } catch { continue; }
    for (const p of j.products || []) {
      const title = (p.productName || "cruise").trim().replace(/\s+/g, "-");
      for (const it of p.itineraries || []) {
        for (const s of it.sailings || []) {
          if (!s.sailingId || byCode.has(s.sailingId)) continue;
          byCode.set(s.sailingId, {
            code: s.sailingId, product: p.productName,
            url: `${ORIGIN}/cruises-destinations/list/${s.sailingId}/${title}/x-Disney-x/`,
          });
        }
      }
    }
  }
  return [...byCode.values()];
}

// ---------------------------------------------------------------------------------------
// Enumerate ONE representative detail URL per product, from the harvested search-result links
// ---------------------------------------------------------------------------------------
// disney-urls.json holds the real detail URLs (/list/<code>/<title>/<date>-Disney-<ship>/) from the
// search. Sailings of the same product (same <title> slug) share a day-by-day, so we keep one URL
// per title — ~92 pages instead of 680. Each is a REAL page whose own cruise-details call we capture.
function enumerateFromUrls() {
  if (!fs.existsSync(URLS_PATH)) return [];
  const urls = JSON.parse(fs.readFileSync(URLS_PATH, "utf8"));
  const byProduct = new Map();
  for (const url of urls) {
    const m = url.match(/\/list\/([A-Z0-9]+)\/([^/]+)\//i);   // [_, code, title-slug]
    if (m && !byProduct.has(m[2])) byProduct.set(m[2], { code: m[1], url });
  }
  return [...byProduct.values()];
}

// ---------------------------------------------------------------------------------------
// Extract one sailing's cruise-details JSON into Compass canonical fragments
// ---------------------------------------------------------------------------------------
function extractSailing(json, code, voyageUrl) {
  const res = json?.cruiseDetailsResponse?.cruiseSailingsListResource;
  if (!res) return null;
  // Build code -> name maps from the co-delivered ports / ships / products resources.
  const portName = {}, shipName = {}, productName = {};
  for (const p of Object.values(res.ports || {})) if (p?.id) portName[codeOf(p.id)] = nameOf(p);
  for (const sh of Object.values(res.ships || {})) if (sh?.id) shipName[codeOf(sh.id)] = nameOf(sh);
  for (const pr of Object.values(res.products || {})) if (pr?.id) productName[codeOf(pr.id)] = nameOf(pr);

  const sailKey = Object.keys(res.sailings || {}).find((k) => codeOf(k) === code) || Object.keys(res.sailings || {})[0];
  const s = res.sailings?.[sailKey];
  if (!s || !s.itinerary) return null;

  // One entry per day: take the day's first event for the date, resolve the port, flag sea days.
  const days = [];
  const ports = [];
  for (const dayKey of Object.keys(s.itinerary).sort((a, b) => Number(a) - Number(b))) {
    const det = (s.itinerary[dayKey].itineraryDetails || [])[0];
    if (!det) continue;
    const pc = codeOf(det.portCode);
    const nm = portName[pc] || pc;
    const sea = isSea(nm, det.sailEventType);
    const portId = `disney:port:${pc}`;
    ports.push({ id: portId, line: "disney", name: sea ? "At Sea" : nm });
    days.push({ day: Number(dayKey), port_id: portId, is_sea_day: sea });
  }
  if (!days.length) return null;

  const shipId = `disney:ship:${codeOf(s.ship)}`;
  const shipNm = shipName[codeOf(s.ship)] || null;
  // Round trips: portTo often equals portFrom; the last day's port is the true disembark.
  const departDate = s.itinerary["1"]?.itineraryDetails?.[0]?.itineraryDateTime?.slice(0, 10);
  const lastKey = Object.keys(s.itinerary).sort((a, b) => Number(b) - Number(a))[0];
  const returnDate = s.itinerary[lastKey]?.itineraryDetails?.[0]?.itineraryDateTime?.slice(0, 10);

  return {
    ship: { id: shipId, line: "disney", name: shipNm },
    ports,
    // Key the itinerary on the PRODUCT (not the per-sailing code) so every sailing of a product
    // groups into ONE route, and mapCompass gathers all their dates into `dates[]` (TD.16). Different
    // sailings of a Disney product share the same itinerary, so the first one's day template stands in.
    itinerary: {
      id: `disney:itin:${codeOf(s.product)}`, line: "disney",
      // The sailing's own `name` is just the departure date — the itinerary name is on its product.
      name: productName[codeOf(s.product)] || (voyageUrl.match(/\/list\/[A-Z0-9]+\/([^/]+)\//) || [])[1]?.replace(/-/g, " ") || code,
      ship_id: shipId, nights: s.numberOfNights, embark_port_id: days[0].port_id, source_url: voyageUrl, days,
    },
    sailing: {
      id: `disney:sailing:${code}`, line: "disney", itinerary_id: `disney:itin:${codeOf(s.product)}`, ship_id: shipId,
      depart_date: departDate, return_date: returnDate, status: "on_sale", source_url: voyageUrl,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Main — session browser, per-voyage capture (throttled/cached), map, validate, write
// ---------------------------------------------------------------------------------------
function parseArgs(argv) { const a = {}; for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1]; return a; }

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const delay = Number(args.delay ?? 3000);
  const region = args.region || "INTL";
  const generated = args.date || new Date().toISOString().slice(0, 10);
  const outDir = args.out || OUT_DIR;

  // Which sailings: explicit --codes, else ALL sailings from the captured search responses (TD.16 —
  // full date coverage), else the harvested detail URLs, else the stale sitemap. (The session check
  // is deferred below so an all-cached re-emit runs offline.)
  let sailings;
  if (args.codes) {
    sailings = args.codes.split(",").map((c) => ({ code: c.trim(), url: null }));
  } else {
    sailings = enumerateFromSamples();
    if (!sailings.length) sailings = enumerateFromUrls();
    if (!sailings.length) sailings = await enumerateSailings(generated);
  }
  if (args.limit) sailings = sailings.slice(0, Number(args.limit));
  const totalDepartures = sailings.length;
  console.log(`Importing ${totalDepartures} Disney sailings (delay ${delay}ms)…`);

  // Disney authorizes the cruise-details call ONLY in the context of loading that sailing's OWN page
  // (Akamai + per-sailing token), so uncached sailings are fetched by loading each detail URL headed
  // (headless is flagged as a bot) and capturing its get-cruise-details-availability response. Launch
  // the browser ONLY when something is uncached — an all-cached re-emit runs fully offline.
  const needFetch = sailings.filter((s) => !fs.existsSync(path.join(CACHE_DIR, `${s.code}-${region}.json`)));
  let browser = null, page = null;
  if (needFetch.length) {
    if (!fs.existsSync(STATE_PATH)) throw new Error(`No session for ${needFetch.length} uncached sailings — run auth-disney.mjs first (${path.relative(ROOT, STATE_PATH)}).`);
    browser = await chromium.launch({ headless: Boolean(args.headless), channel: "chrome" });
    const context = await browser.newContext({ storageState: STATE_PATH });
    page = await context.newPage();
    console.log(`  ${needFetch.length} uncached → fetching from the portal; ${totalDepartures - needFetch.length} from cache.`);
  } else {
    console.log("  All sailings cached — offline re-emit, no portal session needed.");
  }

  const shipsById = new Map(), portsById = new Map(), itineraries = [], sailingsOut = [];
  const itinById = new Set();                                // dedupe route templates (one per product)
  let ok = 0, failed = 0;
  for (const [i, sail] of sailings.entries()) {
    const cacheFile = path.join(CACHE_DIR, `${sail.code}-${region}.json`);
    let json;
    try {
      if (fs.existsSync(cacheFile)) {
        json = JSON.parse(fs.readFileSync(cacheFile, "utf8"));           // idempotent: reuse cached raw
      } else if (!sail.url) {
        throw new Error("no detail URL (run the search survey to harvest URLs, or pass a full --url)");
      } else {
        // Load the sailing's own page and capture the cruise-details response it fires.
        const respP = page.waitForResponse(
          (r) => r.url().includes(`get-cruise-details-availability/${sail.code}`) && r.status() === 200,
          { timeout: 45000 },
        );
        await page.goto(sail.url, { waitUntil: "domcontentloaded" }).catch(() => {});
        json = await (await respP).json();
        fs.mkdirSync(CACHE_DIR, { recursive: true });
        fs.writeFileSync(cacheFile, JSON.stringify(json));
        await sleep(delay);                                               // politeness on real fetches
      }
      const ex = extractSailing(json, sail.code, sail.url || "");
      if (!ex) { failed++; console.warn(`  ! ${sail.code}: no itinerary in response`); continue; }
      shipsById.set(ex.ship.id, ex.ship);
      for (const p of ex.ports) if (!portsById.has(p.id)) portsById.set(p.id, p);
      // One route template per product (dedupe); every sailing contributes its date, so mapCompass
      // gathers all of a product's dates into `dates[]`.
      if (!itinById.has(ex.itinerary.id)) { itineraries.push(ex.itinerary); itinById.add(ex.itinerary.id); }
      sailingsOut.push(ex.sailing); ok++;
      if ((i + 1) % 20 === 0 || i + 1 === totalDepartures) console.log(`  …${i + 1}/${totalDepartures} (${ok} ok, ${failed} failed)`);
    } catch (e) { failed++; console.warn(`  ! ${sail.code}: ${e.message}`); }
  }
  if (browser) await browser.close();
  console.log(`Fetched ${ok} ok, ${failed} failed — ${sailingsOut.length} departures across ${itinById.size} routes.`);

  const obj = mapCompass(
    { itineraries, ships: [...shipsById.values()], sailings: sailingsOut, ports: [...portsById.values()] },
    { line: "disney", generated, source: "cruise-line-scraper: disney (agent portal cruise-details)" },
  );
  validateOutput(obj);
  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `disney-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`Wrote ${path.relative(ROOT, outPath)} — ${obj.itineraries.length} itineraries`);
}

// Exported for offline verification against saved samples (no session needed).
export { extractSailing, enumerateSailings, enumerateFromSamples, enumerateFromUrls };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
