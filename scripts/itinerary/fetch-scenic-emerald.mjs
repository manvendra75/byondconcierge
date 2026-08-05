#!/usr/bin/env node
// fetch-scenic-emerald.mjs — acquire the "Scenic & Emerald" line's river/ocean cruises with day-by-day.
//
// The two sister brands run parallel Next.js sites — scenic.cruises (brand=st) and emerald.cruises
// (brand=ec) — that each server-render the itinerary in the tour-page HTML and share the scenic-catalog
// departures API. Both sites' base tour pages are robots-ALLOWED (only the ?d= / _rsc= / quote-context= /
// sessionGUID= query variants are disallowed — we never use those). Plain HTTP fetches, no browser:
//   • sitemap (…/sitemaps/<region>) → every /tours/<code> URL (enumeration).
//   • GET /tours/<code>              → name + day-by-day (Day N + port, parsed from the HTML).
//   • GET /api/scenic-catalog/v1/departures?...&brand=<st|ec>&products=<CODE> → sailing dates, nights,
//     product line, destination. Land/Touring (non-"cruise" productLine) is skipped; only cruises kept.
//
// Both brands are enumerated and combined into ONE snapshot (the combined catalogue line). No prices are
// read. Ship names aren't published per-tour, so a generic per-brand/class label is used.
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-scenic-emerald.mjs                 # full: Scenic + Emerald (both brands)
//   node scripts/itinerary/fetch-scenic-emerald.mjs --limit 20      # quick test (both brands, 20 each)
//   node scripts/itinerary/fetch-scenic-emerald.mjs --base https://emerald.cruises --brand ec \
//        --ship-river "Emerald Star-Ship" --ship-ocean "Emerald yacht" --line emerald-probe  # one brand

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

// The two sister brands of the "Scenic & Emerald" line. Each is a parallel Next.js site
// (scenic.cruises / emerald.cruises) that server-renders the day-by-day in its tour pages and
// shares the scenic-catalog departures API (brand=st Scenic, brand=ec Emerald). Both are enumerated
// and combined into ONE snapshot, matching the combined catalogue line.
const BRANDS = [
  { base: "https://scenic.cruises",  brand: "st", shipRiver: "Scenic Space-Ship", shipOcean: "Scenic Eclipse" },
  { base: "https://emerald.cruises", brand: "ec", shipRiver: "Emerald Star-Ship", shipOcean: "Emerald yacht" },
];

// Fetch every cruise itinerary for one brand: sitemap → per-tour (page day-by-day + departures API).
async function fetchBrand(cfg, { region, market, limit, delay }) {
  const itineraries = [];
  const unmappedDest = new Set();
  let done = 0, skippedLand = 0, noDates = 0, failed = 0;

  // ---- 1) Enumerate tour codes from the sitemap ----
  const sitemap = await get(`${cfg.base}/sitemaps/${region}`);
  const codes = [...new Set([...sitemap.matchAll(/\/tours\/([a-z0-9]{3,6})(?=["'<\s?])/gi)].map((m) => m[1].toLowerCase()))];
  console.log(`[${cfg.brand}] sitemap: ${codes.length} tour codes.`);

  // ---- 2) Per tour: page (name + day-by-day) + departures (dates, nights, line, destination) ----
  for (const code of codes.slice(0, limit)) {
    try {
      const [page, dep] = await Promise.all([
        get(`${cfg.base}/${region}/tours/${code}`),        // tour PAGE is region-scoped
        get(`${cfg.base}/api/scenic-catalog/v1/departures?market=${market}&brand=${cfg.brand}&pageSize=100&products=${code.toUpperCase()}`, true),
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
        ship: river ? cfg.shipRiver : cfg.shipOcean,
        name,
        nights,
        departPort: days[0]?.port,
        arrivePort: days.length ? days[days.length - 1].port : days[0]?.port,
        ...(dest ? { dest } : {}),
        days,
        dates,
      });
    } catch (e) { failed++; if (failed <= 5) console.log(`  ! [${cfg.brand}] ${code}: ${e.message.slice(0, 60)}`); }
    if (++done % 40 === 0) console.log(`  [${cfg.brand}] ${done}/${Math.min(codes.length, limit)} (cruises ${itineraries.length}, land ${skippedLand}, no-dates ${noDates}, fail ${failed})`);
    await sleep(delay);
  }

  if (unmappedDest.size) console.log(`[${cfg.brand}] unmapped dest (omitted): ${[...unmappedDest].slice(0, 10).join(" | ")}${unmappedDest.size > 10 ? " …" : ""}`);
  console.log(`[${cfg.brand}] ${itineraries.length} cruises · skipped ${skippedLand} land / ${noDates} no-dates · ${failed} failed`);
  return itineraries;
}

async function main() {
  const region = arg("region", "EU/en-GB");
  const market = arg("market", "eu");
  const line = arg("line", "scenic-emerald");
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const delay = Number(arg("delay", 120));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  // Default: both sister brands into the combined "Scenic & Emerald" line. A single --base/--brand
  // (plus --ship-river/--ship-ocean) overrides to one brand — used for probes/tests.
  const brands = arg("base")
    ? [{ base: arg("base"), brand: arg("brand", "st"), shipRiver: arg("ship-river", "Scenic Space-Ship"), shipOcean: arg("ship-ocean", "Scenic Eclipse") }]
    : BRANDS;

  const itineraries = [];
  for (const cfg of brands) itineraries.push(...await fetchBrand(cfg, { region, market, limit, delay }));

  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = {
    generated, line,
    source: "scenic.cruises + emerald.cruises scenic-catalog: tour pages (day-by-day) + departures API (no prices)",
    itineraries,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `${line}-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} cruise itineraries · ${departures} departures across ${brands.length} brand(s)`);
}

main().catch((e) => { console.error(e); process.exit(1); });
