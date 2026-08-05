#!/usr/bin/env node
// fetch-crystal.mjs — acquire Crystal Cruises' dated voyages with day-by-day from crystalcruises.com.
//
// crystalcruises.com is a Next.js site. Each voyage detail page /cruises/<slug> embeds the full,
// structured voyage in its <script id="__NEXT_DATA__"> payload (props.pageProps.result) — server-
// rendered, no browser, no auth. There's no robots.txt (404), so nothing is disallowed; we still
// fetch politely and read no prices. Standard voyages carry a clean `itineraries[]` (one entry per
// day: day number, per-day date, resolved port.city/country, sea days flagged country "At sea").
// A handful of A&K land-combo pages instead use `dayByDay[]` and have no port schedule — those are
// best-effort by day title, and skipped when no ports resolve (logged, never guessed).
//
//   • sitemap /sitemap-0.xml → every /cruises/<slug> URL (enumeration).
//   • GET /cruises/<slug>    → __NEXT_DATA__.result → name, ship, nights, destination, embark date,
//     and the day-by-day (from itineraries[], or dayByDay[] for combos).
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-crystal.mjs                 # full (~267 voyages)
//   node scripts/itinerary/fetch-crystal.mjs --limit 15      # quick test

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { crystalDest } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const BASE = "https://www.crystalcruises.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const decode = (s) => String(s || "").replace(/&amp;/g, "&").replace(/&#x27;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, " ").trim();

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Pull the __NEXT_DATA__ voyage object out of a detail page.
function nextData(html) {
  const m = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (!m) return null;
  try { return JSON.parse(m[1]).props?.pageProps?.result || null; } catch { return null; }
}

// A day is "at sea" when its port has no real country (Crystal marks these country "At sea" / code ZZ).
function isSea(port) {
  const city = String(port?.city || ""), country = String(port?.country || "");
  return /at sea/i.test(country) || port?.countryCode === "ZZ" || /^day at sea$/i.test(city);
}

// Day-by-day from a standard voyage's itineraries[] (one entry per day, already ordered).
function daysFromItineraries(itineraries) {
  const days = [];
  for (const it of itineraries) {
    const sea = isSea(it.port);
    const port = sea ? "At Sea" : decode(it.port?.city);
    if (!port) continue;
    days.push({ day: Number(it.day), port, is_sea_day: sea });
  }
  return days.sort((a, b) => a.day - b.day);
}

async function main() {
  const limit = arg("limit") ? Number(arg("limit")) : Infinity;
  const delay = Number(arg("delay", 150));
  const generated = arg("date", new Date().toISOString().slice(0, 10));

  // ---- 1) Enumerate voyage detail pages from the sitemap ----
  const sitemap = await get(`${BASE}/sitemap-0.xml`);
  const slugs = [...new Set([...sitemap.matchAll(/<loc>https:\/\/www\.crystalcruises\.com\/cruises\/([^<]+)<\/loc>/g)].map((m) => m[1]))];
  console.log(`Sitemap: ${slugs.length} voyage pages.`);

  // ---- 2) Per voyage: __NEXT_DATA__ → meta + day-by-day + embark date ----
  const itineraries = [];
  const unmappedDest = new Set();
  let done = 0, noSchedule = 0, noDate = 0, failed = 0;
  for (const slug of slugs.slice(0, limit)) {
    try {
      const r = nextData(await get(`${BASE}/cruises/${slug}`));
      if (!r) { failed++; continue; }

      const name = decode(r.title || r.voyageName);
      const ship = decode(r.shipInfo?.name || r.shipInfo?.title);
      const nights = Number(r.duration) || undefined;
      const dest = crystalDest(r.destination?.title);
      if (!dest) unmappedDest.add(`${r.destination?.title} / ${name.slice(0, 30)}`);
      const date = (r.embarkDate || "").slice(0, 10);
      if (!date) { noDate++; continue; }                     // a dated line needs the embark date

      // Standard voyages give itineraries[]; combos give dayByDay[] (best-effort, may yield no ports).
      const days = Array.isArray(r.itineraries) && r.itineraries.length ? daysFromItineraries(r.itineraries) : [];
      if (!days.length) { noSchedule++; continue; }          // no resolvable schedule → skip (never invent)

      itineraries.push({
        ship, name, nights,
        departPort: days[0]?.port,
        arrivePort: days[days.length - 1]?.port,
        ...(dest ? { dest } : {}),
        days,
        dates: [date],
      });
    } catch (e) { failed++; if (failed <= 5) console.log(`  ! ${slug.slice(0, 40)}: ${e.message.slice(0, 50)}`); }
    if (++done % 40 === 0) console.log(`  ${done}/${Math.min(slugs.length, limit)} (voyages ${itineraries.length}, no-schedule ${noSchedule}, no-date ${noDate}, fail ${failed})`);
    await sleep(delay);
  }

  if (unmappedDest.size) console.log(`Unmapped dest (omitted): ${[...unmappedDest].slice(0, 10).join(" | ")}${unmappedDest.size > 10 ? " …" : ""}`);
  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = {
    generated, line: "crystal",
    source: "crystalcruises.com __NEXT_DATA__: /cruises/<slug> voyage pages (day-by-day + embark date, no prices)",
    itineraries,
  };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `crystal-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} voyages · ${departures} dated departures · skipped ${noSchedule} no-schedule / ${noDate} no-date · ${failed} failed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
