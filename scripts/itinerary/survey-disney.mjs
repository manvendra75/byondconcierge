#!/usr/bin/env node
// TC.5b — Disney agent-portal survey (authenticated). Finds the day-by-day data endpoint.
//
// Loads the session saved by auth-disney.mjs, opens the portal, and RECORDS every JSON/XHR the
// portal makes while you browse to a cruise's itinerary. Then it writes a report of the endpoints
// (and flags the ones whose responses look like a day-by-day: dates, ports, day numbers). You paste
// that report back so the importer can be wired to the exact endpoint — same "JSON beats HTML" step
// we used for Silversea, but inside your authenticated session.
//
// Run (after auth-disney.mjs):
//   node scripts/itinerary/survey-disney.mjs
// Then, in the browser window, navigate to any cruise and open its ITINERARY / day-by-day view.
// Come back and press ENTER; the report is written to workdir/disney/survey-endpoints.json.

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
const REPORT_PATH = path.join(DISNEY_DIR, "survey-endpoints.json");
const SAMPLES_DIR = path.join(DISNEY_DIR, "samples");   // full bodies of itinerary-like hits (local only)
// Land directly on ONE specific FUTURE cruise detail page: the itinerary/availability API fires on
// load, so its full body is captured with no manual navigation. Must be a future sailing — a past
// one errors ("unable to set sail"). Pass --url <other> to vary. (7-night for a fuller day-by-day.)
const START_URL = "https://disneycruise.disney.go.com/cruises-destinations/list/WT0101/7-Night-Very-Merrytime-Eastern-Caribbean-Cruise-from-Port-Canaveral/2026-11-21-Disney-Treasure/";

const waitForEnter = (msg) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

// Does a JSON body look like a day-by-day itinerary? (dates + ports + day numbers, no need for exactness)
const looksLikeItinerary = (text) =>
  /"(itinerary|days?|ports?|portsOfCall|dayNumber|arrivalTime|departureTime|schedule)"\s*:/i.test(text) &&
  /\b20\d{2}-\d{2}-\d{2}\b/.test(text);

async function main() {
  if (!fs.existsSync(STATE_PATH)) {
    throw new Error(`No session at ${path.relative(ROOT, STATE_PATH)} — run auth-disney.mjs first.`);
  }
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ storageState: STATE_PATH, viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  // Record every non-static response; keep the interesting (API/JSON) ones with a small body sample.
  const seen = [];
  context.on("response", async (res) => {
    try {
      const url = res.url();
      const ct = res.headers()["content-type"] || "";
      if (!/json|api|graphql/i.test(ct + url)) return;
      if (/\.(png|jpg|jpeg|gif|svg|webp|css|js|woff2?)($|\?)/i.test(url)) return;
      let body = "";
      try { body = await res.text(); } catch { /* streamed/again */ }
      const hit = looksLikeItinerary(body);
      let savedTo;
      if (hit) {
        // Save the FULL body locally so we can find the day-by-day structure (it may sit below the
        // pricing in a big blob). Local survey artifact only — the importer never emits prices.
        fs.mkdirSync(SAMPLES_DIR, { recursive: true });
        savedTo = path.join(SAMPLES_DIR, `${seen.length}-${(url.split("/").pop() || "hit").replace(/[^\w.-]/g, "_").slice(0, 40)}.json`);
        try { fs.writeFileSync(savedTo, body); } catch { savedTo = undefined; }
      }
      seen.push({
        method: res.request().method(), status: res.status(), url,
        itineraryLike: hit,
        savedTo: savedTo ? path.relative(ROOT, savedTo) : undefined,
        sample: hit ? body.slice(0, 800) : undefined,
      });
    } catch { /* ignore */ }
  });

  // Optional --url to target a different sailing detail page.
  const argUrl = (() => { const i = process.argv.indexOf("--url"); return i >= 0 ? process.argv[i + 1] : null; })();
  await page.goto(argUrl || START_URL, { waitUntil: "domcontentloaded" }).catch(() => {});
  console.log("\nBrowser open with your session on a specific cruise detail page.");
  console.log("  → Wait until the page fully loads (itinerary/prices visible), then come back.");
  console.log("  → If it shows a region/login wall, log in / pick region, then let it load.\n");
  await waitForEnter("Press ENTER once the cruise page has loaded… ");

  // De-dupe by URL (keep the itinerary-like ones first) and write the report.
  const byUrl = new Map();
  for (const r of seen) {
    const prev = byUrl.get(r.url);
    if (!prev || (r.itineraryLike && !prev.itineraryLike)) byUrl.set(r.url, r);
  }
  const report = [...byUrl.values()].sort((a, b) => Number(b.itineraryLike) - Number(a.itineraryLike));
  fs.writeFileSync(REPORT_PATH, JSON.stringify(report, null, 2));

  const hits = report.filter((r) => r.itineraryLike);
  console.log(`\nCaptured ${report.length} API/JSON calls; ${hits.length} look like a day-by-day.`);
  for (const h of hits.slice(0, 5)) console.log(`  ★ [${h.method} ${h.status}] ${h.url}`);
  console.log(`\nFull report → ${path.relative(ROOT, REPORT_PATH)}`);
  console.log("Paste that file's contents (or the ★ lines) back to continue.\n");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
