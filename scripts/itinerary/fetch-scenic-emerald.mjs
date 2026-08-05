#!/usr/bin/env node
// fetch-scenic-emerald.mjs — acquire Scenic (& Emerald) river/ocean cruises with day-by-day.
//
// scenic.cruises serves the itinerary in each tour page's server-rendered HTML, and dates via a JSON
// departures API. Both are robots-ALLOWED (only the ?d= / _rsc= / quote-context= query variants are
// disallowed — we never use those). Plain HTTP fetches, no browser:
//   • sitemap (…/sitemaps/<region>) → every /tours/<code> URL (enumeration).
//   • GET /tours/<code>              → name + day-by-day (Day N + port, parsed from the HTML).
//   • GET /api/scenic-catalog/v1/departures?...&products=<CODE> → sailing dates, nights, product line,
//     destination. Land tours (productLine "Land") are skipped; only cruises are kept.
//
// No prices are read (the pricing in the departures response is ignored). Ship names aren't published
// per-tour, so a generic per-line ship label is used (matches the prior catalogue).
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-scenic-emerald.mjs                 # full (Scenic, ~565 tours)
//   node scripts/itinerary/fetch-scenic-emerald.mjs --limit 20      # quick test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { scenicDest } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || "").replace(/&gt;/g, ">").replace(/&lt;/g, "<").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

async function get(url, asJson = false) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: asJson ? "application/json" : "text/html" } });
  if (!r.ok) throw new Error(`HTTP ${r.status} for ${url}`);
  return asJson ? r.json() : r.text();
}

// Parse the numbered day-by-day out of a tour page's HTML: each "Day N" label is followed by the
// day's port in an <h4><button>…</button>. A day with no port call reads as a sea/cruising day.
function parseDays(html) {
  const days = [];
  const re = /Day\s+(\d+)<\/span>[\s\S]{0,400}?<button[^>]*>([^<]+)<\/button>/g;
  let m;
  while ((m = re.exec(html))) {
    // Strip a trailing cruise-title suffix the embark day sometimes carries
    // ("Ho Chi Minh City > 9 Night Mekong Cruise" -> "Ho Chi Minh City").
    const port = decode(m[2]).replace(/\s*>\s*\d+\s*(?:night|day)s?\b.*$/i, "").trim();
    const sea = /\bat sea\b|cruising the|day at sea|sea day/i.test(port);
    days.push({ day: Number(m[1]), port: sea ? "At Sea" : port, is_sea_day: sea });
  }
  // de-dupe by day number (keep first), sort
  const seen = new Set();
  return days.filter((d) => (seen.has(d.day) ? false : seen.add(d.day))).sort((a, b) => a.day - b.day);
}

async function main() {
  const base = arg("base", "https://scenic.cruises");
  const region = arg("region", "EU/en-GB");
  const market = arg("market", "eu");
  const brand = arg("brand", "st");
  const line = arg("line", "scenic-emerald");
  const shipRiver = arg("ship-river", "Scenic Space-Ship");
  const shipOcean = arg("ship-ocean", "Scenic Eclipse");
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const delay = Number(arg("delay", 120));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  // ---- 1) Enumerate tour codes from the sitemap ----
  const sitemap = await get(`${base}/sitemaps/${region}`);
  const codes = [...new Set([...sitemap.matchAll(/\/tours\/([a-z0-9]{3,6})(?=["'<\s?])/gi)].map((m) => m[1].toLowerCase()))];
  console.log(`Sitemap: ${codes.length} tour codes.`);

  // ---- 2) Per tour: page (name + day-by-day) + departures (dates, nights, line, destination) ----
  const itineraries = [];
  const unmappedDest = new Set();
  let done = 0, skippedLand = 0, noDates = 0, failed = 0;
  for (const code of codes.slice(0, limit)) {
    try {
      const [page, dep] = await Promise.all([
        get(`${base}/${region}/tours/${code}`),           // tour PAGE is region-scoped
        get(`${base}/api/scenic-catalog/v1/departures?market=${market}&brand=${brand}&pageSize=100&products=${code.toUpperCase()}`, true),
      ]);
      const items = dep.items || [];
      if (!items.length) { noDates++; continue; }
      const productLine = items[0].productLine || "";
      if (!/cruis/i.test(productLine)) { skippedLand++; continue; }     // skip Land / non-cruise tours

      const name = decode((page.match(/<title>([^<]+)<\/title>/) || [])[1]).replace(/\s*\|\s*(Scenic|Emerald).*$/i, "");
      const days = parseDays(page);
      const dates = [...new Set(items.map((i) => (i.departureDate || "").slice(0, 10)))].filter(Boolean).sort();
      if (!dates.length) { noDates++; continue; }
      const nights = Math.round((new Date(items[0].returnDate) - new Date(items[0].departureDate)) / 86400000) || (days.length - 1);
      const productDestination = items[0].productDestination;
      const dest = scenicDest(productLine, productDestination, name);
      if (!dest) unmappedDest.add(`${productLine}/${productDestination}/${name.slice(0, 30)}`);
      const river = /river/i.test(productLine);

      itineraries.push({
        ship: river ? shipRiver : shipOcean,
        name,
        nights,
        departPort: days[0]?.port,
        arrivePort: days.length ? days[days.length - 1].port : days[0]?.port,
        ...(dest ? { dest } : {}),
        days,
        dates,
      });
    } catch (e) { failed++; if (failed <= 5) console.log(`  ! ${code}: ${e.message.slice(0, 60)}`); }
    if (++done % 40 === 0) console.log(`  ${done}/${Math.min(codes.length, limit)} (cruises ${itineraries.length}, land ${skippedLand}, no-dates ${noDates}, fail ${failed})`);
    await sleep(delay);
  }

  if (unmappedDest.size) console.log(`Unmapped dest (omitted): ${[...unmappedDest].slice(0, 10).join(" | ")}${unmappedDest.size > 10 ? " …" : ""}`);
  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = { generated, line, source: `${base} scenic-catalog: tour pages (day-by-day) + departures API (no prices)`, itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${line}-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} cruise itineraries · ${departures} departures · skipped ${skippedLand} land / ${noDates} no-dates · ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
