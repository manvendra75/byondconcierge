#!/usr/bin/env node
// TC.5b — capture the exact cruise-details REQUEST shape (so the importer can replay it directly).
//
// The detail page needs a full valid URL we can't build (no date in the search data), so instead of
// loading pages we'll REPLAY the get-cruise-details-availability POST for each code. This opens ONE
// known-good cruise page with your session and records that POST's method, URL, headers and body →
// request-shape.json, which I use to build the direct replay.
//
// Run (after auth-disney.mjs):
//   node scripts/itinerary/capture-disney-request.mjs
// If the default page errors, pass a working cruise's URL:
//   node scripts/itinerary/capture-disney-request.mjs --url "<paste a cruise detail URL from the portal>"

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DISNEY_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "disney");
const STATE_PATH = path.join(DISNEY_DIR, ".auth", "storageState.json");
const OUT = path.join(DISNEY_DIR, "request-shape.json");
// A known future sailing whose full detail URL worked earlier (used only to trigger the API).
const DEFAULT_URL = "https://disneycruise.disney.go.com/cruises-destinations/list/WT0101/7-Night-Very-Merrytime-Eastern-Caribbean-Cruise-from-Port-Canaveral/2026-11-21-Disney-Treasure/";

async function main() {
  if (!fs.existsSync(STATE_PATH)) throw new Error("No session — run auth-disney.mjs first.");
  const i = process.argv.indexOf("--url");
  const url = i >= 0 ? process.argv[i + 1] : DEFAULT_URL;

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  let captured = null;
  page.on("request", (req) => {
    if (captured) return;
    if (/get-cruise-details-availability\//.test(req.url())) {
      captured = { method: req.method(), url: req.url(), headers: req.headers(), postData: req.postData() || null };
    }
  });

  console.log("Loading a cruise page to capture its details request…");
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});
  // Give the SPA a few seconds to fire the API.
  await page.waitForTimeout(12000);
  await browser.close();

  if (!captured) {
    console.log("\nDid not see the details request. The default page may be unavailable —");
    console.log("open a working cruise in the portal, copy its URL, and re-run with --url \"<that URL>\".");
    process.exit(2);
  }
  fs.mkdirSync(DISNEY_DIR, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(captured, null, 2));
  console.log(`\nCaptured the cruise-details request → ${path.relative(ROOT, OUT)}`);
  console.log(`  ${captured.method} ${captured.url}`);
  console.log(`  has body: ${captured.postData ? "yes" : "no"} | header keys: ${Object.keys(captured.headers).join(", ")}`);
  console.log("Tell me it's done — I'll wire the direct replay into fetch-disney.mjs.\n");
}

main().catch((e) => { console.error(e); process.exit(1); });
