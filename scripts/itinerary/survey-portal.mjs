#!/usr/bin/env node
// Reusable agent-portal survey — discovers a portal's itinerary/day-by-day + list endpoints.
//
// Generalises survey-disney-search.mjs for any portal. Loads the session from auth-portal.mjs, opens
// the portal, and RECORDS every same-origin JSON response while you browse to a cruise's itinerary and
// the search results. Bodies are saved locally so the day-by-day + list structures can be identified,
// then a line-specific fetch-<line>.mjs is written to extract them (mapping via from-compass.mjs).
//
// Run (after auth-portal.mjs --line <line> …):
//   node scripts/itinerary/survey-portal.mjs --line carnival --url "<a portal page to start on>"
// In the browser: open a specific cruise's ITINERARY/day-by-day, and run the cruise SEARCH (widest,
// scroll all results). Then press ENTER.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

function arg(name) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : null; }
const waitForEnter = (msg) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

// Heuristic: does a JSON body look like it carries a day-by-day itinerary?
const looksItinerary = (t) =>
  /"(itinerary|days?|ports?ofcall|portsofcall|dayNumber|sailEventType|arrivalTime|departureTime)"\s*:/i.test(t) &&
  /\b20\d{2}-\d{2}-\d{2}\b/.test(t);

async function main() {
  const line = arg("line");
  const startUrl = arg("url");
  if (!line || !startUrl) throw new Error('usage: survey-portal.mjs --line <slug> --url "<start URL>"');

  const dir = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", line);
  const statePath = path.join(dir, ".auth", "storageState.json");
  const samplesDir = path.join(dir, "samples");
  const reportPath = path.join(dir, "survey-endpoints.json");
  if (!fs.existsSync(statePath)) throw new Error(`No session — run auth-portal.mjs --line ${line} … first.`);

  const host = new URL(startUrl).host;
  // Same anti-bot-management launch as auth-portal (MSC/Akamai blocks driven browsers at the edge).
  const browser = await chromium.launch({
    headless: false,
    channel: "chrome",
    args: ["--disable-blink-features=AutomationControlled"],
    ignoreDefaultArgs: ["--enable-automation"],
  });
  const context = await browser.newContext({ storageState: statePath, viewport: { width: 1360, height: 900 } });
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => undefined });
  });
  const page = await context.newPage();

  const seen = [];
  context.on("response", async (res) => {
    try {
      const url = res.url();
      if (new URL(url).host !== host) return;                          // same portal only — drop 3rd-party noise
      const ct = res.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      let body = ""; try { body = await res.text(); } catch { return; }
      if (body.length > 6_000_000) return;
      fs.mkdirSync(samplesDir, { recursive: true });
      const stem = (url.split("?")[0].split("/").filter(Boolean).pop() || "hit").replace(/[^\w.-]/g, "_").slice(0, 30);
      const file = path.join(samplesDir, `${seen.length}-${stem}.json`);
      try { fs.writeFileSync(file, body); } catch { /* ignore */ }
      // Also capture the REQUEST body (the .svc POST payload) so a fetcher can replay the exact call.
      let reqBody = null;
      try { reqBody = res.request().postData(); } catch { /* ignore */ }
      if (reqBody) { try { fs.writeFileSync(path.join(samplesDir, `${seen.length}-${stem}.req.json`), reqBody); } catch { /* ignore */ } }
      seen.push({
        method: res.request().method(), status: res.status(), url,
        bytes: body.length, itineraryLike: looksItinerary(body),
        mentionsSailing: (body.match(/sailing|itinerary|voyage/gi) || []).length,
        savedTo: path.relative(ROOT, file),
        request: reqBody ? (reqBody.length > 4000 ? reqBody.slice(0, 4000) + "…" : reqBody) : null,
      });
    } catch { /* ignore */ }
  });

  await page.goto(startUrl, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log(`\nBrowser open on ${line} with your session.`);
  console.log("  → Open ONE specific cruise's ITINERARY / day-by-day view.");
  console.log("  → Then run the cruise SEARCH (widest; scroll through all results).\n");
  await waitForEnter("Press ENTER when you've viewed a cruise's day-by-day AND the search results… ");

  // Also snapshot each open page's HTML — many agent portals (CostaClick/ASP.NET) are server-rendered,
  // so the data may live in the page rather than a JSON endpoint. This makes the survey useful either way.
  fs.mkdirSync(samplesDir, { recursive: true });
  const openPages = context.pages();
  for (let i = 0; i < openPages.length; i++) {
    try {
      const html = await openPages[i].content();
      const file = path.join(samplesDir, `page-${i}.html`);
      fs.writeFileSync(file, html);
      seen.push({
        method: "PAGE", status: 200, url: openPages[i].url(), bytes: html.length,
        itineraryLike: looksItinerary(html),
        mentionsSailing: (html.match(/sailing|itinerary|voyage/gi) || []).length,
        savedTo: path.relative(ROOT, file),
      });
    } catch { /* ignore */ }
  }

  seen.sort((a, b) => (Number(b.itineraryLike) - Number(a.itineraryLike)) || (b.mentionsSailing - a.mentionsSailing));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(seen, null, 2));
  console.log(`\nCaptured ${seen.length} ${line} JSON responses → ${path.relative(ROOT, samplesDir)}\\`);
  console.log(`Report (ranked) → ${path.relative(ROOT, reportPath)}`);
  for (const e of seen.slice(0, 8)) {
    console.log(`  ${e.itineraryLike ? "★" : " "} [${e.method} ${e.status}] ${e.mentionsSailing}× · ${(e.bytes / 1024).toFixed(0)}KB — ${e.url}`);
  }
  console.log("\nTell me it's done — I'll read the saved bodies and build the extractor.\n");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
