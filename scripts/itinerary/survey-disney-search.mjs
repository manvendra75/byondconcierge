#!/usr/bin/env node
// TC.5b — Disney agent-portal SEARCH survey. Closes the enumeration gap.
//
// The importer can extract any sailing's day-by-day from its code, but we need the FULL list of
// current sailing codes (the sitemap is stale). This loads your saved session, opens the portal's
// cruise search, and — while you run a broad search — records every API response, extracts the
// sailing codes it sees, and identifies the list endpoint. Output:
//   - workdir/disney/sailing-codes.json   (the codes → run the importer with them immediately)
//   - workdir/disney/search-endpoints.json (the list API → wire deterministic enumeration later)
//
// Run (after auth-disney.mjs):
//   node scripts/itinerary/survey-disney-search.mjs
// In the browser: go to "Book a Cruise" / cruise search, run a WIDE search (all destinations, the
// broadest date range), and page to "show all" if offered. Then press ENTER.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DISNEY_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "disney");
const STATE_PATH = path.join(DISNEY_DIR, ".auth", "storageState.json");
const CODES_PATH = path.join(DISNEY_DIR, "sailing-codes.json");
const URLS_PATH = path.join(DISNEY_DIR, "disney-urls.json");   // real detail URLs harvested from the results
const ENDPOINTS_PATH = path.join(DISNEY_DIR, "search-endpoints.json");
const SAMPLES_DIR = path.join(DISNEY_DIR, "samples");
const START_URL = "https://disneycruise.disney.go.com/";   // navigate to Book a Cruise from here

const waitForEnter = (msg) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

// Broadened: sailing/cruise codes can appear as "WT0101;entityType=cruise-sailing" OR bare tokens.
const codesIn = (text) => new Set([
  ...[...text.matchAll(/([A-Z]{2}\d{4});entityType=cruise-sailing/g)].map((m) => m[1]),
  ...[...text.matchAll(/"(?:sailingId|cruiseId|voyageCode|sailingCode|code)"\s*:\s*"([A-Z]{2}\d{4})"/g)].map((m) => m[1]),
]);

async function main() {
  if (!fs.existsSync(STATE_PATH)) throw new Error(`No session — run auth-disney.mjs first (${path.relative(ROOT, STATE_PATH)}).`);
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  const allCodes = new Set();
  const endpoints = [];   // EVERY Disney-origin JSON response, saved so we can inspect the search shape
  context.on("response", async (res) => {
    try {
      const url = res.url();
      // Only same-origin Disney API/app responses — drop external tracking/ads noise.
      if (!/^https:\/\/disneycruise\.disney\.go\.com\/(dcl-|api\/|session\/|profile-api\/)/.test(url)) return;
      const ct = res.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      let body = ""; try { body = await res.text(); } catch { return; }
      if (body.length > 5_000_000) return;                       // skip the huge per-sailing blobs
      const codes = codesIn(body);
      for (const c of codes) allCodes.add(c);
      // Save every candidate so I can read the real search structure; flag code-bearing ones.
      fs.mkdirSync(SAMPLES_DIR, { recursive: true });
      const file = path.join(SAMPLES_DIR, `search-${endpoints.length}-${(url.split("?")[0].split("/").pop() || "hit").replace(/[^\w.-]/g, "_").slice(0, 30)}.json`);
      try { fs.writeFileSync(file, body); } catch { /* ignore */ }
      endpoints.push({
        method: res.request().method(), status: res.status(), url,
        bytes: body.length, codeCount: codes.size,
        mentionsSailing: (body.match(/sailing/gi) || []).length,
        savedTo: path.relative(ROOT, file),
      });
    } catch { /* ignore */ }
  });

  await page.goto(START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log("\nBrowser open with your session.");
  console.log("  → Go to 'Book a Cruise' / cruise search.");
  console.log("  → Run the WIDEST search you can (all destinations, broadest dates); 'show all' if offered.");
  console.log("  → Scroll/page through the results so every sailing loads.\n");
  await waitForEnter("Press ENTER when the search results are fully loaded… ");

  // Harvest the REAL detail URLs from the results' links (these carry the date we can't otherwise
  // build). The importer loads each of these pages to capture its own day-by-day call.
  const hrefs = await page.$$eval('a[href*="/cruises-destinations/list/"]',
    (els) => [...new Set(els.map((e) => e.href))]).catch(() => []);
  const detailUrls = hrefs.filter((u) => /\/list\/[A-Z0-9]+\/.+\/\d{4}-\d{2}-\d{2}-Disney-/i.test(u)).sort();

  fs.mkdirSync(DISNEY_DIR, { recursive: true });
  fs.writeFileSync(URLS_PATH, JSON.stringify(detailUrls, null, 2));
  fs.writeFileSync(CODES_PATH, JSON.stringify([...allCodes].sort(), null, 2));
  // Rank by code count, then by how much each mentions "sailing" — the list endpoint floats up.
  endpoints.sort((a, b) => (b.codeCount - a.codeCount) || (b.mentionsSailing - a.mentionsSailing));
  fs.writeFileSync(ENDPOINTS_PATH, JSON.stringify(endpoints, null, 2));

  console.log(`\nHarvested ${detailUrls.length} real detail URLs → ${path.relative(ROOT, URLS_PATH)}`);
  console.log(`Captured ${endpoints.length} Disney JSON responses; ${allCodes.size} unique sailing codes.`);
  console.log(`Saved full bodies → ${path.relative(ROOT, SAMPLES_DIR)}\\  (report → ${path.relative(ROOT, ENDPOINTS_PATH)})`);
  console.log("Most itinerary/list-like responses:");
  for (const e of endpoints.slice(0, 8)) {
    console.log(`  [${e.method} ${e.status}] ${e.codeCount} codes · ${e.mentionsSailing}× "sailing" · ${(e.bytes / 1024).toFixed(0)}KB`);
    console.log(`      ${e.url}`);
  }
  console.log("\nTell me it's done — I'll read the saved bodies and wire enumeration.\n");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
