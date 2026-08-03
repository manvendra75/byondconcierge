#!/usr/bin/env node
// TC.5b — Disney agent-portal login helper (session capture, NOT credential capture).
//
// Opens a REAL visible browser to the Disney Travel Agents login. YOU log in there (username,
// password, any MFA) directly in the browser — nothing is typed into this script, the terminal, or
// any file. When you're in, it saves ONLY the authenticated session (cookies/tokens) to
// storageState.json so the importer can reuse "you're logged in" without ever seeing your password.
//
// Setup (one-time, from website/):
//   npm install -D playwright
//   npx playwright install chromium
// Run:
//   node scripts/itinerary/auth-disney.mjs
// Re-run whenever the saved session expires (you'll just log in again — ~30 seconds).

import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

// Lazy playwright shim: load the package only when a browser is actually launched.
const chromium = { launch: async (...a) => (await import("playwright")).chromium.launch(...a) };

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
// The session file is SENSITIVE (it authenticates as you). Kept in the skill workdir, git-ignored.
const AUTH_DIR = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", "disney", ".auth");
const STATE_PATH = path.join(AUTH_DIR, "storageState.json");
const LOGIN_URL = "https://disneycruise.disney.go.com/travel-agent-login/";

// Pause until the user confirms they've finished logging in (their terminal, their keypress).
const waitForEnter = (msg) => new Promise((resolve) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  rl.question(msg, () => { rl.close(); resolve(); });
});

async function main() {
  // headless:false → a visible window you can interact with. A real Chrome channel + a normal
  // viewport makes the agent portal behave like an ordinary browser session.
  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();

  await page.goto(LOGIN_URL, { waitUntil: "domcontentloaded" });
  console.log("\nA browser window opened at the Disney Travel Agents login.");
  console.log("→ Log in there (accept cookies, enter your agent credentials, complete any MFA).");
  console.log("→ When you can see the agent dashboard / cruise search, come back here.\n");

  await waitForEnter("Press ENTER once you are fully logged in… ");

  // Save the authenticated session (cookies + localStorage) — NOT the credentials.
  const fs = await import("node:fs");
  fs.mkdirSync(AUTH_DIR, { recursive: true });
  await context.storageState({ path: STATE_PATH });
  console.log(`\nSaved session → ${path.relative(ROOT, STATE_PATH)}`);
  console.log("Keep this file private — it authenticates as you. Do not commit or share it.");
  console.log("Next: node scripts/itinerary/survey-disney.mjs\n");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
