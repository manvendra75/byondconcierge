#!/usr/bin/env node
// CDP-attach survey — for portals whose edge (MSC/Akamai) rejects any Playwright-LAUNCHED
// browser. Instead of launching Chrome, YOU launch your own Chrome with a debug port and log
// in BY HAND (a real human session the edge clears); this script ATTACHES over CDP and passively
// records the portal's JSON responses + the open pages' HTML while you browse. Nothing here logs
// in or types your credentials — it only listens.
//
// Setup (you, once — close all Chrome first):
//   & "C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\msc-chrome"
// Then in that Chrome: log into MSC, open ONE cruise's day-by-day, and run the widest search.
// Finally:
//   node scripts/itinerary/survey-portal-cdp.mjs --line msc --host mscbook.com
//
// It writes samples + a ranked report to skills/cruise-line-scraper/workdir/<line>/ (git-ignored),
// then I read them and build fetch-<line>.mjs.

import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when we actually attach.
const chromium = { connectOverCDP: async (...a) => (await import("playwright")).chromium.connectOverCDP(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const waitForEnter = (msg) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

// Heuristic: does a body look like it carries a day-by-day itinerary?
const looksItinerary = (t) =>
  /"?(itinerary|days?|ports?ofcall|portsofcall|dayNumber|sailEventType|arrivalTime|departureTime)"?\s*[:=]/i.test(t) &&
  /\b20\d{2}[-/]\d{2}[-/]\d{2}\b/.test(t);

async function main() {
  const line = arg("line");
  const host = arg("host");
  const endpoint = arg("cdp", "http://localhost:9222");
  if (!line || !host) throw new Error('usage: survey-portal-cdp.mjs --line <slug> --host <portal host> [--cdp http://localhost:9222]');

  const dir = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", line);
  const samplesDir = path.join(dir, "samples");
  const authDir = path.join(dir, ".auth");
  const reportPath = path.join(dir, "survey-endpoints.json");

  // Attach to the Chrome YOU launched — never launch our own (that's what the edge blocks).
  let browser;
  try {
    browser = await chromium.connectOverCDP(endpoint);
  } catch (e) {
    throw new Error(
      `Could not attach to Chrome at ${endpoint}.\n` +
      `Launch Chrome yourself first, e.g.:\n` +
      `  & "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe" --remote-debugging-port=9222 --user-data-dir="$env:TEMP\\${line}-chrome"\n` +
      `then log into the portal in that window and re-run this.\n\n${e.message}`);
  }
  const context = browser.contexts()[0];
  if (!context) throw new Error("Attached, but found no browser context — is a Chrome window open and logged in?");

  // Passively record same-portal JSON responses as you browse.
  const seen = [];
  context.on("response", async (res) => {
    try {
      const url = res.url();
      if (!new URL(url).host.includes(host)) return;              // this portal only
      const ct = res.headers()["content-type"] || "";
      if (!/json/i.test(ct)) return;
      let body = ""; try { body = await res.text(); } catch { return; }
      if (body.length > 6_000_000) return;
      fs.mkdirSync(samplesDir, { recursive: true });
      const stem = (url.split("?")[0].split("/").filter(Boolean).pop() || "hit").replace(/[^\w.-]/g, "_").slice(0, 30);
      const file = path.join(samplesDir, `${seen.length}-${stem}.json`);
      try { fs.writeFileSync(file, body); } catch { /* ignore */ }
      seen.push({
        kind: "json", method: res.request().method(), status: res.status(), url,
        bytes: body.length, itineraryLike: looksItinerary(body),
        mentionsSailing: (body.match(/sailing|itinerary|voyage/gi) || []).length,
        savedTo: path.relative(ROOT, file),
      });
    } catch { /* ignore */ }
  });

  console.log(`\nAttached to your Chrome (${endpoint}). Recording ${host} JSON responses.`);
  console.log("  → In your Chrome window: open ONE cruise's day-by-day itinerary,");
  console.log("  → then run the cruise SEARCH (widest; scroll through all results).");
  console.log("  → Leave those tabs open.\n");
  await waitForEnter("Press ENTER once you've viewed a day-by-day AND the search results… ");

  // Snapshot the HTML of every open page too — WebSphere Commerce (mscbook) views are often
  // server-rendered, so the data may live in the HTML rather than a JSON endpoint.
  fs.mkdirSync(samplesDir, { recursive: true });
  const pages = context.pages();
  for (let i = 0; i < pages.length; i++) {
    try {
      const html = await pages[i].content();
      const u = pages[i].url();
      const file = path.join(samplesDir, `page-${i}.html`);
      fs.writeFileSync(file, html);
      seen.push({
        kind: "html", method: "PAGE", status: 200, url: u, bytes: html.length,
        itineraryLike: looksItinerary(html),
        mentionsSailing: (html.match(/sailing|itinerary|voyage/gi) || []).length,
        savedTo: path.relative(ROOT, file),
      });
    } catch { /* ignore */ }
  }

  // Save the session cookies so a later attach-based fetch can reuse them if needed.
  try { fs.mkdirSync(authDir, { recursive: true }); await context.storageState({ path: path.join(authDir, "storageState.json") }); } catch { /* ignore */ }

  seen.sort((a, b) => (Number(b.itineraryLike) - Number(a.itineraryLike)) || (b.mentionsSailing - a.mentionsSailing));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(reportPath, JSON.stringify(seen, null, 2));
  console.log(`\nCaptured ${seen.length} items → ${path.relative(ROOT, samplesDir)}\\`);
  console.log(`Report (ranked) → ${path.relative(ROOT, reportPath)}`);
  for (const e of seen.slice(0, 10)) {
    console.log(`  ${e.itineraryLike ? "★" : " "} [${e.method} ${e.status}] ${e.kind} ${e.mentionsSailing}× · ${(e.bytes / 1024).toFixed(0)}KB — ${e.url}`);
  }
  console.log("\nTell me it's done — I'll read the saved bodies/HTML and build fetch-msc.mjs.\n");

  // Detach WITHOUT closing your Chrome: just end the process so the CDP socket drops.
  process.exit(0);
}

main().catch((e) => { console.error(e); process.exit(1); });
