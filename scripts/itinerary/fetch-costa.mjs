#!/usr/bin/env node
// fetch-costa.mjs — acquire Costa's full catalogue + day-by-day from the CostaClick agent API.
//
// Attach mode (recommended — robust against the launched-browser crashing and the int→b2b redirect):
//   1) You launch your OWN Chrome with a debug port and log into CostaClick:
//        & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\costa-chrome"
//   2) node scripts/itinerary/fetch-costa.mjs --cdp http://localhost:9222 --months 4
//      → it attaches, asks you to run ONE cruise search (so it learns the exact API URL for your
//        session's host), then replays that endpoint across monthly windows + fetches each
//        itinerary's day-by-day. Your Chrome is never closed.
//
// Two WCF JSON endpoints (discovered from your search): GetExtendedCruiseListData (all cruises in a
// date window; the API caps a call at 250 rows, so we page monthly and union by cruise code) and
// GetItineraryDetails (a cruise's day-by-day → ports + sea days). No prices are read.
//
// Launch mode (uses cookies saved by auth-portal.mjs, if the driven browser is stable for you):
//   node scripts/itinerary/fetch-costa.mjs --months 4

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

import { costaDest, costaDestFromName } from "./classify.mjs";

const chromium = {
  launch: async (...a) => (await import("playwright")).chromium.launch(...a),
  connectOverCDP: async (...a) => (await import("playwright")).chromium.connectOverCDP(...a),
};

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");                     // -> Marketing
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const WORKDIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "costa");
const STATE_PATH = path.join(WORKDIR, ".auth", "storageState.json");

// Defaults (launch mode / fallback). In attach mode the real URLs are DISCOVERED from your search.
const DEFAULT_BASE = "https://int.costaextra.com/CostaClick/en-BZ/_vti_bin/CostaClickNew/UIServices/PublicServices.svc";
let LIST_URL = `${DEFAULT_BASE}/GetExtendedCruiseListData`;
let ITIN_URL = `${DEFAULT_BASE}/GetItineraryDetails`;

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const isCosta = (u) => { try { return /(^|\.)costaextra\.com$/.test(new URL(u).host); } catch { return false; } };
const sameOrigin = (a, b) => { try { return new URL(a).origin === new URL(b).origin; } catch { return false; } };
const waitForEnter = (msg) => new Promise((res) => { const rl = readline.createInterface({ input: process.stdin, output: process.stdout }); rl.question(msg, () => { rl.close(); res(); }); });

// Month windows starting today (first window clamped to today so past departures are skipped).
function monthWindows(startISO, months) {
  const d = new Date(startISO + "T00:00:00Z");
  const out = [];
  for (let i = 0; i < months; i++) {
    const first = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i, 1));
    const last = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + i + 1, 0));
    out.push({ from: i === 0 ? startISO : first.toISOString().slice(0, 10), to: last.toISOString().slice(0, 10) });
  }
  return out;
}

// POST a WCF JSON endpoint from inside the authenticated page (same-origin → cookies auto-attached).
// Retries once if a mid-flight SPA navigation destroys the evaluate context.
async function callSvc(page, url, body) {
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return await page.evaluate(async ({ url, body }) => {
        const r = await fetch(url, {
          method: "POST",
          headers: { "Content-Type": "application/json; charset=utf-8", Accept: "application/json" },
          body: JSON.stringify(body),
          credentials: "include",
        });
        return { status: r.status, text: await r.text() };
      }, { url, body });
    } catch (e) {
      if (attempt === 0 && /context was destroyed|navigation/i.test(e.message)) { await sleep(800); continue; }
      throw e;
    }
  }
}

const envelope = (j) => j?.d || j?.ItineraryDetails || j;    // WCF wraps in "d" (list) or "ItineraryDetails"

async function main() {
  const months = Number(arg("months", 24));
  const delay = Number(arg("delay", 200));
  const cdp = arg("cdp");
  const generated = arg("date", new Date().toISOString().slice(0, 10));
  const today = new Date().toISOString().slice(0, 10);

  let browser, context, page, launched = false;

  if (cdp) {
    browser = await chromium.connectOverCDP(cdp);
    context = browser.contexts()[0];
    if (!context) throw new Error("Attached, but no browser context — is a Chrome window open and logged into CostaClick?");

    // Learn the EXACT endpoint URL for your session's host (int vs b2b vary) by watching one search.
    const found = {};
    context.on("response", (res) => {
      const u = res.url();
      if (/GetExtendedCruiseListData/i.test(u)) found.list = u.split("?")[0];
      if (/GetItineraryDetails/i.test(u)) found.itin = u.split("?")[0];
    });
    console.log("\nAttached. In your CostaClick tab:");
    console.log("  → run ONE cruise search (any dates), and open ONE cruise's itinerary/day-by-day.");
    await waitForEnter("Press ENTER once you've run a search AND opened an itinerary… ");

    if (found.list) LIST_URL = found.list;
    if (found.itin) ITIN_URL = found.itin;
    else if (found.list) ITIN_URL = found.list.replace(/GetExtendedCruiseListData$/, "GetItineraryDetails");
    if (!found.list) throw new Error("I didn't see a GetExtendedCruiseListData call — make sure you actually ran a cruise search in the CostaClick tab, then re-run.");
    console.log(`Discovered API:\n  list: ${LIST_URL}\n  itin: ${ITIN_URL}`);

    // Use the tab that fired the search (same origin as the discovered API → same-origin fetch works).
    page = context.pages().find((p) => sameOrigin(p.url(), LIST_URL)) || context.pages().find((p) => isCosta(p.url()));
    if (!page) throw new Error("Couldn't find your CostaClick tab — leave it open and re-run.");
  } else {
    if (!fs.existsSync(STATE_PATH)) throw new Error("No session — run auth-portal.mjs --line costa first, or use --cdp <endpoint> to attach to your own Chrome.");
    browser = await chromium.launch({ headless: false, channel: "chrome", args: ["--disable-blink-features=AutomationControlled"], ignoreDefaultArgs: ["--enable-automation"] });
    context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1360, height: 900 } });
    await context.addInitScript(() => { Object.defineProperty(navigator, "webdriver", { get: () => undefined }); });
    page = await context.newPage();
    await page.goto(LIST_URL.replace(/_vti_bin.*$/, "Pages/Login.aspx"), { waitUntil: "domcontentloaded" }).catch(() => {});
    launched = true;
  }

  // ---- 1) Enumerate every cruise, paging monthly (API caps a call at 250) ----
  const cruises = new Map();
  const ships = new Map();
  for (const w of monthWindows(today, months)) {
    const body = { filters: { from: w.from, to: w.to, destinationCode: "", fareCode: "", portCode: "", shipCode: "", discountCode: "", occupancyCode: "", gatewayCode: "" } };
    let R;
    try {
      const { status, text } = await callSvc(page, LIST_URL, body);
      if (status !== 200) { console.log(`  [list ${w.from}..${w.to}] HTTP ${status} — skipped`); continue; }
      R = envelope(JSON.parse(text)).Result;
    } catch (e) {
      if (cruises.size === 0) throw new Error(`List call failed — session may have expired, or the tab navigated away. Keep the logged-in CostaClick tab open and re-run.\n${e.message}`);
      console.log(`  [list ${w.from}..${w.to}] error — skipped (${e.message.slice(0, 60)})`); continue;
    }
    const arr = R?.Cruises || [];
    for (const s of R?.Ships || []) ships.set(s.Code, s.Name);
    for (const c of arr) cruises.set(c.Code, c);
    if (arr.length >= 250) console.log(`  ⚠ window ${w.from}..${w.to} hit the 250 cap — narrow the window.`);
    console.log(`  [list ${w.from}..${w.to}] ${arr.length} cruises (running total ${cruises.size})`);
    await sleep(delay);
  }
  console.log(`Enumerated ${cruises.size} cruises across ${months} months.`);

  // ---- 2) Group by itinerary; collect all departure dates per route ----
  const byItin = new Map();
  for (const c of cruises.values()) {
    const code = c.Itinerary?.Code;
    if (!code) continue;
    if (!byItin.has(code)) byItin.set(code, { rep: c.Code, shipCode: c.ShipCode, nights: c.Duration, departPort: c.DeparturePort?.Name, arrivePort: c.ArrivalPort?.Name, destName: c.Destination?.Name, dates: new Set() });
    byItin.get(code).dates.add(c.DepartureDate);
  }
  console.log(`${byItin.size} distinct itineraries — fetching day-by-day…`);

  // ---- 3) One GetItineraryDetails per itinerary → the dateless day-by-day template ----
  const recByItin = new Map();
  const unmappedDest = new Set();
  let done = 0; const misses = [];
  for (const [code, g] of byItin) {
    const { name, days, ok } = await fetchDayByDay(page, g.rep);
    if (!ok) misses.push(code);
    const dest = costaDest(g.destName) || costaDestFromName(name);   // category map, then name fallback
    if (g.destName && !dest) unmappedDest.add(g.destName);
    recByItin.set(code, { ship: ships.get(g.shipCode) || g.shipCode, name: name || code, nights: g.nights, departPort: g.departPort, arrivePort: g.arrivePort, ...(dest ? { dest } : {}), days, dates: [...g.dates].sort() });
    if (++done % 25 === 0) console.log(`  itineraries ${done}/${byItin.size} (${misses.length} day-by-day misses so far)`);
    await sleep(delay);
  }
  if (misses.length) {
    console.log(`Retrying ${misses.length} day-by-day misses…`);
    for (const code of misses) {
      const { name, days, ok } = await fetchDayByDay(page, byItin.get(code).rep);
      if (ok) { const rec = recByItin.get(code); rec.days = days; if (name) rec.name = name; }
      await sleep(delay);
    }
  }

  const itineraries = [...recByItin.values()];
  if (unmappedDest.size) console.log(`Unmapped Costa destinations (dest omitted, sailing kept): ${[...unmappedDest].join(", ")}`);
  const noDays = itineraries.filter((i) => !i.days.length).length;
  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);

  const obj = { generated, line: "costa", source: "CostaClick agent API: GetExtendedCruiseListData + GetItineraryDetails (no prices)", itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `costa-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} itineraries · ${departures} departures · ${noDays} without day-by-day`);

  if (launched) await browser.close();
}

// Fetch one cruise's day-by-day → {name, days:[{day,port,is_sea_day}], ok}. Days are DATELESS (a
// template); the builder re-dates them per departure. Sea days come from IsNavigationDay /
// Port.SeaDestination and are labelled "At Sea".
async function fetchDayByDay(page, cruiseCode) {
  try {
    const { status, text } = await callSvc(page, ITIN_URL, { cruiseCode });
    if (status !== 200) return { name: null, days: [], ok: false };
    const res = envelope(JSON.parse(text)).Result;
    const days = (res?.Segments || []).map((s) => {
      const sea = !!s.IsNavigationDay || !!s.Port?.SeaDestination;
      return { day: s.Day, port: sea ? "At Sea" : (s.Port?.Name || "At Sea"), is_sea_day: sea };
    });
    return { name: res?.Name || null, days, ok: days.length > 0 };
  } catch {
    return { name: null, days: [], ok: false };
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
