#!/usr/bin/env node
// TC.5b — Silversea day-by-day importer (headless, schedulable).
//
// The survey (skills/cruise-line-scraper/workdir/silversea/survey.md) found that Silversea's
// day-by-day lives in a static Gatsby page-data.json endpoint — so the bulk run needs NO browser,
// just plain HTTP GETs. This script is the deterministic unit a scheduled job runs off-peak:
//
//   enumerate current voyages (sitemap) -> throttled + cached fetch of each page-data.json ->
//   extract to the skill's Compass canonical -> map via from-compass.mjs -> write
//   docs/research/cruise-lines/silversea-itineraries-<date>.json
//
// Compliance (per the registry): robots permits these pages; we self-throttle (default 1 req / 3 s),
// identify honestly, and CACHE every raw response so re-runs skip unchanged voyages (idempotent).
// NO prices are read — only the day-by-day.
//
//   node scripts/itinerary/fetch-silversea.mjs [--limit N] [--delay 3000] [--date YYYY-MM-DD]
//                                              [--out <dir>] [--cache <dir>]
// --limit is for testing (fetch only N voyages); omit for the full run.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { silverseaDest } from "./classify.mjs";
import { mapCompass, validateOutput } from "./from-compass.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");                 // -> Marketing
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const CACHE_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "silversea", "raw");

const ORIGIN = "https://www.silversea.com";
const SITEMAP = `${ORIGIN}/sitemap-en.xml`;
const UA = "ByondCompassBot/1.0 (+ops@byondborders.com)";
// A voyage detail URL: /destinations/<region>-cruise/<route>-<code>.html — the trailing code is
// 2 ship letters + a date-ish digit run (e.g. mo270603007, ss260830s05). Region index pages
// (/destinations/<region>-cruise.html, one segment) are excluded by requiring the second segment.
const VOYAGE_RE = /\/destinations\/[^/]+-cruise\/[^/]+-[a-z]{2}\d{6}[a-z]?\d*\.html$/i;

// ---------------------------------------------------------------------------------------
// Small helpers
// ---------------------------------------------------------------------------------------
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// CMS text carries HTML entities (e.g. "Greece &amp; Turkey"); decode them so a name matches the
// sailings record it will merge onto in TC.6 (the merge keys on name).
const decode = (s) => String(s || "")
  .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
  .replace(/&quot;/g, '"').replace(/&#0?39;|&apos;/g, "'").replace(/&nbsp;/g, " ").trim();
// Silversea localizes some fields as {localized: value}; others are plain strings. Handle both,
// then decode entities.
const loc = (x) => decode(x && typeof x === "object" && "localized" in x ? x.localized : x);
const slug = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
// A scenic-cruising / sea day: Silversea names these "Cruise <place>" (e.g. "Cruise Hubbard Glacier").
const SEA_RE = /^\s*(?:scenic\s+)?cruis(?:e|ing)\b|^\s*(?:day\s+)?at sea\b/i;

async function fetchText(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA } });
  if (!r.ok) throw new Error(`GET ${url} -> ${r.status}`);
  return r.text();
}

// ---------------------------------------------------------------------------------------
// Enumerate current voyage URLs from the sitemap (source 1 in the registry)
// ---------------------------------------------------------------------------------------
// The committed dataset's URLs are stale (past sailings redirect), so the live voyage list comes
// from the sitemap. sitemap-en.xml may be a flat URL set or an index of nested sitemaps; handle one
// level of nesting, then keep only voyage detail URLs.
async function enumerateVoyages() {
  const locs = (xml) => [...xml.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1].trim());
  const top = locs(await fetchText(SITEMAP));
  const nested = top.filter((u) => u.endsWith(".xml"));
  let urls = top.filter((u) => !u.endsWith(".xml"));
  for (const sm of nested) {
    try { urls.push(...locs(await fetchText(sm))); } catch { /* skip a bad child sitemap */ }
  }
  const voyages = [...new Set(urls.filter((u) => VOYAGE_RE.test(u)))];
  return voyages;
}

// ---------------------------------------------------------------------------------------
// Fetch one voyage's page-data.json (cached) and return the cruise data block
// ---------------------------------------------------------------------------------------
async function fetchVoyage(voyageUrl, { delay, cacheDir }) {
  const pathname = new URL(voyageUrl).pathname;                 // /destinations/.../<code>.html
  const code = (pathname.match(/-([a-z]{2}\d{6}[a-z]?\d*)\.html$/i) || [])[1] || slug(pathname);
  const cacheFile = path.join(cacheDir, `${code}.json`);
  if (fs.existsSync(cacheFile)) {                              // idempotent: skip re-fetch
    return JSON.parse(fs.readFileSync(cacheFile, "utf8"));
  }
  const pageDataUrl = `${ORIGIN}/page-data${pathname}/page-data.json`;
  const json = JSON.parse(await fetchText(pageDataUrl));
  fs.mkdirSync(cacheDir, { recursive: true });
  fs.writeFileSync(cacheFile, JSON.stringify(json));           // raw layer / provenance
  await sleep(delay);                                          // politeness (only on a real fetch)
  return json;
}

// ---------------------------------------------------------------------------------------
// Extract one voyage's cruise data into Compass canonical fragments
// ---------------------------------------------------------------------------------------
// Returns { ship, ports:[], itinerary, sailing } — the pieces to accumulate + dedupe across voyages.
// No price is touched: only itinerary[].{dayNumber,date,port} and the ship/nights/name header.
function extractVoyage(json, voyageUrl) {
  const c = json?.result?.data?.cruise?.data;
  if (!c || !Array.isArray(c.itinerary) || !c.itinerary.length) return null;
  const code = c.cruiseCode || (voyageUrl.match(/-([a-z0-9]+)\.html$/i) || [])[1];
  const shipName = loc(c.ship?.name) || null;
  const shipId = `silversea:ship:${slug(shipName)}`;

  const ports = [];
  const days = [];
  for (const d of c.itinerary) {
    const rawName = loc(d.port?.name) || "";
    const isSea = SEA_RE.test(rawName);
    // For a sea day keep the place minus the "Cruise/Cruising" verb (like Crystal); a bare at-sea -> "At Sea".
    const name = isSea ? (rawName.replace(/^\s*(?:scenic\s+)?cruis(?:e|ing)\s+/i, "").trim() || "At Sea") : rawName;
    const portCode = d.port?.data?.code || slug(name);
    const portId = `silversea:port:${slug(portCode)}`;
    ports.push({ id: portId, line: "silversea", name });
    days.push({ day: d.dayNumber, port_id: portId, is_sea_day: isSea });
  }

  const departDate = c.itinerary[0].date;
  const returnDate = c.itinerary[c.itinerary.length - 1].date;
  // Safety: the adapter DERIVES per-day dates as depart+(day-1); assert Silversea's real dates agree,
  // so we never ship a wrong date if a source ever breaks the one-calendar-day-per-day assumption.
  for (const d of c.itinerary) {
    const derived = new Date(Date.UTC(...departDate.split("-").map(Number).map((n, i) => (i === 1 ? n - 1 : n))));
    derived.setUTCDate(derived.getUTCDate() + (d.dayNumber - 1));
    if (d.date && derived.toISOString().slice(0, 10) !== d.date) {
      throw new Error(`${code}: day ${d.dayNumber} real date ${d.date} != derived — needs real-date passthrough`);
    }
  }

  const itinName = loc(c.multilingualCruiseName) || loc(c.name) || code;
  // Group departures of the SAME route under one itinerary id (ship + name + nights + endpoints), so
  // mapCompass collapses the many voyages of a route into ONE entry carrying every date in `dates[]`
  // — the coverage upgrade, exactly as Carnival does. The per-voyage `code` stays the unique sailing
  // id. (The main loop dedupes the repeated itinerary template by this id.)
  const routeId = `silversea:itin:${slug(`${shipName}|${itinName}|${c.days}|${days[0]?.port_id}|${days[days.length - 1]?.port_id}`)}`;
  // Canonical destination from the voyage's tagged destination (TD.5). Throws on an unmapped value
  // (a new Silversea destination), surfacing it rather than silently dropping the voyage.
  const dest = silverseaDest(c.destination?.name?.en);
  return {
    ship: { id: shipId, line: "silversea", name: shipName },
    ports,
    itinerary: {
      id: routeId, line: "silversea", name: itinName, dest,
      ship_id: shipId, nights: c.days, embark_port_id: days[0]?.port_id,
      source_url: voyageUrl, days,
    },
    sailing: {
      id: `silversea:sailing:${code}`, line: "silversea",
      itinerary_id: routeId, ship_id: shipId,
      depart_date: departDate, return_date: returnDate, status: "on_sale", source_url: voyageUrl,
    },
  };
}

// ---------------------------------------------------------------------------------------
// Main — enumerate, fetch (throttled/cached), accumulate, map, validate, write
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const a = {};
  for (let i = 0; i < argv.length; i += 2) a[argv[i].replace(/^--/, "")] = argv[i + 1];
  return a;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const delay = Number(args.delay ?? 3000);
  const limit = args.limit ? Number(args.limit) : Infinity;
  const outDir = args.out || OUT_DIR;
  const cacheDir = args.cache || CACHE_DIR;
  const generated = args.date || new Date().toISOString().slice(0, 10);

  // --from-cache: re-emit entirely from the raw cache (no sitemap, no network) — used to rebuild the
  // snapshot after a code change (e.g. a new field) without re-hitting silversea.com.
  const fromCache = "from-cache" in args;
  let voyages;
  if (fromCache) {
    voyages = fs.readdirSync(cacheDir).filter((f) => f.endsWith(".json")).slice(0, limit).map((f) => path.join(cacheDir, f));
    console.log(`Offline re-emit: ${voyages.length} cached voyages from ${path.relative(ROOT, cacheDir)}`);
  } else {
    console.log("Enumerating current Silversea voyages from the sitemap…");
    voyages = (await enumerateVoyages()).slice(0, limit);
    console.log(`  ${voyages.length} voyage URLs to import (delay ${delay}ms, cache ${path.relative(ROOT, cacheDir)})`);
  }

  // Accumulate Compass arrays, de-duping ships and ports by id across voyages.
  const shipsById = new Map(), portsById = new Map(), itineraries = [], sailings = [];
  const seenItin = new Set();
  let ok = 0, skipped = 0, failed = 0;
  for (const [i, src] of voyages.entries()) {
    try {
      const json = fromCache ? JSON.parse(fs.readFileSync(src, "utf8")) : await fetchVoyage(src, { delay, cacheDir });
      const ex = extractVoyage(json, fromCache ? `cache://${path.basename(src)}` : src);
      if (!ex) { skipped++; continue; }
      shipsById.set(ex.ship.id, ex.ship);
      for (const p of ex.ports) if (!portsById.has(p.id)) portsById.set(p.id, p);
      // One itinerary template per route (dedupe by id); every voyage still contributes its sailing,
      // so mapCompass gathers all of a route's dates into `dates[]`.
      if (!seenItin.has(ex.itinerary.id)) { itineraries.push(ex.itinerary); seenItin.add(ex.itinerary.id); }
      sailings.push(ex.sailing);
      ok++;
      if ((i + 1) % 25 === 0) console.log(`  …${i + 1}/${voyages.length}`);
    } catch (e) {
      failed++;
      console.warn(`  ! ${src}: ${e.message}`);
    }
  }
  console.log(`Fetched: ${ok} ok, ${skipped} no-itinerary, ${failed} failed`);

  // Map the accumulated Compass extract through the shared adapter, then hard-validate before write.
  const obj = mapCompass(
    { itineraries, ships: [...shipsById.values()], sailings, ports: [...portsById.values()] },
    { line: "silversea", generated, source: "cruise-line-scraper: silversea (silversea.com page-data)" },
  );
  validateOutput(obj);

  fs.mkdirSync(outDir, { recursive: true });
  const outPath = path.join(outDir, `silversea-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`Wrote ${path.relative(ROOT, outPath)} — ${obj.itineraries.length} itineraries`);
}

export { extractVoyage, CACHE_DIR };

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main().catch((e) => { console.error(e); process.exit(1); });
