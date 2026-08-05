// Negative tests for the build-time day-by-day guard (TC.2).
//
// The build itself proves the guard passes on real data (`npm run build:index` prints
// "[days] day-by-day invariant OK"). These cases prove it actually CATCHES drift — a malformed or
// fabricated itineraryDays that a parser regression could introduce. Run with:
//
//     node scripts/build-guards.test.mjs
//
// Importing the build module does NOT trigger a rebuild (the script guards its main() on
// import.meta), so the guard can be exercised in isolation.

import assert from "node:assert";

import { buildFromAcquired, validateItineraryDays } from "./build-sailings-index.mjs";

// A minimal well-formed record for each day-by-day line. The guard requires EVERY day-by-day line
// to emit a schedule, so a valid fixture set must cover all of them: two come from the source
// markdown (Crystal dated, Elixir undated); three sourced from acquisition — Carnival, Silversea
// AND Disney are all dated (each carries a real departure date). `baseline()` returns one of each so
// a negative test can exercise a single drift without tripping the coverage requirement.
const goodCrystal = () => ({
  line: "crystal", name: "Vancouver to Seward", itineraryDays: [
    { day: 1, date: "2026-07-11", port: "Vancouver", is_sea_day: false },
    { day: 2, date: "2026-07-12", port: "Hubbard Glacier", is_sea_day: true },
  ],
});
const goodElixir = () => ({
  line: "elixir", name: "Aegean Escape", itineraryDays: [
    { day: 1, port: "Lavrion – Kythnos", is_sea_day: false },
    { day: 2, port: "Sifnos", is_sea_day: false },
  ],
});
const goodCarnival = () => ({
  line: "carnival", name: "Bahamas from Miami", itineraryDays: [
    { day: 1, date: "2026-08-01", port: "Miami", is_sea_day: false },
    { day: 2, date: "2026-08-02", port: "At Sea", is_sea_day: true },
  ],
});
const goodSilversea = () => ({
  line: "silversea", name: "Rome to Athens", itineraryDays: [
    { day: 1, date: "2026-08-01", port: "Civitavecchia (Rome)", is_sea_day: false },
    { day: 2, date: "2026-08-02", port: "Naples", is_sea_day: false },
  ],
});
const goodDisney = () => ({
  line: "disney", name: "5-Night Bahamian from Port Canaveral", itineraryDays: [
    { day: 1, date: "2026-08-01", port: "Port Canaveral", is_sea_day: false },   // Disney is dated (TE/Disney-dates fix)
    { day: 2, date: "2026-08-02", port: "Nassau", is_sea_day: false },
  ],
});
const goodCosta = () => ({
  line: "costa", name: "Western Mediterranean", itineraryDays: [
    { day: 1, date: "2026-08-06", port: "Savona", is_sea_day: false },   // Costa is dated (CostaClick API, TD.12)
    { day: 2, date: "2026-08-07", port: "At Sea", is_sea_day: true },
  ],
});
// Valid records covering EVERY day-by-day line — the coverage floor for a negative fixture.
const baseline = () => [goodCrystal(), goodElixir(), goodCarnival(), goodSilversea(), goodDisney(), goodCosta()];

// A tiny assertion helper: the guard must throw, and its message must mention the reason.
function mustThrow(records, needle, label) {
  assert.throws(() => validateItineraryDays(records), (e) => e.message.includes(needle),
    `expected a throw mentioning "${needle}" for: ${label}`);
  console.log(`  ok  — ${label}`);
}

// (0) The happy path passes.
assert.doesNotThrow(() => validateItineraryDays(baseline()));
console.log("  ok  — a well-formed record for every day-by-day line passes");

// (1) A line silently stops emitting a schedule (parser broke) -> caught. Drop Elixir from the
// baseline so only its schedule is missing; the guard names the first uncovered line.
mustThrow(baseline().filter((r) => r.line !== "elixir"),
  "elixir emits no itineraryDays", "missing an entire day-by-day line");

// (2) The field leaks onto a line that shouldn't carry it -> caught. (Norwegian is NOT a day-by-day
// line — Costa used to be the example here, but it's now acquired with day-by-day, TD.12.)
mustThrow([...baseline(), { line: "norwegian", name: "Fjords loop", itineraryDays: [{ day: 1, port: "Bergen", is_sea_day: false }] }],
  "norwegian record unexpectedly carries itineraryDays", "field leaking onto another line");

// (3) A dated line (Crystal) with a day missing its date -> caught (never ship a dateless dated day).
const crystalNoDate = goodCrystal();
crystalNoDate.itineraryDays[1] = { day: 2, port: "Hubbard Glacier", is_sea_day: true };  // date dropped
mustThrow([...baseline().filter((r) => r.line !== "crystal"), crystalNoDate], "lacks a valid date", "dated line with a dateless day");

// (4) An undated line (Elixir) with a fabricated date -> caught (we never invent a date).
const elixirWithDate = goodElixir();
elixirWithDate.itineraryDays[0] = { day: 1, date: "2026-05-01", port: "Lavrion", is_sea_day: false };
mustThrow([...baseline().filter((r) => r.line !== "elixir"), elixirWithDate], "unexpectedly carries a date", "undated line with a fabricated date");

// (5) Day numbers going backwards (scrambled parse) -> caught.
const scrambled = goodElixir();
scrambled.itineraryDays = [{ day: 3, port: "Sifnos", is_sea_day: false }, { day: 1, port: "Lavrion", is_sea_day: false }];
mustThrow([...baseline().filter((r) => r.line !== "elixir"), scrambled], "day numbers go backwards", "day numbers out of order");

// (6) An empty port label -> caught.
const emptyPort = goodElixir();
emptyPort.itineraryDays = [{ day: 1, port: "   ", is_sea_day: false }];
mustThrow([...baseline().filter((r) => r.line !== "elixir"), emptyPort], "has an empty port", "empty port label");

// (7) A non-boolean is_sea_day -> caught.
const badFlag = goodElixir();
badFlag.itineraryDays = [{ day: 1, port: "Lavrion", is_sea_day: "no" }];
mustThrow([...baseline().filter((r) => r.line !== "elixir"), badFlag], "is_sea_day is not a boolean", "non-boolean is_sea_day");

// (8) An impossible calendar date on a dated line -> caught.
const badDate = goodCrystal();
badDate.itineraryDays = [{ day: 1, date: "2026-02-31", port: "Vancouver", is_sea_day: false }];
mustThrow([...baseline().filter((r) => r.line !== "crystal"), badDate], "impossible date", "impossible calendar date");

console.log("\nAll build-guard negative tests passed.");

// ---------------------------------------------------------------------------------------
// buildFromAcquired (TD.3) — one generic path yields correct dated + undated records.
// ---------------------------------------------------------------------------------------
// A tiny Carnival snapshot: a route with two departure dates + a dateless day template.
const carnivalSnap = { itineraries: [{
  ship: "Carnival Test", name: "Bahamas from Miami", nights: 3, departPort: "Miami",
  arrivePort: "Miami", dest: "Bahamas",
  dates: ["2026-08-15", "2026-09-05"],
  days: [
    { day: 1, port: "Miami", is_sea_day: false },
    { day: 2, port: "At Sea", is_sea_day: true },
    { day: 3, port: "Nassau", is_sea_day: false },
    { day: 4, port: "Miami", is_sea_day: false },
  ],
}] };
const dated = buildFromAcquired("carnival", carnivalSnap, { dated: true });
assert.strictEqual(dated.records.length, 2, "one dated record per departure date");
for (const r of dated.records) {
  assert.strictEqual(r.count, 1);
  assert.strictEqual(r.dest, "Bahamas");
  assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(r.date), "dated record carries a real date");
  assert.strictEqual(r.portDisembark, "Miami");
  assert.ok(r.ports.length && !r.ports.includes("At Sea"), "flat route drops sea days");
  assert.ok(r.itineraryDays.every((d) => d.date), "every day re-dated from the departure");
}
// Per-day dates derive from the specific departure (Aug vs Sep).
assert.strictEqual(dated.records.find((r) => r.date === "2026-08-15").itineraryDays[1].date, "2026-08-16");
assert.strictEqual(dated.records.find((r) => r.date === "2026-09-05").itineraryDays[1].date, "2026-09-06");
// The dated records pass the day-by-day guard as a Carnival (dated) line.
assert.doesNotThrow(() => validateItineraryDays([...baseline().filter((r) => r.line !== "carnival"), ...dated.records]));
console.log("  ok  — buildFromAcquired dated: one record/departure, days re-dated, guard passes");

// A tiny Disney-style undated snapshot: one record per route, dateless days, months [].
const disneySnap = { itineraries: [{
  ship: "Disney Test", name: "5-Night Bahamian Cruise from Port Canaveral", nights: 5,
  departPort: "Port Canaveral", arrivePort: "Port Canaveral",
  days: [{ day: 1, port: "Port Canaveral", is_sea_day: false }, { day: 2, port: "Nassau", is_sea_day: false }],
} ] };
const undated = buildFromAcquired("disney", disneySnap, { dated: false });
assert.strictEqual(undated.records.length, 1);
assert.strictEqual(undated.records[0].dest, "Bahamas");         // classified from the name
assert.deepStrictEqual(undated.records[0].months, []);
assert.strictEqual(undated.records[0].date, undefined, "undated record carries no date");
assert.ok(undated.records[0].itineraryDays.every((d) => d.date === undefined), "undated line: dateless days");
console.log("  ok  — buildFromAcquired undated: one record/route, dateless days, months []");

console.log("\nAll buildFromAcquired tests passed.");
