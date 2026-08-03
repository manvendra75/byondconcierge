// Tests for the Compass -> engine day-by-day adapter (TC.5a).
//
// Proves the mapping and the pre-merge self-validation on a sample skill extract, without touching
// the filesystem (main() is import-guarded). Run with:
//     node scripts/itinerary/from-compass.test.mjs

import assert from "node:assert";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { mapCompass, SLUG_MAP, validateOutput } from "./from-compass.mjs";

// A small Silversea-style extract: one dated itinerary (with a pure sea day) instantiated by three
// sailings — including a month-boundary departure — plus one template with no sailing.
const ships = [{ id: "silversea:ship:silver-dawn", line: "silversea", name: "Silver Dawn" }];
const ports = [
  { id: "silversea:port:lisbon", line: "silversea", name: "Lisbon", country: "Portugal" },
  { id: "silversea:port:cartagena", line: "silversea", name: "Cartagena" },
  { id: "silversea:port:barcelona", line: "silversea", name: "Barcelona" },
];
const itineraries = [
  {
    id: "silversea:itin:lisbon-barcelona", line: "silversea", name: "Lisbon to Barcelona",
    ship_id: "silversea:ship:silver-dawn", region: "Mediterranean", nights: 2,
    embark_port_id: "silversea:port:lisbon",
    days: [
      { day: 1, port_id: "silversea:port:lisbon", is_sea_day: false, depart: "18:00" },
      { day: 2, port_id: null, is_sea_day: true },                       // pure sea day -> "At Sea"
      { day: 3, port_id: "silversea:port:barcelona", is_sea_day: false },
    ],
  },
  {
    id: "silversea:itin:template-only", line: "silversea", name: "Template Only",
    ship_id: "silversea:ship:silver-dawn", nights: 1, embark_port_id: "silversea:port:cartagena",
    days: [
      { day: 1, port_id: "silversea:port:cartagena", is_sea_day: false },
      { day: 2, port_id: "silversea:port:barcelona", is_sea_day: false },
    ],
  },
];
const sailings = [
  { id: "s1", line: "silversea", itinerary_id: "silversea:itin:lisbon-barcelona", depart_date: "2026-09-14", return_date: "2026-09-16", status: "on_sale" },
  { id: "s2", line: "silversea", itinerary_id: "silversea:itin:lisbon-barcelona", depart_date: "2026-10-05", return_date: "2026-10-07", status: "on_sale" },
  { id: "s3", line: "silversea", itinerary_id: "silversea:itin:lisbon-barcelona", depart_date: "2026-09-30", return_date: "2026-10-02", status: "on_sale" },
];

const out = mapCompass({ itineraries, ships, sailings, ports }, { line: "silversea", generated: "2026-08-01" });

// (1) Shape: one output itinerary PER ROUTE now (not per departure). The routed itinerary + the
// template = 2 outputs; the three sailings collapse into the route's `dates[]`.
assert.strictEqual(out.line, "silversea");
assert.strictEqual(out.itineraries.length, 2);
console.log("  ok  — one output per route (route + template = 2)");

// (2) The routed itinerary carries ALL departure dates (sorted, unique) and a DATELESS day template
// with sea days preserved and ports resolved.
const route = out.itineraries.find((it) => it.name === "Lisbon to Barcelona");
assert.deepStrictEqual(route.dates, ["2026-09-14", "2026-09-30", "2026-10-05"]);   // sorted
assert.deepStrictEqual(route.days, [
  { day: 1, port: "Lisbon", is_sea_day: false },
  { day: 2, port: "At Sea", is_sea_day: true },     // null port_id sea day -> "At Sea"
  { day: 3, port: "Barcelona", is_sea_day: false },
]);
assert.strictEqual(route.ship, "Silver Dawn");
assert.strictEqual(route.departPort, "Lisbon");
assert.strictEqual(route.arrivePort, "Barcelona");   // last non-sea-day port
console.log("  ok  — route carries sorted dates[], dateless day template, ports resolved");

// (3) The template-only itinerary (no sailing) is undated: no dates, days carry no date.
const template = out.itineraries.find((it) => it.name === "Template Only");
assert.strictEqual(template.dates, undefined);
assert.ok(template.days.every((d) => d.date === undefined));
console.log("  ok  — itinerary with no sailing stays an undated template");

// (4) The whole mapped object passes the self-validation guard.
assert.doesNotThrow(() => validateOutput(out));
console.log("  ok  — mapped output passes validateOutput");

// (5) Slug mapping: the skill's "ncl" becomes the engine's "norwegian".
const ncl = mapCompass({ itineraries: [], ships: [], sailings: [], ports: [] }, { line: "ncl", generated: "2026-08-01" });
assert.strictEqual(ncl.line, "norwegian");
console.log("  ok  — slug mapped ncl -> norwegian");

// (5b) Destination (TD.2): a canonical `dest` on the input itinerary passes through to the output and
// validates; a non-canonical one is rejected by validateOutput.
const withDest = mapCompass(
  { itineraries: [{ ...itineraries[0], dest: "Mediterranean" }], ships, sailings, ports },
  { line: "silversea", generated: "2026-08-01" },
);
assert.strictEqual(withDest.itineraries[0].dest, "Mediterranean");
assert.doesNotThrow(() => validateOutput(withDest));
const badDest = JSON.parse(JSON.stringify(withDest));
badDest.itineraries[0].dest = "Atlantis";
assert.throws(() => validateOutput(badDest), /not a canonical destination/);
console.log("  ok  — canonical dest passes through; a non-canonical dest is rejected");

// (6) The guard catches drift: a currency in a day port label must throw.
const priced = JSON.parse(JSON.stringify(out));
priced.itineraries[0].days[0].port = "Lisbon from €499";
assert.throws(() => validateOutput(priced), /currency/, "expected a currency throw");
console.log("  ok  — validateOutput rejects a price in a day label");

// (7) The guard rejects a per-day date on a route that carries dates[] (the days must be a dateless
// template — a route serves many departures).
const datedTemplate = JSON.parse(JSON.stringify(route));
datedTemplate.days[0].date = "2026-09-14";
assert.throws(() => validateOutput({ generated: "2026-08-01", line: "silversea", itineraries: [datedTemplate] }),
  /dateless template/);
console.log("  ok  — validateOutput rejects a per-day date on a dates[] route");

// (8) The guard rejects an unsorted / duplicate dates[] (the merge relies on strict ordering).
const unsorted = JSON.parse(JSON.stringify(route));
unsorted.dates = ["2026-10-05", "2026-09-14"];
assert.throws(() => validateOutput({ generated: "2026-08-01", line: "silversea", itineraries: [unsorted] }),
  /ascending/);
console.log("  ok  — validateOutput rejects unsorted dates[]");

// (8b) Back-compat: an older single-date snapshot (top-level date + dated days) still validates.
const legacy = { generated: "2026-08-01", line: "silversea", itineraries: [{
  ship: "Silver Dawn", name: "Legacy", nights: 2, departPort: "Lisbon", arrivePort: "Barcelona",
  date: "2026-09-14",
  days: [{ day: 1, date: "2026-09-14", port: "Lisbon", is_sea_day: false }],
}] };
assert.doesNotThrow(() => validateOutput(legacy));
console.log("  ok  — validateOutput still accepts a legacy single-date snapshot");

// (9) Slug-map consistency: every SLUG_MAP target must be a REAL engine line slug present in the
// built sailings index — otherwise the adapter would emit a dataset for a phantom line that never
// merges. This catches both a typo here and an engine-side slug rename.
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const INDEX = path.resolve(__dirname, "..", "..", "data", "sailings-index.json");
const realSlugs = new Set(JSON.parse(fs.readFileSync(INDEX, "utf8")).records.map((r) => r.line));
const badTargets = [...new Set(Object.values(SLUG_MAP))].filter((slug) => !realSlugs.has(slug));
assert.deepStrictEqual(badTargets, [], `SLUG_MAP targets not found among real engine line slugs: ${badTargets}`);
console.log(`  ok  — all SLUG_MAP targets are real engine line slugs (${[...new Set(Object.values(SLUG_MAP))].join(", ")})`);

console.log("\nAll from-compass adapter tests passed.");
