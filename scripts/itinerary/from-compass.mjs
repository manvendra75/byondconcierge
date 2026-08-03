#!/usr/bin/env node
// TC.5a — Compass → engine day-by-day adapter.
//
// The `cruise-line-scraper` skill produces a canonical extract per line
// (`itineraries.json` + `ships.json` + `sailings.json` + `ports.json`). This adapter maps that into
// the engine's per-line day-by-day dataset, `<slug>-itineraries-<date>.json`, exactly as pinned in
// docs/research/itinerary-acquisition.md §3–§4. It is the ONE shared mapping every acquired line
// flows through — no bespoke per-line code.
//
// WORKFLOW (TC.5b, one line at a time):
//     node scripts/itinerary/from-compass.mjs --in <extracted-dir> --line <slug> [--date YYYY-MM-DD]
// where <extracted-dir> holds the skill's four JSON arrays for that line. Output lands in
// docs/research/cruise-lines/ for the builder (TC.6) to merge.
//
// The mapping (skill canonical -> engine canonical):
//   name, nights   <- itineraries.name / .nights
//   ship           <- itineraries.ship_id  -> ships.json name
//   departPort     <- itineraries.embark_port_id -> ports.json name
//   arrivePort     <- last non-sea-day port -> ports.json name
//   days[].day/is_sea_day <- passed through 1:1 (is_sea_day stays snake_case for the engine model)
//   days[].port    <- days[].port_id -> ports.json name ("At Sea" when a sea day has no port)
//   dates          <- ALL sailings.depart_date for the itinerary (sorted, unique) — one output
//                     itinerary per ROUTE, not per departure, so the coverage upgrade (TC.6) can
//                     match every base departure by exact date without bloating the snapshot
//   days           <- a reusable, DATELESS template ({day, port, is_sea_day}); every consumer (the
//                     TC.6 merge, the Disney replacement) derives each day's date from a chosen
//                     departure, so we never bake one departure's calendar into the shared route
//
// A self-validation guard (validateOutput) runs before anything is written, so a malformed mapping
// fails loudly here rather than at the TC.6 merge. main() runs only when executed directly, so the
// pure functions can be unit-tested (from-compass.test.mjs) without touching the filesystem.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { isDestination } from "./classify.mjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// scripts/itinerary -> scripts -> conversational-engine -> repo root (Marketing). Same anchoring as the builder.
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OUT_DIR = path.join(ROOT, "docs", "research", "cruise-lines");

// ---------------------------------------------------------------------------------------
// Slug map — the skill's line slugs differ from the engine's for a few lines
// ---------------------------------------------------------------------------------------
// The engine's line slugs are the source of truth (they key the sailings records). Where the skill
// uses a different slug, translate it; everything else passes through unchanged.
// Exported so a guard can assert every target is a REAL engine line slug (see from-compass.test.mjs):
// a typo here, or an engine-side slug rename, would otherwise make the adapter emit a dataset for a
// phantom line that silently never merges at TC.6.
export const SLUG_MAP = { rcl: "royal-caribbean", ncl: "norwegian", "resort-world": "dream-star", dream: "dream-star" };
export function engineSlug(slug) {
  return SLUG_MAP[slug] || slug;
}

// ---------------------------------------------------------------------------------------
// Small guards reused by the mapper and the validator
// ---------------------------------------------------------------------------------------
// Currency symbols / ISO codes — the no-price rule. Deliberately conservative (symbols + whole-word
// codes) to avoid flagging legitimate place names; the engine's no_currency_in_itinerary (TC.3) is
// the authoritative backstop after the merge.
const CURRENCY_RE = /[$€£¥₹₩]|\b(?:USD|EUR|GBP|AED|SAR|CAD|AUD|JPY)\b/i;

// A strict, real YYYY-MM-DD — the same discipline the engine's date search relies on (string
// comparison must sort chronologically), so we reject a lenient form like "2026-8-1".
function isStrictDate(s) {
  if (typeof s !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false;
  const [y, m, d] = s.split("-").map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

// ---------------------------------------------------------------------------------------
// The mapping — pure, no I/O (so it's unit-testable)
// ---------------------------------------------------------------------------------------
// Takes the four parsed skill arrays plus run metadata; returns the engine canonical object. It
// joins the reusable itinerary TEMPLATE (undated `days`) to its dated SAILINGS: one output itinerary
// per dated instance (mirroring how the engine stores one record per departure for dated lines).
// An itinerary with no sailings yields a single undated template (dateless days, like Elixir).
export function mapCompass({ itineraries, ships, sailings, ports }, { line, generated, source }) {
  // id -> display name lookups for ships and ports.
  const shipName = new Map((ships || []).map((s) => [s.id, s.name]));
  const portName = new Map((ports || []).map((p) => [p.id, p.name]));

  // Group dated sailings by the template they instantiate.
  const sailingsByItin = new Map();
  for (const sl of sailings || []) {
    if (!sailingsByItin.has(sl.itinerary_id)) sailingsByItin.set(sl.itinerary_id, []);
    sailingsByItin.get(sl.itinerary_id).push(sl);
  }

  const out = [];
  for (const itin of itineraries || []) {
    const ship = shipName.get(itin.ship_id) || itin.ship_id;
    const departPort = portName.get(itin.embark_port_id) || itin.embark_port_id;

    // Build the undated template days, in day order. Resolve the port name; keep a named scenic
    // place even on a sea day (like Crystal's "Hubbard Glacier"), falling back to "At Sea" only when
    // a sea day has no port_id. Non-sea days with an unresolved id keep the raw id rather than guess.
    const templateDays = [...(itin.days || [])]
      .sort((a, b) => a.day - b.day)
      .map((d) => ({
        day: d.day,
        port: portName.get(d.port_id) || (d.is_sea_day ? "At Sea" : d.port_id),
        is_sea_day: Boolean(d.is_sea_day),
      }));

    // Arrival port = the last day the ship is actually in port (round trips end back at embark).
    const lastCall = [...templateDays].reverse().find((d) => !d.is_sea_day) || templateDays[templateDays.length - 1];
    const arrivePort = lastCall ? lastCall.port : departPort;

    const base = { ship, name: itin.name, nights: itin.nights, departPort, arrivePort };
    // Carry the canonical destination the importer classified (TD.2), so the builder's generic path
    // reads it straight off the snapshot. Optional here (validated in validateOutput when present).
    if (itin.dest !== undefined) base.dest = itin.dest;
    const instances = sailingsByItin.get(itin.id) || [];

    // One output itinerary per ROUTE. Collect every departure date (sorted, unique) into `dates[]`;
    // the days stay a DATELESS template. A route with no sailings is simply dateless, like Elixir.
    // This is what makes the coverage upgrade cheap: the merge (TC.6) registers an exact-date key for
    // each entry in `dates[]`, so any base departure lands on its precise route without duplicating
    // the day list once per departure.
    const dates = [...new Set(instances.map((sl) => sl.depart_date).filter(Boolean))].sort();
    const outItin = { ...base, days: templateDays.map((d) => ({ ...d })) };
    if (dates.length) outItin.dates = dates;
    out.push(outItin);
  }

  return {
    generated,
    line: engineSlug(line),
    source: source || `cruise-line-scraper: ${line}`,
    itineraries: out,
  };
}

// ---------------------------------------------------------------------------------------
// Self-validation — the pre-merge format guard (throws)
// ---------------------------------------------------------------------------------------
// Enforces the canonical contract (acquisition doc §3) BEFORE the file is written, so a bad mapping
// fails here rather than at the TC.6 merge or, worse, silently in the engine. Mirrors the build
// guard validateItineraryDays and the ItineraryDay model: shape, ordered days, sea-day flag, strict
// derived dates, and the no-price rule. Throws on the first violation.
export function validateOutput(obj) {
  if (!obj || typeof obj.line !== "string" || !Array.isArray(obj.itineraries)) {
    throw new Error("TC.5a: output must be { line, itineraries[] }");
  }
  if (!isStrictDate(obj.generated)) {
    throw new Error(`TC.5a: generated "${obj.generated}" is not a strict YYYY-MM-DD`);
  }
  for (const it of obj.itineraries) {
    const label = `${obj.line} "${it.name}"`;
    // Required top-level fields.
    for (const [k, ok] of [
      ["ship", typeof it.ship === "string" && it.ship.trim()],
      ["name", typeof it.name === "string" && it.name.trim()],
      ["nights", Number.isFinite(Number(it.nights))],
      ["departPort", typeof it.departPort === "string" && it.departPort.trim()],
      ["days", Array.isArray(it.days) && it.days.length > 0],
    ]) {
      if (!ok) throw new Error(`TC.5a: ${label} has a missing/invalid ${k}`);
    }
    // Departure dates (the new shape): a non-empty, strictly ascending (so unique + sorted) list of
    // real dates. The merge relies on that ordering for its exact-date keys.
    if (it.dates !== undefined) {
      if (!Array.isArray(it.dates) || !it.dates.length) throw new Error(`TC.5a: ${label} dates must be a non-empty array`);
      let prev = "";
      for (const dt of it.dates) {
        if (!isStrictDate(dt)) throw new Error(`TC.5a: ${label} date "${dt}" is not a strict YYYY-MM-DD`);
        if (prev && dt <= prev) throw new Error(`TC.5a: ${label} dates not strictly ascending/unique (${prev} -> ${dt})`);
        prev = dt;
      }
    }
    // Back-compat: an older single-date snapshot must still validate.
    if (it.date !== undefined && !isStrictDate(it.date)) {
      throw new Error(`TC.5a: ${label} date "${it.date}" is not a strict YYYY-MM-DD`);
    }
    // Destination (TD.2): when the importer classifies a canonical dest, it MUST be one of the 22
    // canonical destinations — a typo or a drifted classifier is caught here, at acquisition time,
    // rather than as an "Unmapped destination" throw deep in the build.
    if (it.dest !== undefined && !isDestination(it.dest)) {
      throw new Error(`TC.5a: ${label} dest "${it.dest}" is not a canonical destination`);
    }
    // No price anywhere in the rendered text.
    for (const s of [it.name, it.ship, it.departPort, it.arrivePort]) {
      if (s && CURRENCY_RE.test(String(s))) throw new Error(`TC.5a: ${label} carries currency in "${s}"`);
    }
    // Per-day checks: shape, ordering, sea-day flag, no price.
    let prevDay = 0;
    for (const d of it.days) {
      if (!Number.isInteger(d.day) || d.day < 1) throw new Error(`TC.5a: ${label} bad day number ${JSON.stringify(d.day)}`);
      if (d.day < prevDay) throw new Error(`TC.5a: ${label} day numbers go backwards (${prevDay} -> ${d.day})`);
      prevDay = d.day;
      if (typeof d.port !== "string" || !d.port.trim()) throw new Error(`TC.5a: ${label} day ${d.day} has an empty port`);
      if (typeof d.is_sea_day !== "boolean") throw new Error(`TC.5a: ${label} day ${d.day} is_sea_day is not a boolean`);
      if (CURRENCY_RE.test(d.port)) throw new Error(`TC.5a: ${label} day ${d.day} carries currency in "${d.port}"`);
      // New shape: days are a DATELESS route template — a route serves many departures, so a per-day
      // date on a route carrying `dates[]` is a mistake. (Old single-date snapshots may still carry
      // strict per-day dates; those are validated for form but not required.)
      if (d.date !== undefined) {
        if (!isStrictDate(d.date)) throw new Error(`TC.5a: ${label} day ${d.day} date "${d.date}" invalid`);
        if (it.dates !== undefined) throw new Error(`TC.5a: ${label} day ${d.day} carries a date but the route is a dateless template (dates[] present)`);
      }
    }
  }
  return obj;
}

// ---------------------------------------------------------------------------------------
// CLI — read the skill extract, map, validate, write
// ---------------------------------------------------------------------------------------
function parseArgs(argv) {
  const args = {};
  for (let i = 0; i < argv.length; i += 2) args[argv[i].replace(/^--/, "")] = argv[i + 1];
  return args;
}

function readJson(dir, file) {
  return JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
}

function main() {
  const { in: inDir, line, out = OUT_DIR, date } = parseArgs(process.argv.slice(2));
  if (!inDir || !line) {
    throw new Error("usage: from-compass.mjs --in <extracted-dir> --line <slug> [--out <dir>] [--date YYYY-MM-DD]");
  }
  const generated = date || new Date().toISOString().slice(0, 10);

  // Load the skill's four canonical arrays (sailings/ports optional for a pure-template line).
  const extract = {
    itineraries: readJson(inDir, "itineraries.json"),
    ships: readJson(inDir, "ships.json"),
    sailings: fs.existsSync(path.join(inDir, "sailings.json")) ? readJson(inDir, "sailings.json") : [],
    ports: readJson(inDir, "ports.json"),
  };

  const obj = mapCompass(extract, { line, generated });
  validateOutput(obj);                                  // throws on any contract violation

  const slug = engineSlug(line);
  const outPath = path.join(out, `${slug}-itineraries-${generated}.json`);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(outPath, JSON.stringify(obj) + "\n");
  console.log(`Wrote ${path.relative(ROOT, outPath)} — ${obj.itineraries.length} itineraries (line ${slug})`);
}

// Run only when executed directly, so the pure functions above are importable for tests.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) main();
