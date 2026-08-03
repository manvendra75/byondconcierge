#!/usr/bin/env node
// Reusable agent-portal login helper (session capture, NOT credential capture).
//
// Generalises auth-disney.mjs for any authenticated portal (Carnival/GoCCL, Costa/CostaExtra,
// MSC/mscbook, …). Opens a REAL visible browser at the portal login; YOU log in there (username,
// password, MFA) — nothing is typed into this script/terminal/any file. On ENTER it saves ONLY the
// authenticated session cookies so the importer can reuse "logged in" without ever seeing your password.
//
// Setup (one-time): npm install -D playwright ; npx playwright install chromium
// Run:
//   node scripts/itinerary/auth-portal.mjs --line carnival --url "<the portal login URL>"
// The session is saved to skills/cruise-line-scraper/workdir/<line>/.auth/storageState.json (git-ignored).

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

async function main() {
  const line = arg("line");
  const url = arg("url");
  if (!line || !url) throw new Error('usage: auth-portal.mjs --line <slug> --url "<login URL>"');

  const authDir = path.join(ROOT, "skills", "cruise-line-scraper", "workdir", line, ".auth");
  const statePath = path.join(authDir, "storageState.json");

  const browser = await chromium.launch({ headless: false, channel: "chrome" });
  const context = await browser.newContext({ viewport: { width: 1360, height: 900 } });
  const page = await context.newPage();
  await page.goto(url, { waitUntil: "domcontentloaded" }).catch(() => {});

  console.log(`\nA browser opened at the ${line} portal login.`);
  console.log("→ Log in there (accept cookies, enter your agent credentials, complete any MFA).");
  console.log("→ When you can see the agent dashboard / cruise search, come back here.\n");
  await waitForEnter("Press ENTER once you are fully logged in… ");

  const fs = await import("node:fs");
  fs.mkdirSync(authDir, { recursive: true });
  await context.storageState({ path: statePath });
  console.log(`\nSaved session → ${path.relative(ROOT, statePath)}`);
  console.log("Keep it private — it authenticates as you. It is git-ignored; do not commit or share it.\n");

  await browser.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
