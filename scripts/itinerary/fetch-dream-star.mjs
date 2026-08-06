#!/usr/bin/env node
// fetch-dream-star.mjs — harvest StarDream's dated sailings from the SeawareTouch (GWT) B2B portal.
//
// SeawareTouch is a GWT app (obfuscated classes, no clean API). We attach over CDP to YOUR already-
// logged-in Chrome (session cookies stay on your machine — this never logs in or types credentials,
// only reads what's on screen). The voyage-search results render as a tab-separated GRID:
//    <VoyageID>\n\t<Ship>\t<N>N <EMB>-<DEB>(<CAT>)\t<n>n\t<Departure>\t<PortFrom>\t<Arrival>\t<PortTo>
// which parses cleanly. We set "entries per page = All" so every sailing renders at once (no paging),
// then read the grid. The grid carries the dated embark/disembark route; the full intermediate-port
// itinerary is only in the per-sailing expanded card (a later pass). No prices are read.
//
// YOU (once, session live): in the debug Chrome from the survey, run the WIDEST voyage search (all
// ships, a broad date range, all destinations) and leave the RESULTS page showing. Then:
//    node scripts/itinerary/fetch-dream-star.mjs                 # attaches to localhost:9222
//    node scripts/itinerary/fetch-dream-star.mjs --diagnose      # show what the grid parser sees

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { stardreamDest } from "./classify.mjs";

const chromium = { connectOverCDP: async (...a) => (await import("playwright")).chromium.connectOverCDP(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const SHIPS = ["Genting Dream", "Star Navigator", "Star Voyager"];
const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const CODE = /^(\d+)N\s+([A-Z]{3})-([A-Z]{3})\(([A-Z]+)\)$/;
function isoDate(s) { const m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/); return m ? `${m[3]}-${MON[m[2]]}-${String(m[1]).padStart(2, "0")}` : null; }

// Parse the grid rows out of the page's innerText: each result row is a tab-separated line whose
// fields are [ , Ship, Code, "Nn", DepartureDateTime, PortFrom, ArrivalDateTime, PortTo].
async function extractRows(page) {
  const text = await page.evaluate(() => document.body.innerText);
  const rows = [];
  for (const raw of text.split("\n")) {
    const f = raw.split("\t").map((x) => x.replace(/ /g, " ").trim());
    const idx = f.findIndex((x) => SHIPS.includes(x));
    if (idx < 0) continue;
    const cm = (f[idx + 1] || "").match(CODE);
    if (!cm) continue;                                         // needs the "3N SIN-SIN(DES)" code next to the ship
    const depDate = isoDate(f[idx + 3] || "");
    const depPort = f[idx + 4], arrPort = f[idx + 6];
    if (!depDate || !depPort || !arrPort) continue;
    rows.push({ ship: f[idx], nights: Number(cm[1]), embCode: cm[2], debCode: cm[3], cat: cm[4], depDate, depPort, arrPort });
  }
  return rows;
}

// Try to set the results length to "All" so every sailing renders on one page (skips pagination).
async function showAll(page) {
  for (const sel of await page.locator("select").all()) {
    const opts = await sel.locator("option").allTextContents().catch(() => []);
    if (opts.some((o) => /^all$/i.test(o.trim()))) { await sel.selectOption({ label: opts.find((o) => /^all$/i.test(o.trim())) }).catch(() => {}); return true; }
  }
  const all = page.getByText(/^All$/).last();
  if (await all.count().catch(() => 0)) { await all.click({ force: true, timeout: 3000 }).catch(() => {}); return true; }
  return false;
}

// Fallback pagination: click the numbered pager, else the aria "Next" glyph.
async function gotoPage(page, n) {
  const num = page.locator("button.dt-paging-button").filter({ hasText: new RegExp(`^${n}$`) }).last();
  if (await num.count().catch(() => 0)) { await num.click({ force: true, timeout: 5000 }).catch(() => {}); return true; }
  const next = page.locator('button.dt-paging-button[aria-label="Next"], [aria-label="Next"]').last();
  if (await next.count().catch(() => 0)) { await next.click({ force: true, timeout: 5000 }).catch(() => {}); return true; }
  return false;
}

async function main() {
  const endpoint = arg("cdp", "http://localhost:9222");
  const maxPages = Number(arg("max-pages", 40));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No Chrome context over CDP. Launch Chrome with --remote-debugging-port=9222 and log in.");

  // There may be several portal tabs open (survey/probe leftovers). Pick the results tab with the
  // MOST rows currently rendered — i.e. the one you set to "All" — not the first paginated one.
  let page = null, best = 0;
  for (const p of ctx.pages()) {
    const t = await p.evaluate(() => document.body.innerText).catch(() => "");
    if (!(/Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i.test(t) && /\b\d+N\s+[A-Z]{3}-[A-Z]{3}\(/.test(t))) continue;
    const n = (await extractRows(p)).length;
    if (n > best) { best = n; page = p; }
  }
  if (!page) throw new Error("No voyage-results page found. In your Chrome, run the widest voyage search and leave the RESULTS showing, then re-run.");
  console.log(`Using the results tab with ${best} rows rendered.`);

  if (process.argv.includes("--diagnose")) {
    const rows = await extractRows(page);
    console.log(`grid parser found ${rows.length} rows on the current page.`);
    rows.slice(0, 3).forEach((r) => console.log("  " + JSON.stringify(r)));
    await browser.close();
    return;
  }

  // Prefer "show All" (one render); fall back to paging if it doesn't take.
  await showAll(page);
  await page.waitForTimeout(1800);

  const seen = new Map();
  let pageNo = 1, total = null;
  while (pageNo <= maxPages) {
    const showing = (await page.evaluate(() => document.body.innerText)).match(/Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entries/i);
    if (showing) total = Number(showing[3]);
    let added = 0;
    for (const r of await extractRows(page)) {
      const key = `${r.ship}|${r.depDate}|${r.embCode}-${r.debCode}|${r.nights}`;
      if (!seen.has(key)) { seen.set(key, r); added++; }
    }
    console.log(`  page ${pageNo}: ${showing ? showing[0] : "?"} — +${added}, total ${seen.size}`);
    if (showing && Number(showing[2]) >= Number(showing[3])) break;   // all rows seen

    const before = showing ? showing[2] : "";
    if (!(await gotoPage(page, pageNo + 1))) { console.log("  no pager control — stopping."); break; }
    const advanced = await page.waitForFunction(
      (b) => { const m = document.body.innerText.match(/Showing\s+\d+\s+to\s+(\d+)\s+of/i); return m && m[1] !== b; },
      before, { timeout: 10000 },
    ).then(() => true).catch(() => false);
    if (!advanced) { console.log("  page did not advance — stopping (keeping what loaded)."); break; }
    pageNo++;
    await sleep(500);
  }
  await browser.close();

  const rows = [...seen.values()];
  const unmapped = new Set();
  const itineraries = rows.map((r) => {
    const dest = stardreamDest(r.depPort, r.arrPort, r.embCode);
    if (!dest) unmapped.add(`${r.depPort}->${r.arrPort} (${r.embCode})`);
    const route = r.depPort === r.arrPort ? [r.depPort] : [r.depPort, r.arrPort];
    const name = r.depPort === r.arrPort ? `${r.nights}N ${r.depPort} round-trip` : `${r.nights}N ${r.depPort} to ${r.arrPort}`;
    return { ship: r.ship, name, nights: r.nights, departPort: r.depPort, arrivePort: r.arrPort, ...(dest ? { dest } : {}), ports: route, dates: [r.depDate] };
  });
  if (unmapped.size) console.log(`Unmapped dest (omitted): ${[...unmapped].slice(0, 10).join(" | ")}`);

  const obj = { generated, line: "dream-star", source: "booking.stardreamcruises.com SeawareTouch voyage search (authorized agent session; dated, no prices)", itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `dream-star-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} dated sailings${total ? ` (portal reported ${total})` : ""}`);
}

main().catch((e) => { console.error(e); process.exit(1); });
