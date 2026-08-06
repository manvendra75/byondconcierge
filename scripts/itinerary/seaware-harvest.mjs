// seaware-harvest.mjs — shared harvester for SeawareTouch (GWT) B2B booking portals.
//
// Both StarDream (booking.stardreamcruises.com) and Aroya (booking.aroya.com) run SeawareTouch — a
// GWT app with obfuscated classes, no clean API, and DataTables-style paging. We attach over CDP to
// YOUR already-logged-in Chrome (session cookies stay on your machine — this never logs in or types
// credentials, only reads what's on screen). The voyage-search results render as a tab-separated GRID:
//    <VoyageID>\n\t<Ship>\t<N>N <EMB>-<DEB>(<CAT>)\t<n>n\t<Departure>\t<PortFrom>\t<Arrival>\t<PortTo>
// which parses cleanly. We set "entries per page = All" so every sailing renders at once, then read
// the grid. It carries the dated embark/disembark route (the full intermediate-port itinerary is only
// in the per-sailing expanded card — a later pass). No prices are read.
//
// A per-line wrapper (fetch-<line>.mjs) supplies { line, ships, classify, source } and runs this.
// The portal caps a search at ~3 months, so runs ACCUMULATE: merge into the newest snapshot (dedup by
// ship+date+nights+ports). Run once per date window and coverage builds up instead of overwriting.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const chromium = { connectOverCDP: async (...a) => (await import("playwright")).chromium.connectOverCDP(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MON = { Jan: "01", Feb: "02", Mar: "03", Apr: "04", May: "05", Jun: "06", Jul: "07", Aug: "08", Sep: "09", Oct: "10", Nov: "11", Dec: "12" };
const CODE = /^(\d+)N\s+([A-Z]{3})-([A-Z]{3})\(([A-Z]+)\)$/;   // StarDream's "3N SIN-SIN(DES)"
// Handle both grid date shapes: "07 Aug 2026" (StarDream) and "Sep 07, 2026" (Aroya).
function isoDate(s) {
  let m = String(s).match(/(\d{1,2})\s+([A-Za-z]{3})\s+(\d{4})/);
  if (m) return `${m[3]}-${MON[m[2]]}-${String(m[1]).padStart(2, "0")}`;
  m = String(s).match(/([A-Za-z]{3})\s+(\d{1,2}),\s+(\d{4})/);
  return m ? `${m[3]}-${MON[m[1]]}-${String(m[2]).padStart(2, "0")}` : null;
}

// Parse grid rows from the page's innerText. Each result row is a tab-separated line:
//   [ , Ship, <field1>, <duration>, DepartureDateTime, PortFrom, ArrivalDateTime, PortTo]
// where <field1> is either a StarDream code ("3N SIN-SIN(DES)") or, on Aroya, the itinerary NAME,
// and <duration> is "3n" (nights) or "6d" (days). Prices sit on their own line and are never read.
async function extractRows(page, ships) {
  const text = await page.evaluate(() => document.body.innerText);
  const rows = [];
  for (const raw of text.split("\n")) {
    const f = raw.split("\t").map((x) => x.replace(/ /g, " ").trim());
    const idx = f.findIndex((x) => ships.includes(x));
    if (idx < 0) continue;
    const depDate = isoDate(f[idx + 3] || "");
    const depPort = f[idx + 4], arrPort = f[idx + 6];
    if (!depDate || !depPort || !arrPort) continue;
    const cm = (f[idx + 1] || "").match(CODE);
    let name = null, nights, embCode, debCode, cat;
    if (cm) {                                                   // code-based (StarDream)
      nights = Number(cm[1]); embCode = cm[2]; debCode = cm[3]; cat = cm[4];
    } else {                                                    // name-based (Aroya)
      name = f[idx + 1];
      const dur = (f[idx + 2] || "").match(/^(\d+)\s*([dn])$/i);
      if (!name || !dur) continue;                              // not a real result row
      nights = dur[2].toLowerCase() === "d" ? Number(dur[1]) - 1 : Number(dur[1]);
      const nm = name.match(/(\d+)\s*Night/i);                  // prefer the name's own night count
      if (nm) nights = Number(nm[1]);
    }
    rows.push({ ship: f[idx], nights, embCode, debCode, cat, depDate, depPort, arrPort, name });
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

export async function harvestSeaware({ line, ships, classify, source }) {
  const endpoint = arg("cdp", "http://localhost:9222");
  const maxPages = Number(arg("max-pages", 40));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  const browser = await chromium.connectOverCDP(endpoint);
  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error("No Chrome context over CDP. Launch Chrome with --remote-debugging-port=9222 and log in.");

  // --dump: show every open tab and, for any with a results grid, a snippet of its rows so an
  // unfamiliar portal's format can be inspected (ship label, code shape).
  if (process.argv.includes("--dump")) {
    for (const p of ctx.pages()) {
      const t = await p.evaluate(() => document.body.innerText).catch(() => "");
      const showing = (t.match(/Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i) || [])[0] || "-";
      console.log(`\n=== TAB ${p.url()} | ${showing} | shipHit=${ships.some((s) => t.includes(s))} ===`);
      const lines = t.split("\n").map((l) => l.trim()).filter(Boolean);
      const anchor = lines.findIndex((l) => ships.some((s) => l.includes(s)) || /\b\d+\s*N\b/i.test(l));
      (anchor >= 0 ? lines.slice(anchor, anchor + 20) : lines.slice(0, 20)).forEach((l, i) => console.log(`  [${i}] ${JSON.stringify(l.slice(0, 90))}`));
    }
    await browser.close();
    return;
  }

  // Several portal tabs may be open. Pick the results tab with the MOST rows rendered (your "All" view).
  let page = null, best = 0;
  for (const p of ctx.pages()) {
    const t = await p.evaluate(() => document.body.innerText).catch(() => "");
    if (!/Showing\s+\d+\s+to\s+\d+\s+of\s+\d+\s+entries/i.test(t)) continue;
    const n = (await extractRows(p, ships)).length;             // format-agnostic: a tab with parseable rows
    if (n > best) { best = n; page = p; }
  }
  if (!page) throw new Error("No voyage-results page found. Run the widest voyage search, set results to 'All', leave them showing, then re-run — or run with --dump to inspect the open tabs.");
  console.log(`Using the results tab with ${best} rows rendered.`);

  if (process.argv.includes("--diagnose")) {
    const rows = await extractRows(page, ships);
    console.log(`grid parser found ${rows.length} rows on the current page.`);
    rows.slice(0, 3).forEach((r) => console.log("  " + JSON.stringify(r)));
    await browser.close();
    return;
  }

  await showAll(page);
  await page.waitForTimeout(1800);

  const seen = new Map();
  let pageNo = 1, total = null;
  while (pageNo <= maxPages) {
    const showing = (await page.evaluate(() => document.body.innerText)).match(/Showing\s+(\d+)\s+to\s+(\d+)\s+of\s+(\d+)\s+entries/i);
    if (showing) total = Number(showing[3]);
    let added = 0;
    for (const r of await extractRows(page, ships)) {
      const key = `${r.ship}|${r.depDate}|${r.nights}|${r.depPort}|${r.arrPort}`;
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
    const dest = classify(r.depPort, r.arrPort, r.embCode || "");
    if (!dest) unmapped.add(`${r.depPort}->${r.arrPort} (${r.embCode || "?"})`);
    const route = r.depPort === r.arrPort ? [r.depPort] : [r.depPort, r.arrPort];
    // Prefer the portal's own itinerary name (Aroya); otherwise synthesise from the route (StarDream).
    const name = r.name || (r.depPort === r.arrPort ? `${r.nights}N ${r.depPort} round-trip` : `${r.nights}N ${r.depPort} to ${r.arrPort}`);
    return { ship: r.ship, name, nights: r.nights, departPort: r.depPort, arrivePort: r.arrPort, ...(dest ? { dest } : {}), ports: route, dates: [r.depDate] };
  });
  if (unmapped.size) console.log(`Unmapped dest (omitted): ${[...unmapped].slice(0, 10).join(" | ")}`);

  // Accumulate: merge into the newest existing snapshot (dedup by ship+date+nights+ports; fresh wins).
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const keyOf = (it) => `${it.ship}|${it.dates[0]}|${it.nights}|${it.departPort}|${it.arrivePort}`;
  const byKey = new Map();
  const prior = fs.readdirSync(OUT_DIR).filter((f) => f.startsWith(`${line}-itineraries-`) && f.endsWith(".json")).sort();
  if (prior.length) {
    try { for (const it of (JSON.parse(fs.readFileSync(path.join(OUT_DIR, prior[prior.length - 1]), "utf8")).itineraries || [])) byKey.set(keyOf(it), it); } catch { /* start fresh */ }
  }
  const priorCount = byKey.size;
  for (const it of itineraries) byKey.set(keyOf(it), it);
  const merged = [...byKey.values()];
  const fresh = merged.length - priorCount;

  const obj = { generated, line, source, itineraries: merged };
  const outPath = path.join(OUT_DIR, `${line}-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  this run: ${itineraries.length} sailings${total ? ` (portal reported ${total})` : ""} · +${fresh} new · ${merged.length} total in snapshot`);
}
