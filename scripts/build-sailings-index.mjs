#!/usr/bin/env node
// Builds the sailings search index from the cruise-line datasets in
// docs/research/cruise-lines/ (canonical <slug>-itineraries-*.json snapshots + any remaining
// markdown extracts).
//
// WORKFLOW: when a refreshed dataset lands in docs/research/cruise-lines/, run:
//
//     npm run build:index
//
// from conversational-engine/. This re-parses all datasets, re-aggregates itinerary-level search
// records, and writes the index to TWO places (TD.1): the engine's own data/ (which ingest reads)
// AND the website's src/content/generated/ (which the marketing site bundles via @/ imports).
//
// Policy: NO prices, NO exact departure dates anywhere in the output — only "YYYY-MM"
// months (or a season hint string for undated lines). Every source region/label MUST map
// to a canonical destination in searchTypes.ts DESTINATIONS; an unmapped label throws.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { classify } from "./itinerary/classify.mjs";   // shared destination classifier (TD.2)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..");                    // -> Marketing root (shared)
const DATA_DIR = path.join(ROOT, "docs", "research", "cruise-lines");
// The engine's own copy (ingest + validate read this) and the website's bundled copy. The build
// writes both so one repo owns the pipeline while the marketing site keeps its compile-time import.
const ENGINE_OUT = path.join(__dirname, "..", "data", "sailings-index.json");
const WEBSITE_OUT = path.join(ROOT, "website", "src", "content", "generated", "sailings-index.json");
const OUT_PATHS = [ENGINE_OUT, WEBSITE_OUT];

// ---------------------------------------------------------------------------------------
// Canonical destination taxonomy (must mirror website/src/lib/searchTypes.ts DESTINATIONS)
// ---------------------------------------------------------------------------------------
const DESTINATIONS = new Set([
  "Mediterranean",
  "Greek Isles & Aegean",
  "Caribbean",
  "Bahamas",
  "Arabian Gulf",
  "Red Sea",
  "Northern Europe & Baltic",
  "Norwegian Fjords",
  "Alaska",
  "Asia (Far East)",
  "Southeast Asia",
  "Australia & New Zealand",
  "South Pacific",
  "Hawaii",
  "Mexico & Baja",
  "South America",
  "Transatlantic & repositioning",
  "World & Grand Voyages",
  "European rivers",
  "Expedition (Polar)",
  "North America & Canada",
  "Middle East & Africa journeys",
]);

function checkDest(dest, context) {
  if (!DESTINATIONS.has(dest)) {
    throw new Error(`Unmapped destination "${dest}" (${context})`);
  }
  return dest;
}

// ---------------------------------------------------------------------------------------
// Generic helpers
// ---------------------------------------------------------------------------------------

function readData(file) {
  return fs.readFileSync(path.join(DATA_DIR, file), "utf8");
}

const ESC = "@PIPE@";
/** Split a markdown table row on "|", protecting escaped "\|" inside cell text. */
function splitRow(line) {
  const protectedLine = line.replace(/\\\|/g, ESC);
  return protectedLine.split("|").map((c) => c.trim().split(ESC).join("|"));
}

function isTableRow(line) {
  return line.startsWith("| ") || line.startsWith("|-");
}

const MONTHS = {
  JAN: 1, FEB: 2, MAR: 3, APR: 4, MAY: 5, JUN: 6, JUL: 7, AUG: 8, SEP: 9, SEPT: 9, OCT: 10, NOV: 11, DEC: 12,
};

function ym(year, month) {
  return `${year}-${String(month).padStart(2, "0")}`;
}

// Full ISO sail date "YYYY-MM-DD" (TB.1). The dated-line parsers below now return this;
// each call site derives the aggregation month with `.slice(0, 7)`, so `month` is byte-for-
// byte what it was before — aggregation is unchanged — while the row also carries the exact
// day for the Stage-B de-aggregation (TB.2).
function isoDate(year, month, day) {
  return `${year}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
}

/** "Jul 26, 2026 (Sun)" or "Jul 11, 2026" -> "2026-07-26" (full sail date, TB.1). */
function parseLooseDate(raw) {
  const m = raw.trim().match(/^([A-Za-z]{3,4})\s+(\d{1,2}),\s*(\d{4})/);
  if (!m) throw new Error(`unparseable date "${raw}"`);
  const mon = MONTHS[m[1].toUpperCase()];
  if (!mon) throw new Error(`unknown month "${m[1]}"`);
  return isoDate(Number(m[3]), mon, Number(m[2]));
}

// ---------------------------------------------------------------------------------------
// Port normalization
// ---------------------------------------------------------------------------------------

const COUNTRY_SUFFIX = new RegExp(
  ",\\s*(" +
    [
      "United States of America", "United States", "USA", "United Kingdom", "UK", "England", "Scotland", "Wales",
      "Northern Ireland", "Ireland", "Canada", "Australia", "Greece", "Italy", "Spain", "France", "Germany",
      "Netherlands", "Denmark", "Norway", "Sweden", "Finland", "Iceland", "Japan", "China", "South Korea", "Taiwan",
      "Malaysia", "Singapore", "Thailand", "Vietnam", "Indonesia", "Philippines", "Brunei Darussalam", "India",
      "Sri Lanka", "Portugal", "Croatia", "Montenegro", "Turkey", "Türkiye", "Egypt", "Jordan", "Oman", "Qatar",
      "Bahrain", "United Arab Emirates", "Saudi Arabia", "Israel", "Chile", "Argentina", "Brazil", "Peru", "Mexico",
      "Colombia", "Panama", "Bermuda", "New Zealand", "Fiji", "Vanuatu", "New Caledonia", "French Polynesia",
      "Belgium", "Malta", "Cyprus", "Morocco", "Tunisia", "South Africa", "Namibia", "Kenya", "Mauritius",
      "Seychelles", "Cape Verde", "Isle of Man", "Guernsey",
    ].join("|") +
    ")$",
  "i",
);

/** Strip a trailing US state code ("...,  FL" / ", NY" / ", CA" etc). */
const STATE_SUFFIX = /,\s*[A-Z]{2}$/;

// Full US state / Canadian province / Australian state / island-group names used as a trailing
// ", <region>" qualifier in some datasets (NCL spells these out in full rather than using codes).
const REGION_SUFFIX = new RegExp(
  ",\\s*(" +
    [
      "Washington", "Florida", "Alaska", "California", "Texas", "Louisiana", "Georgia", "Maryland",
      "Virginia", "Massachusetts", "Maine", "New York", "New Jersey", "South Carolina",
      "Rhode Island", "Hawaii", "Oahu", "Maui", "Kaua'i", "British Columbia", "New Brunswick",
      "Nova Scotia", "Ontario", "Quebec", "Tasmania", "New South Wales", "Victoria", "Queensland",
      "Western Australia", "South Australia", "US Virgin Islands", "British Virgin Islands",
      "Puerto Rico", "Bay of Fundy, New Brunswick",
    ].join("|") +
    ")$",
  "i",
);

function stripCountry(raw) {
  let s = raw.trim();
  let prev;
  do {
    prev = s;
    s = s.replace(STATE_SUFFIX, "");
    s = s.replace(COUNTRY_SUFFIX, "");
    s = s.replace(REGION_SUFFIX, "");
    s = s.trim().replace(/,\s*$/, "");
  } while (s !== prev);
  return s;
}

/** "Civitavecchia | Rome" -> "Civitavecchia (Rome)" (Costa/MSC escaped-pipe port pairs). */
function fromPipePort(raw) {
  const m = raw.match(/^(.+?)\s*\|\s*(.+)$/);
  if (m) return `${m[1].trim()} (${m[2].trim()})`;
  return raw.trim();
}

// Common display-name fixes applied after country/state stripping, shared across lines.
const COMMON_PORT_FIX = {
  marseilles: "Marseille",
  malaga: "Málaga",
  "málaga": "Málaga",
  cadiz: "Cádiz",
  "são paulo": "Santos (São Paulo)",
  "leixões": "Leixões (Porto)",
  itajai: "Itajaí",
  maceio: "Maceió",
  "kyoto (osaka)": "Kyoto (Osaka)",
  "kyoto (kobe)": "Kyoto (Kobe)",
  wak: "At Sea",
};

// Per-line overrides — mirrors the exact convention each line's own cruises.ts entry uses,
// since the same physical port is styled differently line to line (e.g. Rome/Civitavecchia).
const LINE_PORT_FIX = {
  costa: {
    "civitavecchia (rome)": "Civitavecchia (Rome)",
    "marghera (venice)": "Marghera (Venice)",
    "piraeus (athens)": "Piraeus (Athens)",
    "keelung (taipei)": "Keelung (Taipei)",
    "santa cruz (tenerife)": "Santa Cruz (Tenerife)",
    "las palmas (gran canaria)": "Las Palmas (Gran Canaria)",
    "la seyne (saint-tropez)": "La Seyne (Saint-Tropez)",
    "san antonio (santiago)": "San Antonio (Santiago)",
    "genoa (portofino)": "Genoa (Portofino)",
    "sasebo (japan)": "Sasebo (Japan)",
    sasebo: "Sasebo (Japan)",
    "yokohama (tokyo)": "Yokohama (Tokyo)",
  },
  "royal-caribbean": {
    civitavecchia: "Rome (Civitavecchia)",
    "civitavecchia, italy": "Rome (Civitavecchia)",
    rome: "Rome (Civitavecchia)",
    "bologna/ravenna": "Ravenna (Venice)",
    "bologna (ravenna)": "Ravenna (Venice)",
    athens: "Athens (Piraeus)",
    "port canaveral": "Port Canaveral (Orlando)",
    southampton: "Southampton (London)",
    "cape liberty": "Cape Liberty (New York)",
    "shanghai (baoshan)": "Shanghai (Baoshan)",
    colon: "Colón (Panama)",
  },
  norwegian: {
    "port canaveral": "Orlando (Port Canaveral)",
    southampton: "London (Southampton)",
    "piraeus (athens)": "Athens (Piraeus)",
    "seoul (incheon)": "Seoul (Incheon)",
    "tokyo (yokohama)": "Tokyo (Yokohama)",
    tokyo: "Tokyo",
    "hakata (fukuoka)": "Hakata (Fukuoka)",
    "kyoto (osaka)": "Kyoto (Osaka)",
    "bangkok (laem chabang)": "Bangkok (Laem Chabang)",
    "ho chi minh city (phu my)": "Ho Chi Minh City (Phu My)",
    "hanoi (ha long bay)": "Hanoi (Ha Long Bay)",
    "ketchikan (ward cove)": "Ketchikan (Ward Cove)",
    "santiago (san antonio)": "Santiago (San Antonio)",
    "taipei (keelung)": "Taipei (Keelung)",
    "miyakojima (okinawa)": "Miyakojima (Okinawa)",
    "naha (okinawa)": "Naha (Okinawa)",
  },
  msc: {
    "port canaveral": "Port Canaveral",
    galveston: "Galveston",
    miami: "Miami",
    shanghai: "Shanghai",
    "venice-marghera": "Marghera (Venice)",
    "trieste (venice)": "Trieste (Venice)",
  },
  disney: {
    "port canaveral": "Port Canaveral",
    "fort lauderdale": "Fort Lauderdale",
    southampton: "Southampton",
    "civitavecchia (rome)": "Civitavecchia (Rome)",
  },
  aroya: {},
  elixir: {
    "lavrion port": "Lavrion (Athens)",
    "lavrion port (athens)": "Lavrion (Athens)",
    "port of lavrion": "Lavrion (Athens)",
    "port of lavrion (athens)": "Lavrion (Athens)",
    lavrion: "Lavrion (Athens)",
  },
  "dream-star": {
    keelung: "Keelung (Taipei)",
  },
  crystal: {
    "seward (anchorage, alaska)": "Seward (Anchorage)",
    "seward (anchorage)": "Seward (Anchorage)",
    ijmuiden: "Ijmuiden (Amsterdam)",
    "ijmuiden (amsterdam)": "Ijmuiden (Amsterdam)",
    "musandam peninsula": "Musandam Peninsula",
  },
  scenic: {
    "civitavecchia (rome)": "Civitavecchia (Rome)",
    "athens (piraeus)": "Athens (Piraeus)",
  },
  silversea: {
    "miami, fl": "Miami",
    "new york, ny": "New York",
    bayonne: "Bayonne (New Jersey)",
    "seattle (washington)": "Seattle",
    "seward (anchorage, alaska)": "Seward (Anchorage)",
    mahe: "Mahé (Seychelles)",
    "benoa, bali": "Benoa (Bali)",
    lautoka: "Lautoka (Fiji)",
    "rio de janeiro": "Rio de Janeiro",
    "palma de mallorca": "Palma de Mallorca",
    valparaiso: "Valparaíso",
  },
  carnival: {
    "port canaveral (orlando)": "Port Canaveral (Orlando)",
    "long beach (los angeles)": "Long Beach (Los Angeles)",
    "manhattan, new york city": "New York City (Manhattan)",
    "manhattan new york city": "New York City (Manhattan)",
  },
  celebrity: {
    "baltra island, galapagos": "Baltra Island (Galápagos)",
    "baltra island": "Baltra Island (Galápagos)",
    "cape liberty": "Cape Liberty (New York)",
    "orlando (port canaveral)": "Orlando (Port Canaveral)",
    "rome (civitavecchia)": "Rome (Civitavecchia)",
    "athens (piraeus)": "Athens (Piraeus)",
    "tokyo (yokohama)": "Tokyo (Yokohama)",
    "seoul (incheon)": "Seoul (Incheon)",
    "benoa (bali)": "Benoa (Bali)",
    "honolulu (oahu)": "Honolulu (Oahu)",
    ravenna: "Ravenna (Venice)",
    "perfect day cococay": "Perfect Day CocoCay",
  },
};

function normPort(line, raw) {
  if (!raw) throw new Error(`${line}: empty port`);
  let s = raw;
  if (s.includes("|")) s = fromPipePort(s);
  s = stripCountry(s);
  s = s.replace(/\s+/g, " ").trim();
  const key = s.toLowerCase();
  const lineFix = LINE_PORT_FIX[line] || {};
  if (lineFix[key]) return lineFix[key];
  if (COMMON_PORT_FIX[key]) return COMMON_PORT_FIX[key];
  return s;
}

/** Cap a route to <=max stops, drop immediate consecutive duplicates. */
function capRoute(ports, max = 7) {
  const out = [];
  for (const p of ports) {
    if (!p) continue;
    if (out[out.length - 1] === p) continue;
    out.push(p);
  }
  if (out.length > max) {
    const head = out.slice(0, max - 1);
    head.push(out[out.length - 1]);
    return head;
  }
  return out;
}

// ---------------------------------------------------------------------------------------
// Day-by-day schedules (TC.2)
// ---------------------------------------------------------------------------------------
// Crystal and Elixir are the only two lines whose source files publish a full day-by-day
// itinerary, and both parsers ALREADY walk those "- Day N: …" lines — but only to flatten the
// port names into the `ports` route, then throw the day structure away. TC.2 keeps that structure
// as an `itineraryDays[]` array on the record so agents can see the numbered schedule.
//
// The engine consumes each entry DIRECTLY as a Pydantic `ItineraryDay` (TC.1) with fields
// {day, date?, port, is_sea_day}, so we emit exactly those snake_case keys — no engine-side key
// translation, nothing to drift. (The array field itself is camelCase `itineraryDays`, matching
// the other record fields the loader reads by name.)

// A day the ship is cruising / at sea rather than calling at a port. Crystal marks these
// "Cruising <place>" (e.g. "Cruising Hubbard Glacier"); flagging them lets the renderer say the
// ship is at sea instead of implying a port call. Elixir (a Cyclades yacht) has none — every day
// is a real stop, so this simply never matches for it.
const SEA_DAY_RE = /^\s*(?:scenic\s+)?cruising\b|^\s*(?:day\s+)?at sea\b/i;

// Split one day's text into its stops. Most days are a single place ("Ketchikan, Canada"); Elixir
// occasionally lists two on one day ("Lavrion – Kythnos"). We split ONLY on a dash flanked by
// spaces (or an en/em dash), so hyphenated place names (e.g. "Baie-Comeau") are never torn apart.
function splitDayStops(text) {
  return text.split(/\s*[–—]\s*|\s+-\s+/).map((s) => s.trim()).filter(Boolean);
}

// Build one { day, date?, port, is_sea_day } entry from a parsed day line. `dateISO` is the exact
// per-day date for a dated line (Crystal) or null/undefined for an undated one (Elixir) — we never
// fabricate a date the source didn't give. Ports are normalized with the SAME normPort the flat
// route uses, so a day and its route entry always agree.
function makeItineraryDay(lineSlug, dayNum, dateISO, rawText) {
  // Drop editorial markers the model shouldn't see ("_(overnight)_", "(Setting Sail)", "(Arrival)").
  const clean = rawText
    .replace(/_\(overnight\)_/gi, "")
    .replace(/\s*\((?:Setting Sail|Arrival)\)/gi, "")
    .trim();
  const isSea = SEA_DAY_RE.test(clean);
  // For a cruising day, strip the leading "Cruising"/"Scenic Cruising" verb so the PLACE normalizes
  // (the is_sea_day flag already records that the ship is at sea); a bare "at sea" becomes "At Sea".
  const body = clean
    .replace(/^\s*(?:scenic\s+)?cruising\s+/i, "")
    .replace(/^\s*(?:day\s+)?at sea\b/i, "At Sea");
  const port = body === "At Sea"
    ? "At Sea"
    : splitDayStops(body).map((p) => normPort(lineSlug, p)).join(" – ");
  const day = { day: dayNum, port, is_sea_day: isSea };
  if (dateISO) day.date = dateISO;      // dated lines only
  return day;
}

// ---------------------------------------------------------------------------------------
// Aggregation
// ---------------------------------------------------------------------------------------

/**
 * rows: array of { line, ship, name, nameKey?, dest, destLabel, nights, port, month?, months?,
 *                   seasonHint?, ports? }
 * One row == one raw departure/itinerary entry from the source.
 */
// Lines whose raw nights value is fine-grained relative to how meaningfully distinct the
// itineraries actually are (undated bulk catalogues) get bucketed into small night bands for
// aggregation purposes, with the record's displayed `nights` becoming a range ("9-12 nights")
// when a bucket spans more than one exact value. This is the single biggest lever on record
// count/size for these two lines without merging genuinely different regions or ports.
const NIGHTS_BUCKET_LINES = new Set(["norwegian", "msc", "scenic-emerald"]);

function nightsBucketOf(nightsNum) {
  return Math.floor((nightsNum - 1) / 3);
}

function aggregate(rows) {
  const buckets = new Map();
  for (const row of rows) {
    // Per the design: key = line + ship + port + canonical dest + nights (+ name where the
    // dataset has a meaningful name/region label). Route (`ports`) is NOT part of the key —
    // it's carried as a representative, display-only sample so genuinely repeating itineraries
    // (the point of this aggregation) still collapse into one record with an accurate count.
    const nameSig = row.nameKey || row.name;
    const nightsSig = NIGHTS_BUCKET_LINES.has(row.line) ? `b${nightsBucketOf(row.nightsNum)}` : row.nights;
    const key = [row.line, row.ship, row.port, row.dest, nightsSig, nameSig].join("::");
    let b = buckets.get(key);
    if (!b) {
      b = {
        line: row.line,
        ship: row.ship,
        dest: row.dest,
        destLabel: row.destLabel,
        port: row.port,
        portTo: row.portTo,
        seasonHint: row.seasonHint,
        ports: row.ports,
        itineraryDays: row.itineraryDays,   // day-by-day schedule, only Elixir carries one (TC.2)
        count: 0,
        monthsSet: new Set(),
        nameVotes: new Map(),
        nightsMin: row.nightsNum,
        nightsMax: row.nightsNum,
      };
      buckets.set(key, b);
    }
    b.count += 1;
    if (row.nightsNum < b.nightsMin) b.nightsMin = row.nightsNum;
    if (row.nightsNum > b.nightsMax) b.nightsMax = row.nightsNum;
    if (row.month) b.monthsSet.add(row.month);
    if (row.months) for (const m of row.months) b.monthsSet.add(m);
    const nv = b.nameVotes.get(row.name) || 0;
    b.nameVotes.set(row.name, nv + 1);
    if (row.ports && row.ports.length && (!b.ports || row.ports.length > b.ports.length)) b.ports = row.ports;
    // Disembark port: keep the first non-empty one seen for this itinerary (TA.2).
    if (!b.portTo && row.portTo) b.portTo = row.portTo;
    // Day-by-day schedule (TC.2): keep the longest sample, mirroring `ports`. Elixir's aggregation
    // is 1:1 (each named itinerary is its own bucket), so this simply carries that sailing's list.
    if (row.itineraryDays && row.itineraryDays.length &&
        (!b.itineraryDays || row.itineraryDays.length > b.itineraryDays.length)) {
      b.itineraryDays = row.itineraryDays;
    }
  }
  const records = [];
  for (const b of buckets.values()) {
    let bestName = "";
    let bestVotes = -1;
    for (const [name, votes] of b.nameVotes) {
      if (votes > bestVotes) {
        bestVotes = votes;
        bestName = name;
      }
    }
    const allMonths = [...b.monthsSet].sort();
    // The month picker only ever offers Jul 2026 - Dec 2027 (see searchTypes.ts / the plan's
    // "Month options"), so months outside that window can never be selected — clip to it to
    // keep the JSON size in budget. If a record's months are entirely outside the window
    // (e.g. Scenic/Crystal seasons running into 2028-2029), fall back to a season-year hint
    // so the record still carries a human-readable date signal instead of a bare empty list.
    const clipped = allMonths.filter((m) => m >= "2026-07" && m <= "2027-12");
    let seasonHint = b.seasonHint;
    if (allMonths.length && !clipped.length && !seasonHint) {
      const years = [...new Set(allMonths.map((m) => m.slice(0, 4)))];
      seasonHint = `${years.join(", ")} season`;
    }
    const nightsDisplay = b.nightsMin === b.nightsMax
      ? nightsLabel(b.nightsMin)
      : `${b.nightsMin}–${b.nightsMax} nights`;
    const rec = {
      line: b.line,
      ship: b.ship,
      name: bestName,
      dest: b.dest,
      destLabel: b.destLabel,
      nights: nightsDisplay,
      port: b.port,
      months: clipped,
      count: b.count,
    };
    if (seasonHint) rec.seasonHint = seasonHint;
    // Ports of call (TA.1): keep the full ordered route on EVERY record — singletons included.
    // Agents need to see where a sailing actually stops, so we no longer drop the route for
    // count===1 records, nor trim aggregated routes down to 5 stops. We still cap the length
    // (12) via capRoute to bound the JSON size and to collapse the odd runaway route; that
    // ceiling is high enough that a typical 7–11 night itinerary keeps its whole port run.
    if (b.ports && b.ports.length) {
      rec.ports = capRoute(b.ports, 12);
    }
    // Arrival/disembark port (TA.2): present only for lines that publish an endpoint —
    // an explicit arrival column, a one-way route end, or a stated round trip. Lines with
    // no arrival signal (e.g. Royal Caribbean's region-only rows) simply omit it.
    if (b.portTo) rec.portDisembark = b.portTo;
    // Day-by-day schedule (TC.2): only Elixir (of the undated lines) publishes one; every other
    // aggregated line leaves the field undefined, so their records are unchanged.
    if (b.itineraryDays && b.itineraryDays.length) rec.itineraryDays = b.itineraryDays;
    records.push(rec);
  }
  return records;
}

// ---------------------------------------------------------------------------------------
// De-aggregation for dated lines (TB.2)
// ---------------------------------------------------------------------------------------
// The 6 dated lines skip aggregate()'s group-by: each raw departure becomes its OWN record
// carrying its exact `date`, so agents see real sailing dates instead of a month range. The
// output shape matches aggregate() exactly — plus a `date` field and `count: 1` — so the
// engine loader and search treat dated and catalogue records uniformly.
//
// Months are still clipped to the picker window (Jul 2026–Dec 2027), like aggregate(), so the
// month_window assumption keeps holding: an in-window departure lists its single month; an
// out-of-window one keeps its exact `date` but shows a season hint for month-based search.
function recordFromDatedRow(row) {
  const month = row.date.slice(0, 7);
  const inWindow = month >= "2026-07" && month <= "2027-12";
  const rec = {
    line: row.line,
    ship: row.ship,
    name: row.name,
    dest: row.dest,
    destLabel: row.destLabel,
    nights: row.nights,
    port: row.port,
    months: inWindow ? [month] : [],
    count: 1,
    date: row.date,                         // the exact sail date (TB.2)
  };
  // Give an out-of-window departure a year season hint (mirrors aggregate's fallback).
  let seasonHint = row.seasonHint;
  if (!inWindow && !seasonHint) seasonHint = `${month.slice(0, 4)} season`;
  if (seasonHint) rec.seasonHint = seasonHint;
  if (row.ports && row.ports.length) rec.ports = capRoute(row.ports, 12);
  if (row.portTo) rec.portDisembark = row.portTo;
  // Day-by-day schedule (TC.2): only Crystal (of the dated lines) publishes one; the other dated
  // lines leave it undefined, so their records are unchanged.
  if (row.itineraryDays && row.itineraryDays.length) rec.itineraryDays = row.itineraryDays;
  return rec;
}

function nightsLabel(n) {
  const num = Number(n);
  return `${num} night${num === 1 ? "" : "s"}`;
}

// =========================================================================================
// AROYA — small table with real dates, em-dash itinerary list.
// =========================================================================================

function aroyaClassify(name, fromPort, itinRoute) {
  const hasSuez = /suez canal/i.test(itinRoute);
  if (hasSuez) return { dest: "Red Sea", destLabel: "Red Sea ↔ Mediterranean repositioning" };
  if (fromPort === "Istanbul" || fromPort === "Marmaris") {
    return { dest: "Mediterranean", destLabel: "Mediterranean (from Istanbul)" };
  }
  return { dest: "Red Sea", destLabel: "Red Sea (from Jeddah)" };
}

function parseAroya() {
  const txt = readData("aroya-sailings-jul2026.md");
  const lines = txt.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!isTableRow(line) || /^\|\s*#/.test(line) || /^\|---/.test(line)) continue;
    const cols = splitRow(line);
    if (!cols[1] || Number.isNaN(Number(cols[1]))) continue;
    // | # | Sailing Name | Nights | Departure Port | Trip Type | Itinerary | Start Date | From (per person) |
    const name = cols[2];
    const nights = Number(cols[3]);
    const fromPort = cols[4];
    const itinRoute = cols[6];
    const startDate = cols[7];
    const { dest, destLabel } = aroyaClassify(name, fromPort, itinRoute);
    const ports = capRoute(itinRoute.split("—").map((p) => normPort("aroya", p.trim())));
    rows.push({
      line: "aroya",
      ship: "Aroya",
      name,
      dest: checkDest(dest, `Aroya ${name}`),
      destLabel,
      nights: nightsLabel(nights),
      nightsNum: nights,
      port: normPort("aroya", fromPort),
      month: parseLooseDate(startDate).slice(0, 7),   // month the aggregation still groups on
      date: parseLooseDate(startDate),                // exact sail date (TB.1)
      ports,
      // The route runs embark → … → disembark, so the last stop is the arrival port (TA.2).
      portTo: ports[ports.length - 1],
    });
  }
  return rows;
}

// (Elixir is now sourced from acquisition — buildFromAcquired reads the elixir-itineraries-<date>.json
// snapshot produced by scripts/itinerary/fetch-elixir.mjs (elixir-cruises.com, dated + day-by-day).
// parseElixir + attachElixirShips were removed at cutover; classify.mjs::elixirDest maps its regions.) — TD.19

// (StarDream is now sourced from acquisition — buildFromAcquired reads the dream-star-itineraries-<date>.json
// snapshot produced by scripts/itinerary/fetch-dream-star.mjs (authorized SeawareTouch agent session, dated).
// parseStardream + stardreamClassify were removed at cutover; classify.mjs::stardreamDest maps its regions.) — TD.18

// =========================================================================================
// MSC — single table, escaped pipes, REGION column caps, undated.
// =========================================================================================

const MSC_REGION_DEST = {
  MEDITERRANEAN: "Mediterranean",
  "NORTHERN EUROPE": "Northern Europe & Baltic",
  "MSC GRAND VOYAGES": "World & Grand Voyages",
  "CARIBBEAN AND ANTILLES": "Caribbean",
  "FAR EAST": "Asia (Far East)",
  ALASKA: "Alaska",
};

function mscHasRealRoute(itin, embarkPort) {
  if (itin.includes(embarkPort)) return true;
  const parts = itin.split(",").map((s) => s.trim());
  if (parts.length > 3 && parts.some((p) => /[a-z]/.test(p) && / /.test(p))) return true;
  return false;
}

function parseMSC() {
  const txt = readData("msc-sailings-extract-jul2026.md");
  const lines = txt.split(/\r?\n/);
  const rows = [];
  for (const line of lines) {
    if (!isTableRow(line) || /^\|\s*#/.test(line) || /^\|---/.test(line)) continue;
    const cols = splitRow(line);
    if (!cols[1] || Number.isNaN(Number(cols[1]))) continue;
    // | # | Sailing (Region) | Ship | Nights | Departure Port | Arrival Port | Itinerary |
    const region = cols[2];
    const ship = cols[3];
    const nights = Number(cols[4]);
    const fromPortRaw = cols[5];
    const arrivalPortRaw = cols[6];               // dedicated Arrival Port column (TA.2)
    const itin = cols[7];
    const dest = MSC_REGION_DEST[region];
    if (!dest) throw new Error(`MSC: unmapped region "${region}"`);
    const fromPort = normPort("msc", fromPortRaw);
    const row = {
      line: "msc",
      ship: ship.replace(/^MSC\s+/, "MSC "),
      name: region.toLowerCase().replace(/\b\w/g, (c) => c.toUpperCase()),
      dest: checkDest(dest, `MSC region ${region}`),
      destLabel: dest,
      nights: nightsLabel(nights),
      nightsNum: nights,
      port: fromPort,
      // MSC uniquely publishes an explicit arrival port — read it directly (TA.2).
      portTo: arrivalPortRaw ? normPort("msc", arrivalPortRaw) : undefined,
      months: [],
    };
    if (mscHasRealRoute(itin, fromPortRaw.split(",")[0].trim())) {
      const ports = capRoute(itin.split(",").map((p) => normPort("msc", p.trim())));
      row.ports = ports;
      row.nameKey = ports.join(">");
    } else {
      row.nameKey = `${region}|${itin}`;
    }
    rows.push(row);
  }
  return rows;
}

// (Crystal is now sourced from acquisition — buildFromAcquired reads the crystal-itineraries-<date>.json
// snapshot produced by scripts/itinerary/fetch-crystal.mjs; parseCrystal + CRYSTAL_DEST were removed
// when it cut over to the live crystalcruises.com feed. classify.mjs::crystalDest maps its regions.) — TD.17

// =========================================================================================
// Build + write
// =========================================================================================

// Lines whose raw source carries an exact per-departure sail date (TB.1). Every other line
// is catalogue-level (months / season only), so its rows must NOT carry a date. Includes the
// acquired dated lines (carnival) so the per-record dated invariants + day-date discipline apply.
const DATED_LINES = new Set(["costa", "carnival", "royal-caribbean", "aroya", "crystal", "silversea", "disney", "norwegian", "celebrity", "scenic-emerald", "dream-star", "elixir"]);

// Stage D: lines sourced from acquisition snapshots via buildFromAcquired instead of a markdown
// parser (value = dated?). These do NOT flow through `allRows`, so the markdown-oriented guards
// (validateDates, the TB.2 1:1 departures-vs-emitted check, the [dates] report) skip them.
// value = dated? All three carry real per-departure dates, so all are dated (one record per
// departure, exact date surfaced). Disney's snapshot now carries EVERY departure per route in
// `dates[]` (TD.16 — fetch-disney fetches all ~680 sailings), so its coverage matches Carnival/
// Silversea. Disney's dest is still classified at build time from the itinerary name + embark port.
const ACQUIRED_DATED = { carnival: true, silversea: true, disney: true, costa: true, norwegian: true, "royal-caribbean": true, celebrity: true, "scenic-emerald": true, crystal: true, "dream-star": true, elixir: true };
const ACQUIRED_LINES = new Set(Object.keys(ACQUIRED_DATED));

/**
 * TB.1 validation hook (build-time). The aggregated output carries no dates until TB.2, so
 * this — where the per-row sail dates actually exist — is the only place they can be checked.
 * Throws, like the parser guards above, so a source date-format change or a mis-tagged line
 * fails the build instead of shipping silently. Invariant:
 *   - every dated-line row has a real YYYY-MM-DD calendar date whose month equals the row's
 *     aggregation `month` (catches a parser drifting day/month/year); and
 *   - no undated-line row carries a date at all.
 */
function validateDates(rows) {
  for (const r of rows) {
    if (DATED_LINES.has(r.line)) {
      if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        throw new Error(`TB.1: ${r.line} row has no valid YYYY-MM-DD date ("${r.name}" -> ${r.date})`);
      }
      // Reject an impossible calendar date (e.g. a mis-parsed "2026-02-31" that JS would roll over).
      const [y, mo, da] = r.date.split("-").map(Number);
      const d = new Date(Date.UTC(y, mo - 1, da));
      if (d.getUTCFullYear() !== y || d.getUTCMonth() !== mo - 1 || d.getUTCDate() !== da) {
        throw new Error(`TB.1: ${r.line} impossible calendar date "${r.date}"`);
      }
      // The aggregation month must be exactly the date's month — else the two have drifted apart.
      if (r.date.slice(0, 7) !== r.month) {
        throw new Error(`TB.1: ${r.line} date/month mismatch (${r.date} vs ${r.month})`);
      }
    } else if (r.date) {
      throw new Error(`TB.1: undated line ${r.line} unexpectedly carries a date "${r.date}"`);
    }
  }
}

/**
 * TB.2 validation hook (build-time). Checks the EMITTED records — the thing that gets written
 * and later loaded by the engine — satisfy the de-aggregation invariant. Runs at build time
 * because the engine snapshot isn't refreshed until TB.3, so this is where a de-aggregation
 * regression is caught. Throws (fails the build) if any of these break:
 *   - each dated line emits exactly ONE record per raw departure (de-aggregation didn't
 *     accidentally collapse departures back through aggregate(), nor drop any);
 *   - every dated record carries a valid `date` and `count: 1`;
 *   - a dated record's `months` reflects its date (the single in-window month, or [] when the
 *     departure is outside the picker window); and
 *   - no catalogue (undated) record carries a date.
 */
function validateRecords(records, allRows) {
  // 1:1 dated departures -> records. This is the core promise of TB.2. Acquired dated lines don't
  // flow through `allRows` (their departures come from the snapshot's dates[]), so they're exempt
  // from this markdown-oriented count check — but still subject to the per-record dated invariants below.
  for (const line of DATED_LINES) {
    if (ACQUIRED_LINES.has(line)) continue;
    const departures = allRows.filter((r) => r.line === line).length;
    const emitted = records.filter((r) => r.line === line).length;
    if (emitted !== departures) {
      throw new Error(`TB.2: ${line} emitted ${emitted} records for ${departures} departures (must be 1:1)`);
    }
  }
  for (const r of records) {
    if (DATED_LINES.has(r.line)) {
      if (!r.date || !/^\d{4}-\d{2}-\d{2}$/.test(r.date)) {
        throw new Error(`TB.2: dated record ${r.line} "${r.name}" has no valid date (${r.date})`);
      }
      if (r.count !== 1) {
        throw new Error(`TB.2: dated record ${r.line} "${r.name}" has count ${r.count} (must be 1)`);
      }
      const month = r.date.slice(0, 7);
      const inWindow = month >= "2026-07" && month <= "2027-12";
      if (inWindow && !(r.months || []).includes(month)) {
        throw new Error(`TB.2: ${r.line} in-window date ${r.date} not in months ${JSON.stringify(r.months)}`);
      }
      if (!inWindow && (r.months || []).length) {
        throw new Error(`TB.2: ${r.line} out-of-window date ${r.date} should clip months to [] (got ${JSON.stringify(r.months)})`);
      }
    } else if (r.date) {
      throw new Error(`TB.2: catalogue line ${r.line} record unexpectedly carries a date "${r.date}"`);
    }
  }
}

// Lines whose records legitimately carry a day-by-day schedule. The build guard below uses it to
// (a) reject the field leaking onto any other line and (b) demand it stays present on each. Two
// come from the source markdown (Crystal/Elixir, TC.2); three come from the acquired snapshots
// merged in TC.6 (Carnival/Silversea via enrichment, Disney via replacement). Keep in step with
// parseCrystal / parseElixir and the TC.6 merge, and mirror engine `_DAY_BY_DAY_LINES`.
const DAYBYDAY_LINES = new Set(["crystal", "elixir", "carnival", "silversea", "disney", "costa", "royal-caribbean", "celebrity", "scenic-emerald"]);

/**
 * TC.2 validation hook (build-time). Validates the EMITTED `itineraryDays` on each record — the
 * exact array the engine later loads and renders as "Day 1..N" (TC.1). Runs at build time (the
 * engine snapshot isn't wired to read the column until TC.3), so a parser regression fails the
 * build rather than shipping a malformed or fabricated schedule. Throws if any of these break:
 *   - only the DAYBYDAY_LINES carry a schedule and ALL of them still do (catches the field leaking
 *     onto another line via aggregate, or a parser / acquired-merge silently dropping it);
 *   - every day is { day:int>=1, port:non-empty string, is_sea_day:bool }, and day numbers never
 *     go backwards (Day 1..N in order — repeats allowed for a multi-segment day, gaps allowed for
 *     an unlisted sea day);
 *   - date discipline matches the line: a dated line (Crystal) dates EVERY day with a real, strict
 *     YYYY-MM-DD; an undated line (Elixir) dates NONE — we never fabricate a date the source lacks.
 */
function validateItineraryDays(records) {
  // Both day-by-day lines must still emit a schedule — a parser that silently stopped would
  // otherwise pass unnoticed (the engine would just show "on request" everywhere).
  for (const line of DAYBYDAY_LINES) {
    if (!records.some((r) => r.line === line && r.itineraryDays && r.itineraryDays.length)) {
      throw new Error(`TC.2: ${line} emits no itineraryDays — did the day-by-day parse break?`);
    }
  }
  for (const r of records) {
    const days = r.itineraryDays;
    if (!days) continue;
    if (!DAYBYDAY_LINES.has(r.line)) {
      throw new Error(`TC.2: ${r.line} record unexpectedly carries itineraryDays ("${r.name}")`);
    }
    const dated = DATED_LINES.has(r.line);      // Crystal is dated; Elixir is not
    let prevDay = 0;
    for (const d of days) {
      if (!Number.isInteger(d.day) || d.day < 1) {
        throw new Error(`TC.2: ${r.line} "${r.name}" has a bad day number ${JSON.stringify(d.day)}`);
      }
      if (d.day < prevDay) {
        throw new Error(`TC.2: ${r.line} "${r.name}" day numbers go backwards (${prevDay} -> ${d.day})`);
      }
      prevDay = d.day;
      if (typeof d.port !== "string" || !d.port.trim()) {
        throw new Error(`TC.2: ${r.line} "${r.name}" day ${d.day} has an empty port`);
      }
      if (typeof d.is_sea_day !== "boolean") {
        throw new Error(`TC.2: ${r.line} "${r.name}" day ${d.day} is_sea_day is not a boolean`);
      }
      if (dated) {
        // Dated line: every day carries a strict, real calendar date (same rule as validateDates).
        if (!d.date || !/^\d{4}-\d{2}-\d{2}$/.test(d.date)) {
          throw new Error(`TC.2: dated line ${r.line} "${r.name}" day ${d.day} lacks a valid date (${d.date})`);
        }
        const [y, mo, da] = d.date.split("-").map(Number);
        const dt = new Date(Date.UTC(y, mo - 1, da));
        if (dt.getUTCFullYear() !== y || dt.getUTCMonth() !== mo - 1 || dt.getUTCDate() !== da) {
          throw new Error(`TC.2: ${r.line} "${r.name}" day ${d.day} impossible date "${d.date}"`);
        }
      } else if (d.date !== undefined) {
        // Undated line: a day must NOT carry a date — a stray one means a fabricated/mis-parsed value.
        throw new Error(`TC.2: undated line ${r.line} "${r.name}" day ${d.day} unexpectedly carries a date "${d.date}"`);
      }
    }
  }
}

// =========================================================================================
// TC.6 — Merge acquired day-by-day datasets into the record set
// =========================================================================================
// Stage C's acquisition track (TC.4/TC.5) produces canonical day-by-day snapshots in
// docs/research/cruise-lines/<slug>-itineraries-<date>.json, one entry per real itinerary:
//   { ship, name, nights, departPort, arrivePort, date?, days:[{day, date?, port, is_sea_day}] }
// TC.6 folds those into the build so the concierge finally answers with a numbered schedule
// (TC.1) instead of "day-by-day on request".
//
// The acquired data does NOT align with the base catalogue the same way for every line, so we
// merge two ways (decided from the actual data — see the field survey in the TC.6 work notes):
//
//   * ENRICH (Carnival, Silversea) — their ships match the base rows, so we attach each acquired
//     schedule ONTO the matching base departure. The base keeps its full date/search coverage;
//     we only add the day list (+ backfill the disembark port / ports of call it was missing).
//
//   * REPLACE (Disney) — the base Disney catalogue has no ship identity (its source is organised
//     by itinerary type, so parseDisney hard-codes "Disney Cruise Line") and its curated rows are
//     a DISJOINT set from the live acquired sailings. Attaching by key is impossible, and the
//     acquired data (real ships + day-by-day + arrival ports) is strictly better, so we swap the
//     base Disney records out for the acquired ones.
//
// Safety: we never fabricate or mislabel. Enrichment matches on the most specific shared key
// first (exact sailing → same named itinerary → unambiguous ship+nights+embark) and refuses the
// embark-level key when it maps to more than one distinct route. Per-day dates are always
// recomputed from the TARGET departure's own date, so an attached schedule can never show another
// sailing's calendar.

/** Read the newest canonical acquired snapshot per line from the research dir. */
function loadAcquiredItineraries() {
  const byLine = new Map();
  for (const f of fs.readdirSync(DATA_DIR)) {
    if (!/-itineraries-.*\.json$/.test(f)) continue;        // <slug>-itineraries-<date>.json only
    let j;
    try { j = JSON.parse(fs.readFileSync(path.join(DATA_DIR, f), "utf8")); } catch { continue; }
    if (!j || !j.line || !Array.isArray(j.itineraries)) continue;
    const prev = byLine.get(j.line);
    // Keep only the freshest snapshot per line (compare the `generated` stamp, then filename).
    const stamp = `${j.generated || ""}|${f}`;
    if (!prev || stamp > prev.stamp) byLine.set(j.line, { ...j, file: f, stamp });
  }
  return byLine;
}

/** Add `n` whole days to a "YYYY-MM-DD" string (UTC, so no timezone drift). */
function addDaysISO(iso, n) {
  const [y, m, d] = iso.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** One acquired day → the engine's { day, date?, port, is_sea_day } shape (TC.1). Sea days always
 *  render as "At Sea"; real ports are normalized with the SAME normPort the flat route uses, so a
 *  day and its route entry always agree. `dateISO` is attached only when the caller supplies one. */
function acquiredDay(lineSlug, d, dateISO) {
  const sea = Boolean(d.is_sea_day);
  const day = { day: Number(d.day), port: sea ? "At Sea" : normPort(lineSlug, d.port), is_sea_day: sea };
  if (dateISO) day.date = dateISO;
  return day;
}

/** Day list for an ENRICH attach onto a dated line: every day gets a REAL date derived from the
 *  target departure's own date (day-offset from day 1), never the acquired representative's date —
 *  so a schedule attached to the Aug 15 sailing dates its days from Aug 15, not from whatever
 *  representative date the snapshot happened to capture. Satisfies the dated-line rule in
 *  validateItineraryDays (every day carries a strict YYYY-MM-DD). */
function daysForAttach(lineSlug, days, baseDateISO) {
  const first = days.length ? Number(days[0].day) : 1;      // normally 1; tolerate a non-1 start
  return days.map((d) => acquiredDay(lineSlug, d, addDaysISO(baseDateISO, Number(d.day) - first)));
}

/** Day list for a Disney REPLACE record: dateless (Disney stays an undated line, like Elixir), so
 *  every day carries no date — matching validateItineraryDays' undated-line rule. */
function daysForDateless(lineSlug, days) {
  return days.map((d) => acquiredDay(lineSlug, d, null));
}

/** Flat ports-of-call route from a day list: real port calls only (drop sea days), consecutive
 *  duplicates collapsed and length capped, exactly like every other line's `ports`. */
function routeFromDays(lineSlug, days) {
  return capRoute(days.filter((d) => !d.is_sea_day).map((d) => normPort(lineSlug, d.port)), 12);
}

// =========================================================================================
// TD.3 — Generic acquired-source record builder (replaces the per-line markdown parsers)
// =========================================================================================
// One path turns an acquired snapshot (<slug>-itineraries-*.json) into search records, for any line.
// It handles both the undated (route-level) and dated (per-departure de-aggregation) cases:
//   * `dated: true`  — one record PER departure date (from each route's `dates[]`), the day-by-day
//     re-dated per departure via daysForAttach, routed through recordFromDatedRow so month-window
//     clipping + the dated invariants apply exactly as for a markdown dated line.
//   * `dated: false` — one record PER route (months:[], count:1), dateless day-by-day.
// `dated` is a LINE-level choice (a line must be all-dated or all-catalogue — the sail_dates
// all-or-nothing rule), passed by the caller. The destination comes from the shared classifier
// (canonical, validated at acquisition); an unclassifiable itinerary is skipped + logged, never guessed.
function buildFromAcquired(line, acq, { dated }) {
  const records = [], skipped = [];
  for (const it of acq.itineraries || []) {
    let dest;
    try { dest = classify(line, it); } catch (e) { skipped.push(`${it.name} (${e.message})`); continue; }
    if (!dest) { skipped.push(it.name); continue; }
    checkDest(dest, `${line} acquired "${it.name}"`);          // belt-and-suspenders vs the canonical set
    const nightsNum = Number(it.nights);
    const port = normPort(line, it.departPort);
    const portDisembark = it.arrivePort ? normPort(line, it.arrivePort) : port;
    // Route: derive from the day-by-day when present (sea days stripped); otherwise take an explicit
    // `ports` list from the snapshot — for lines whose API gives ports of call but no sea-day schedule
    // (Norwegian, TD.9). `itineraryDays` stays empty for those, so they aren't day-by-day lines.
    const route = (it.days && it.days.length) ? routeFromDays(line, it.days) : (it.ports || []);
    if (dated) {
      // A dated route carries every departure in `dates[]` (new shape) or a single `date` (legacy).
      const dates = (it.dates && it.dates.length) ? it.dates : (it.date ? [it.date] : []);
      for (const date of dates) {
        records.push(recordFromDatedRow({
          line, ship: it.ship, name: it.name,
          dest, destLabel: dest,
          nights: nightsLabel(nightsNum), nightsNum,
          port, portTo: portDisembark, date,
          ports: route.length ? route : undefined,
          itineraryDays: daysForAttach(line, it.days || [], date),   // per-departure dated days
        }));
      }
    } else {
      const rec = {
        line, ship: it.ship, name: it.name,
        dest, destLabel: dest,
        nights: nightsLabel(nightsNum), port, portDisembark,
        // A curated undated snapshot may carry its aggregated departure count (TD.14); default 1.
        months: [], count: it.count || 1,
      };
      // Attach the dateless day-by-day only when the snapshot actually has one — a route-only undated
      // line (Scenic, TD.11) carries none, and must NOT set the field (the guard forbids it on
      // non-day-by-day lines).
      const dd = daysForDateless(line, it.days || []);
      if (dd.length) rec.itineraryDays = dd;
      if (route.length) rec.ports = route;
      records.push(rec);
    }
  }
  return { records, skipped };
}

function main() {
  const parsers = [
    // carnival: sourced from acquisition (buildFromAcquired) — TD.4
    // costa: sourced from acquisition (buildFromAcquired, CostaClick API) — TD.12
    // royal-caribbean: sourced from acquisition (buildFromAcquired, RCL GraphQL, day-by-day) — TD.10
    ["aroya", parseAroya],
    // elixir: sourced from acquisition (buildFromAcquired, elixir-cruises.com, dated day-by-day) — TD.19
    // dream-star: sourced from acquisition (buildFromAcquired, SeawareTouch agent session, dated route) — TD.18
    // norwegian: sourced from acquisition (buildFromAcquired, ncl.com vacations API, route-only) — TD.9
    ["msc", parseMSC],
    // disney: sourced from acquisition (buildFromAcquired, undated) — TD.6
    // crystal: sourced from acquisition (buildFromAcquired, crystalcruises.com __NEXT_DATA__, day-by-day) — TD.17
    // scenic-emerald: sourced from acquisition (buildFromAcquired, scenic/emerald.cruises, day-by-day) — TD.11
    // silversea: sourced from acquisition (buildFromAcquired) — TD.5
    // celebrity: sourced from acquisition (buildFromAcquired, RCG GraphQL, day-by-day) — TD.8
  ];

  const allRows = [];
  const lineCounts = {};
  for (const [key, fn] of parsers) {
    const rows = fn();
    lineCounts[key] = rows.length;
    console.log(`  ${key.padEnd(16)} ${String(rows.length).padStart(5)} departures parsed`);
    allRows.push(...rows);
  }

  // TB.1: dates live on the row (aggregation ignores `date`; TB.2 emits them per departure).
  // Report per-line coverage, then hard-validate the invariant so any drift fails the build.
  console.log("");
  for (const line of DATED_LINES) {
    if (ACQUIRED_LINES.has(line)) continue;               // acquired lines don't flow through allRows
    const rows = allRows.filter((r) => r.line === line);
    const sample = rows.find((r) => r.date);
    console.log(`  [dates] ${line.padEnd(16)} ${String(rows.length).padStart(5)} rows`
      + `  e.g. ${sample ? sample.date : "—"}`);
  }
  validateDates(allRows);                 // throws on any missing / invalid / stray date (TB.1 guard)
  console.log("  [dates] date invariant OK\n");

  // TB.2: the dated lines skip aggregation — each departure is its own record with its exact
  // date; the undated catalogue lines still aggregate (many departures -> one representative
  // record). Combine the two streams into the final record set.
  const datedRows = allRows.filter((r) => DATED_LINES.has(r.line));
  const undatedRows = allRows.filter((r) => !DATED_LINES.has(r.line));
  const records = [
    ...aggregate(undatedRows),
    ...datedRows.map(recordFromDatedRow),
  ];

  const acquired = loadAcquiredItineraries();

  // Stage D: lines sourced entirely from acquisition snapshots go through the ONE generic path
  // (buildFromAcquired) — full catalogue + day-by-day, no markdown. A missing snapshot is skipped so
  // the build stays green.
  for (const [line, dated] of Object.entries(ACQUIRED_DATED)) {
    const acq = acquired.get(line);
    if (!acq) { console.warn(`  [days] no acquired snapshot for ${line} — skipped`); continue; }
    const { records: recs, skipped } = buildFromAcquired(line, acq, { dated });
    records.push(...recs);
    console.log(`  [days] ${line}: ${recs.length} records from acquired snapshot`
      + (skipped.length ? ` (skipped ${skipped.length}: ${skipped.slice(0, 3).join("; ")}…)` : ""));
  }

  // Research-verified additions: programmes confirmed on official sources but absent from the
  // current dataset extracts (e.g. seasonal programmes outside an extract's search window).
  // Kept minimal; months stay empty so the UI shows "departure dates on request".
  // NOTE (July 2026): the two Royal Caribbean Dubai entries that used to sit here were removed.
  // Royal Caribbean's own booking engine returns no results for Dubai (DXB) departures and its
  // Arabian Gulf pages carry destination copy only, so surfacing them in the search widget
  // implied bookable Gulf inventory that agents could not actually quote. Do not reinstate them
  // without live sailings on royalcaribbean.com.
  const RESEARCH_ADDITIONS = [
    {
      line: "msc",
      ship: "MSC Euribia",
      name: "Emirates & Qatar winter season ex-Dubai",
      dest: "Arabian Gulf",
      destLabel: "Arabian Gulf (Dubai season)",
      nights: "7 nights",
      port: "Dubai",
      months: [],
      seasonHint: "Nov–Mar Gulf season ex-Dubai",
      count: 1,
      ports: ["Dubai", "Abu Dhabi", "Sir Bani Yas", "Doha"],
    },
  ];
  records.push(...RESEARCH_ADDITIONS);
  records.sort((a, b) => a.line.localeCompare(b.line) || b.count - a.count);

  validateRecords(records, allRows);      // TB.2 de-aggregation invariant (build-time guard)
  console.log("  [dates] de-aggregation invariant OK (1 record per dated departure)\n");

  validateItineraryDays(records);         // TC.2 day-by-day shape + date discipline (build-time guard)
  const dayByDay = records.filter((r) => r.itineraryDays && r.itineraryDays.length).length;
  console.log(`  [days] day-by-day invariant OK (${dayByDay} records carry a schedule)\n`);

  const out = {
    generated: new Date().toISOString().slice(0, 10),
    lines: lineCounts,
    records,
  };

  // Compact (no pretty-printing) — this is a generated build artifact consumed by the search
  // widget, not hand-edited, and pretty-printing alone added ~25% to the file size.
  const json = JSON.stringify(out);
  // Write both the engine copy (ingest reads it) and the website copy (the site bundles it). If the
  // website repo isn't present (engine-only checkout), skip its copy rather than fail the build.
  const sizeKB = (Buffer.byteLength(json) / 1024).toFixed(1);
  console.log(`\nTotal departures parsed: ${allRows.length}`);
  console.log(`Aggregated records: ${records.length}`);
  for (const outPath of OUT_PATHS) {
    const dir = path.dirname(outPath);
    if (outPath === WEBSITE_OUT && !fs.existsSync(dir)) {
      console.log(`Skipped ${path.relative(ROOT, outPath)} (website not present)`);
      continue;
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(outPath, json + "\n");
    console.log(`Wrote ${path.relative(ROOT, outPath)} (${sizeKB} KB)`);
  }
}

// Run the build only when executed directly (`node build-sailings-index.mjs` / `npm run
// build:index`), NOT when imported — so the build guards can be unit-tested in isolation without
// triggering a full rebuild as a side effect.
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  console.log("Building cruise sailings search index...\n");
  main();
}

// Exported for the build-guard tests (evals/test_build_guards.mjs). Kept at the bottom so the
// script's normal run is unaffected.
export { validateItineraryDays, DAYBYDAY_LINES, buildFromAcquired };
