// Tests for the shared destination classifier (TD.2). Run with:
//     node --test scripts/itinerary/classify.test.mjs

import assert from "node:assert";

import {
  CARNIVAL_DEST_CODE, DESTINATIONS, carnivalDest, classify, disneyDestForItin,
  disneyRegionOf, isDestination, silverseaDest,
} from "./classify.mjs";

// (1) Every Carnival code maps to a CANONICAL destination — no typos, nothing off-taxonomy.
for (const [code, dest] of Object.entries(CARNIVAL_DEST_CODE)) {
  assert.ok(isDestination(dest), `Carnival ${code} → "${dest}" is not canonical`);
}
assert.strictEqual(Object.keys(CARNIVAL_DEST_CODE).length, 40, "expected all 40 live Carnival codes");
assert.strictEqual(carnivalDest("BH"), "Bahamas");
assert.strictEqual(carnivalDest("CS"), "Caribbean");        // Southern Caribbean → Caribbean
assert.strictEqual(carnivalDest("GL"), "Alaska");
assert.throws(() => carnivalDest("ZZ"), /unmapped Carnival destinationCode/);
console.log("  ok  — all 40 Carnival codes canonical; unmapped throws");

// (2) Disney: region phrase extraction + classification, including the Singapore-by-port case.
assert.strictEqual(disneyRegionOf("5-Night Pacific Coast Cruise from Vancouver ending in San Diego"), "Pacific Coast");
assert.strictEqual(disneyDestForItin({ name: "5-Night Pacific Coast Cruise from Vancouver ending in San Diego", departPort: "Vancouver" }), "North America & Canada");
assert.strictEqual(disneyDestForItin({ name: "3-Night Bahamian Cruise from Port Canaveral", departPort: "Port Canaveral" }), "Bahamas");
assert.strictEqual(disneyDestForItin({ name: "3-Night Cruise from Singapore", departPort: "Singapore" }), "Southeast Asia");
assert.strictEqual(disneyDestForItin({ name: "Totally Unclassifiable Voyage", departPort: "Nowhere" }), null);   // skip, never guess
console.log("  ok  — Disney region + port classification (incl. Singapore, incl. null skip)");

// (3) Silversea: page-data destination name → canonical (case-insensitive); unmapped throws.
assert.strictEqual(silverseaDest("MEDITERRANEAN"), "Mediterranean");
assert.strictEqual(silverseaDest("CARIBBEAN & CENTRAL AMERICA"), "Caribbean");
assert.strictEqual(silverseaDest("ANTARCTICA"), "Expedition (Polar)");
assert.strictEqual(silverseaDest("GALÁPAGOS ISLANDS"), "South America");
assert.throws(() => silverseaDest("Nonexistent Region"), /unmapped Silversea destination/);
console.log("  ok  — Silversea destination mapping (case-insensitive); unmapped throws");

// (4) Dispatcher reads the natural per-line signal, and accepts an already-canonical dest.
assert.strictEqual(classify("carnival", { destinationCode: "CW", name: "Western Caribbean from Miami" }), "Caribbean");
assert.strictEqual(classify("disney", { name: "7-Night Alaskan Cruise from Vancouver", departPort: "Vancouver" }), "Alaska");
assert.strictEqual(classify("silversea", { region: "Alaska", name: "x" }), "Alaska");
assert.strictEqual(classify("aroya", { dest: "Red Sea", name: "curated" }), "Red Sea");   // curated passthrough
assert.throws(() => classify("aroya", { name: "no dest, no classifier" }), /no classifier for line/);
console.log("  ok  — dispatcher per line + curated passthrough");

// Sanity: the taxonomy has the expected size.
assert.strictEqual(DESTINATIONS.size, 22);

console.log("\nAll classify tests passed.");
