#!/usr/bin/env node
// fetch-norwegian.mjs — acquire Norwegian Cruise Line's catalogue from ncl.com's public vacations API.
//
// Public site, no login. NCL's React frontend calls a clean JSON API (robots.txt permits the itinerary
// content; we never touch the disallowed /booking, /search-results, /cruise-quotes paths). Two GETs:
//   • /api/vacations/v2/itineraries               — the master list of every itinerary (code, ship,
//     duration, destinationCodes, portsOfCall, and all sailing dates). One call.
//   • /api/vacations/v2/search-result-itinerary/<code> — one itinerary's full detail (ship + port +
//     itinerary NAMES, and its sailings) — the master only has codes, so we fetch a detail per cruise.
//
// The calls run through a real (Playwright) browser on the ncl.com origin so Akamai serves them like the
// site's own frontend. NCL's API exposes ports of call but no sea-day schedule, so Norwegian is a
// route-only line (no day-by-day). No prices are read (pricing in the response is ignored).
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-norwegian.mjs                 # full (~480 cruise itineraries)
//   node scripts/itinerary/fetch-norwegian.mjs --limit 15      # quick test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { nclDest, costaDestFromName } from "./classify.mjs";

const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Strip a trailing ", Country" from an NCL place title: "Athens (Piraeus), Greece" -> "Athens (Piraeus)".
const cleanPort = (t) => String(t || "").replace(/,\s*[^,]+$/, "").trim();
const isoDate = (epochMs) => new Date(epochMs).toISOString().slice(0, 10);

// GET a JSON endpoint from inside the ncl.com page (same-origin → served like the site's own frontend).
async function getJson(page, url) {
  return await page.evaluate(async (url) => {
    const r = await fetch(url, { headers: { Accept: "application/json" }, credentials: "include" });
    return { status: r.status, text: await r.text() };
  }, url);
}

async function main() {
  const market = arg("market", "no/en");              // any market shows the global fleet; prices differ (unused)
  const base = `https://www.ncl.com/${market}`;
  const api = `${base}/api/vacations/v2`;
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const delay = Number(arg("delay", 150));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  const browser = await chromium.launch({
    headless: false, channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
  const page = await context.newPage();
  await page.goto(`${base}/cruises`, { waitUntil: "domcontentloaded" }).catch(() => {});
  await sleep(1500);                                   // let the origin settle / Akamai clear

  // ---- 1) Master list → every itinerary; keep pure cruises (drop land-tours / hotel bundles) ----
  const { status, text } = await getJson(page, `${api}/itineraries?guests=2`);
  let master;
  try { master = JSON.parse(text); } catch { master = null; }
  if (status !== 200 || !Array.isArray(master)) {
    throw new Error(`Master itineraries call failed (HTTP ${status}, ${Array.isArray(master) ? "ok" : "not an array"}). ` +
      `NCL may have blocked the automated browser — retry, or capture the exact URL via survey-portal.`);
  }
  const codes = master.filter((i) => i.bundleType === "cruise").map((i) => i.code);
  console.log(`Master: ${master.length} itineraries, ${codes.length} pure cruises.`);

  // ---- 2) One detail per cruise → the full record (names + dates + route) ----
  const itineraries = [];
  const unmappedDest = new Set();
  let done = 0, failed = 0;
  for (const code of codes.slice(0, limit)) {
    try {
      const d = await getJson(page, `${api}/search-result-itinerary/${code}?guests=2`);
      if (d.status !== 200) { failed++; continue; }
      const det = JSON.parse(d.text);
      const ports = (det.portsOfCall || []).map((p) => cleanPort(p.title)).filter(Boolean);
      const destCode = det.destination?.[0]?.code;
      const dest = nclDest(destCode) || costaDestFromName(det.shortTitle || det.title || "");
      if (destCode && !nclDest(destCode) && !dest) unmappedDest.add(destCode);
      const dates = (det.sailings || []).map((s) => isoDate(s.departureDate)).filter(Boolean).sort();
      if (!dates.length) continue;                     // no bookable sailings → skip
      itineraries.push({
        ship: det.ship?.title,
        name: det.shortTitle || det.title || code,
        nights: det.duration?.days,
        departPort: cleanPort(det.embarkationPort?.title),
        arrivePort: ports.length ? ports[ports.length - 1] : cleanPort(det.embarkationPort?.title),
        ...(dest ? { dest } : {}),
        ports,                                         // ordered ports of call (route; no day-by-day)
        dates,
      });
    } catch { failed++; }
    if (++done % 40 === 0) console.log(`  details ${done}/${Math.min(codes.length, limit)} (${failed} failed)`);
    await sleep(delay);
  }

  if (unmappedDest.size) console.log(`Unmapped NCL destination codes (dest omitted): ${[...unmappedDest].join(", ")}`);
  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = { generated, line: "norwegian", source: "ncl.com public vacations API: itineraries + search-result-itinerary (no prices)", itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `norwegian-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} itineraries · ${departures} departures · ${failed} detail failures`);

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
