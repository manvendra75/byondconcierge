#!/usr/bin/env node
// fetch-royal-caribbean.mjs — acquire Royal Caribbean's catalogue + day-by-day from the public site.
//
// Public site, no login. RCL's React frontend uses a GraphQL endpoint (POST /cruises/graph). robots.txt
// permits the itinerary content; we never touch the disallowed /booking, /room-selection, /mycruises,
// /flights paths. One paginated query (CruisesSearchResults) returns every cruise with its ship, nights,
// destination, embark port, FULL day-by-day (days[].type CRUISING == sea day), and all sailing dates.
//
// A minimal query is sent (only the itinerary fields — no pricing/casino selections), through a real
// (Playwright) browser on the royalcaribbean.com origin so Akamai serves it like the site's frontend.
// No prices are read.
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-royal-caribbean.mjs               # full (~930 cruises)
//   node scripts/itinerary/fetch-royal-caribbean.mjs --limit 30    # quick test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { rclDest } from "./classify.mjs";

const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const ENDPOINT = "https://www.royalcaribbean.com/cruises/graph";

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Minimal GraphQL — only the itinerary fields we need (the master carries the full day-by-day).
const QUERY = `query CruisesSearchResults($sort: CruiseSearchSort, $pagination: CruiseSearchPagination) {
  cruiseSearch(sort: $sort, pagination: $pagination) {
    results {
      total
      cruises {
        id
        masterSailing {
          itinerary {
            name
            totalNights
            destination { code name }
            departurePort { code name }
            ship { code name }
            days { number type ports { port { code name } } }
          }
        }
        sailings { sailDate }
      }
    }
  }
}`;

async function graph(page, variables) {
  return await page.evaluate(async ({ endpoint, query, variables }) => {
    const r = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ operationName: "CruisesSearchResults", query, variables }),
      credentials: "include",
    });
    return { status: r.status, text: await r.text() };
  }, { endpoint: ENDPOINT, query: QUERY, variables });
}

// One page with retry. GraphQL `errors` = a real query bug (throw). A 5xx/429/timeout is transient —
// retry with backoff; return null after the last try so the caller skips just that page, not the run.
async function fetchPage(page, variables, tries = 4) {
  for (let t = 0; t < tries; t++) {
    try {
      const { status, text } = await graph(page, variables);
      if (status === 200) {
        const json = JSON.parse(text);
        if (json.errors) throw Object.assign(new Error(`GraphQL errors: ${JSON.stringify(json.errors).slice(0, 300)}`), { fatal: true });
        return json.data?.cruiseSearch?.results || null;
      }
      if (status < 500 && status !== 429) throw Object.assign(new Error(`HTTP ${status}`), { fatal: true });
    } catch (e) {
      if (e.fatal) throw e;                       // query bug — don't mask it
    }
    if (t < tries - 1) { const wait = 1500 * (t + 1); console.log(`    retry in ${wait}ms…`); await sleep(wait); }
  }
  return null;                                    // gave up on this page
}

async function main() {
  const pageSize = Number(arg("page-size", 50));
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const delay = Number(arg("delay", 200));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  const browser = await chromium.launch({
    headless: false, channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  const page = await context.newPage();
  await page.goto("https://www.royalcaribbean.com/cruises", { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(1500);

  // ---- Page through every cruise ----
  const byItin = new Map();       // itinerary name -> record (dedupe; many search rows share an itinerary)
  const unmappedDest = new Set();
  let total = Infinity, skip = 0, seen = 0, skippedPages = 0;
  while (skip < Math.min(total, limit)) {
    const vars = { sort: { by: "RECOMMENDED" }, pagination: { count: pageSize, skip } };
    const res = await fetchPage(page, vars);
    if (!res) {
      console.log(`  ⚠ skip ${skip}: page failed after retries — skipped (${pageSize} cruises)`);
      if (++skippedPages > 8) { console.log("Too many failed pages — stopping early."); break; }
      skip += pageSize; continue;
    }
    total = res.total ?? total;
    const cruises = res.cruises || [];
    if (!cruises.length) break;
    for (const c of cruises) {
      const it = c.masterSailing?.itinerary;
      if (!it) continue;
      const days = (it.days || []).map((d) => {
        const sea = d.type === "CRUISING";
        return { day: d.number, port: sea ? "At Sea" : (d.ports?.[0]?.port?.name || "At Sea"), is_sea_day: sea };
      });
      const destName = it.destination?.name;
      const dest = rclDest(destName) || rclDest(it.name);
      if (destName && !dest) unmappedDest.add(destName);
      const dates = (c.sailings || []).map((s) => s.sailDate).filter(Boolean).sort();
      if (!dates.length) continue;
      const key = it.name + "|" + (it.ship?.code || "") + "|" + it.totalNights;
      const prev = byItin.get(key);
      if (prev) { prev.dates = [...new Set([...prev.dates, ...dates])].sort(); continue; }  // merge dates
      byItin.set(key, {
        ship: it.ship?.name,
        name: it.name,
        nights: it.totalNights,
        departPort: it.departurePort?.name,
        arrivePort: days.length ? days[days.length - 1].port : it.departurePort?.name,
        ...(dest ? { dest } : {}),
        days,
        dates,
      });
    }
    seen += cruises.length;
    console.log(`  skip ${skip} → +${cruises.length} (seen ${seen}/${total}, itineraries ${byItin.size})`);
    skip += pageSize;
    await sleep(delay);
  }

  const itineraries = [...byItin.values()];
  if (unmappedDest.size) console.log(`Unmapped RCL destinations (dest omitted): ${[...unmappedDest].join(", ")}`);
  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = { generated, line: "royal-caribbean", source: "royalcaribbean.com GraphQL: CruisesSearchResults (no prices)", itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `royal-caribbean-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} itineraries · ${departures} departures` +
    (skippedPages ? ` · ⚠ ${skippedPages} page(s) skipped (${skippedPages * pageSize} cruises not covered — re-run to fill)` : ""));

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
