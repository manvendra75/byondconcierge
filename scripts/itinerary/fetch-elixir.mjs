#!/usr/bin/env node
// fetch-elixir.mjs — acquire Elixir Cruises' dated Greek-yacht voyages with day-by-day.
//
// elixir-cruises.com (Yacht Cruise Company) is a small server-rendered site; robots.txt is fully
// permissive. Each cruise page carries the itinerary in its HTML: an <h1> name, an "N DAYS" duration,
// a "DAY n  <port>" day-by-day, and a "Departure dates:" block of weekly departures grouped by month
// ("May 1, 8, 15  June 5, 12 …"). Plain HTTP fetches, no browser, no prices. Only cruises that publish
// dates are kept (a dated line needs a date); the season-only pages (Aegean Horizon, Red Sea) are
// skipped + logged, never guessed.
//
//   • sitemap /sitemap.xml → candidate pages; keep those with a real day-by-day (≥4 "DAY n" rows).
//   • per page → name, nights, day-by-day, destination, and the parsed departure dates.
//
// Run (from conversational-engine/):
//   node scripts/itinerary/fetch-elixir.mjs
//   node scripts/itinerary/fetch-elixir.mjs --year 2026

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { elixirDest } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
const BASE = "https://www.elixir-cruises.com";
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

function arg(name, def = null) { const i = process.argv.indexOf(`--${name}`); return i >= 0 ? process.argv[i + 1] : def; }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clean = (s) => String(s || "").replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#\d+;/g, " ").replace(/\s+/g, " ").trim();
const MON = { january: "01", february: "02", march: "03", april: "04", may: "05", june: "06", july: "07", august: "08", september: "09", october: "10", november: "11", december: "12" };

async function get(url) {
  const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.text();
}

// Non-cruise pages to skip outright (ships, info, journeys hub).
const SKIP = /\/(the-yacht-|about-us|contact|rates-and-included|specialty-cruises|elysium-journeys|faq|indian-summer-2025)$|\/$|sitemap/i;

// Parse the "DAY n  <port>  …description…" day-by-day. The port is the text on the DAY heading line;
// island-hop days (e.g. "Delos-Mykonos") keep both, sea/sailing days are flagged.
function parseDays(lines) {
  const days = [];
  for (const l of lines) {
    const m = l.match(/^DAY\s*(\d+)\s+(.+)$/i);
    if (!m) continue;
    const port = m[2].replace(/\s+port$/i, "").trim();
    const sea = /at sea|sailing day|cruising/i.test(port);
    days.push({ day: Number(m[1]), port: sea ? "At Sea" : port, is_sea_day: sea });
  }
  // de-dupe by day number, sort
  const seen = new Set();
  return days.filter((d) => (seen.has(d.day) ? false : seen.add(d.day))).sort((a, b) => a.day - b.day);
}

// Parse the departure-date block ("April 10, 24  May 1, 8, 15 …") into ISO dates for the given year.
function parseDates(lines, year) {
  // Take lines from "Departure dates" onward that mention a month + day numbers.
  const start = lines.findIndex((l) => /departure dates/i.test(l));
  const region = (start >= 0 ? lines.slice(start, start + 12) : lines).join(" ");
  const dates = [];
  let curMonth = null;
  // Tokenize into month names and day numbers, in order.
  for (const tok of region.match(/[A-Za-z]+|\d{1,2}/g) || []) {
    const mo = MON[tok.toLowerCase()];
    if (mo) { curMonth = mo; continue; }
    const day = Number(tok);
    if (curMonth && day >= 1 && day <= 31) dates.push(`${year}-${curMonth}-${String(day).padStart(2, "0")}`);
  }
  return [...new Set(dates)];
}

async function main() {
  const generated = arg("date", new Date().toISOString().slice(0, 10));
  const defaultYear = Number(arg("year", 2026));

  const sitemap = await get(`${BASE}/sitemap.xml`);
  const urls = [...sitemap.matchAll(/<loc>([^<]+)<\/loc>/g)].map((m) => m[1]).filter((u) => !SKIP.test(new URL(u).pathname));
  console.log(`Sitemap: ${urls.length} candidate pages.`);

  const itineraries = [];
  let skippedNoDates = 0, skippedNoDays = 0;
  for (const url of urls) {
    try {
      const html = await get(url);
      const lines = html.replace(/<script[\s\S]*?<\/script>/g, " ").replace(/<style[\s\S]*?<\/style>/g, " ")
        .replace(/<[^>]+>/g, "\n").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&").replace(/&#38;/g, "&").replace(/&#\d+;/g, " ")
        .split("\n").map((l) => l.trim()).filter(Boolean);

      const days = parseDays(lines);
      if (days.length < 4) { skippedNoDays++; continue; }        // not a real cruise page

      const slug = new URL(url).pathname.replace(/^\//, "");
      let name = clean((html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1]);
      if (!name || name.length < 3) name = slug.replace(/-/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
      // Year: from the name/slug if it names one, else the default season year.
      const yearM = `${name} ${slug}`.match(/\b(20\d{2})\b/);
      const year = yearM ? Number(yearM[1]) : defaultYear;

      const dates = parseDates(lines, year);
      if (!dates.length) { skippedNoDates++; console.log(`  – no dates: ${slug}`); continue; }

      const daysLine = lines.find((l) => /\d+\s*DAYS/i.test(l)) || "";
      const nights = (Number((daysLine.match(/(\d+)\s*DAYS/i) || [])[1]) || days.length) - 1;
      const ship = (html.match(/elysium/gi) || []).length > (html.match(/gemaya/gi) || []).length ? "M/Y Elysium" : "M/Y Gemaya";
      const dest = elixirDest(name, days.map((d) => d.port));

      itineraries.push({
        ship, name: clean(name), nights,
        departPort: days[0]?.port, arrivePort: days[days.length - 1]?.port,
        dest, days, dates: dates.sort(),
      });
      console.log(`  ✓ ${name.slice(0, 34).padEnd(34)} ${nights}n · ${days.length} days · ${dates.length} departures · ${ship.replace("M/Y ", "")}`);
    } catch (e) { console.log(`  ! ${url}: ${e.message.slice(0, 50)}`); }
    await sleep(150);
  }

  const departures = itineraries.reduce((n, i) => n + i.dates.length, 0);
  const obj = { generated, line: "elixir", source: `${BASE}: cruise pages (day-by-day + departure dates, no prices)`, itineraries };
  fs.mkdirSync(OUT_DIR, { recursive: true });
  const outPath = path.join(OUT_DIR, `elixir-itineraries-${generated}.json`);
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`\nWrote ${path.relative(ROOT, outPath)}`);
  console.log(`  ${itineraries.length} cruises · ${departures} dated departures · skipped ${skippedNoDates} no-dates / ${skippedNoDays} non-cruise`);
}

main().catch((e) => { console.error(e); process.exit(1); });
