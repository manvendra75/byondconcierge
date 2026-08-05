// TD.2 — Shared destination classification for the acquisition pipeline.
//
// The builder used to own one bespoke region→destination map or classifier per line, tied to each
// line's markdown format. As lines move to acquisition (Stage D), classification moves HERE — one
// module the importers share — so the builder's generic `buildFromAcquired` path just reads a
// canonical `dest` off each snapshot itinerary. `from-compass.mjs` validateOutput imports
// `isDestination` to reject a non-canonical dest at acquisition time.
//
// The canonical taxonomy MUST mirror website/src/lib/searchTypes.ts DESTINATIONS (and the copy in
// build-sailings-index.mjs). If you add a destination there, add it here too.

// ---------------------------------------------------------------------------------------
// Canonical destination taxonomy (22) — the only values a record's `dest` may take.
// ---------------------------------------------------------------------------------------
export const DESTINATIONS = new Set([
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

export const isDestination = (d) => DESTINATIONS.has(d);

// ---------------------------------------------------------------------------------------
// Carnival — GoCCL `destinationCode` → canonical destination.
// ---------------------------------------------------------------------------------------
// GoCCL gives a stable 1–3 letter code per sailing (the display name drifts — "The Bahamas" vs
// "Bahamas" — but the code does not), so we classify off the code. All 40 codes present in the live
// catalogue are mapped; an unmapped code throws (a new GoCCL region should be noticed, not silently
// dropped), mirroring the old parseCarnival's strictness. Caribbean sub-regions (East/West/South/
// Panama) collapse to "Caribbean"; every Australian coastal region → "Australia & New Zealand".
export const CARNIVAL_DEST_CODE = {
  AB: "Australia & New Zealand",         // Airlie Beach
  AJ: "Alaska",                          // Alaska & Japan
  BF: "South Pacific",                   // Mutiny on the Bounty & Fiji
  BH: "Bahamas",
  BI: "Northern Europe & Baltic",        // British Isles
  BM: "North America & Canada",          // Bermuda
  CE: "Caribbean",                       // Eastern Caribbean
  CG: "Greek Isles & Aegean",            // Croatia, Greece & Italy
  CP: "Caribbean",                       // Caribbean & Panama
  CS: "Caribbean",                       // Southern Caribbean
  CW: "Caribbean",                       // Western Caribbean
  EC: "Mediterranean",                   // Eclipse Spain/Portugal/France
  EN: "Northern Europe & Baltic",        // Northern Europe
  ES: "Northern Europe & Baltic",        // Scandinavia & Baltic
  ET: "Transatlantic & repositioning",   // Transatlantic
  FS: "South Pacific",                   // Fiji & South Pacific
  GB: "Australia & New Zealand",         // Great Barrier Reef
  GC: "North America & Canada",          // Greenland & Canada
  GE: "Australia & New Zealand",         // Getaway
  GI: "Greek Isles & Aegean",            // Greek Isles, Turkey & Italy
  GL: "Alaska",                          // Inside Passage & Glacier
  H: "Hawaii",
  IB: "Mediterranean",                   // Spain, Portugal & France
  KB: "Australia & New Zealand",         // Tasmania
  KI: "Australia & New Zealand",         // Kangaroo Island
  MB: "Mexico & Baja",                   // Baja Mexico
  MC: "Australia & New Zealand",         // Melbourne Cup
  ME: "Mediterranean",
  MI: "Australia & New Zealand",         // Moreton Island
  MR: "Mexico & Baja",                   // Mexican Riviera
  NI: "Australia & New Zealand",         // Norfolk Island
  NO: "North America & Canada",          // Canada
  NV: "South Pacific",                   // Vanuatu & New Caledonia
  NZ: "Australia & New Zealand",         // New Zealand
  PI: "Australia & New Zealand",         // Phillip Island
  S: "South America",
  T: "Caribbean",                        // Panama Canal
  TH: "South Pacific",                   // Tahiti & Pacific Islands
  VN: "South Pacific",                   // Vanuatu
  XS: "Southeast Asia",
};

export function carnivalDest(code) {
  const dest = CARNIVAL_DEST_CODE[code];
  if (!dest) throw new Error(`classify: unmapped Carnival destinationCode "${code}"`);
  return dest;
}

// ---------------------------------------------------------------------------------------
// Disney — region phrase (from the itinerary name) + embark port → canonical destination.
// ---------------------------------------------------------------------------------------
// Disney names read "N-Night <Region> Cruise from <Port> [ending in <Port>]"; the region phrase is
// the classifying signal, with the Singapore short cruises (bare "N-Night Cruise from Singapore",
// empty region) resolved by port. Migrated verbatim from the builder.
export function disneyRegionOf(name) {
  const m = String(name).match(/^\d+-Night\s+(.+?)\s+(?:Cruise\s+)?from\s+/i);
  let r = m ? m[1].replace(/\s+Cruise$/i, "").trim() : String(name);
  if (r.toLowerCase() === "cruise") r = "";
  return r;
}

export function disneyDest(regionPhrase, port = "") {
  const p = String(regionPhrase).trim();
  if (/bahamian/i.test(p)) return "Bahamas";
  if (/baja/i.test(p)) return "Mexico & Baja";
  if (/mexican riviera/i.test(p)) return "Mexico & Baja";
  if (/belgium|netherlands|northern europe|british isles|spain|western europe/i.test(p)) return "Northern Europe & Baltic";
  if (/norwegian fjords/i.test(p)) return "Norwegian Fjords";
  if (/alaskan/i.test(p)) return "Alaska";
  if (/pacific coast/i.test(p)) return "North America & Canada";
  if (/transatlantic/i.test(p)) return "Transatlantic & repositioning";
  if (/panama canal/i.test(p)) return "Transatlantic & repositioning";
  if (/mediterranean|adriatic/i.test(p)) return "Mediterranean";
  if (/southern caribbean|eastern caribbean|western caribbean/i.test(p)) return "Caribbean";
  if (p === "" && /singapore/i.test(port)) return "Southeast Asia";
  throw new Error(`classify: unmapped Disney region phrase "${p}"`);
}

/** Classify an acquired Disney itinerary; returns a canonical dest or null (caller skips + logs). */
export function disneyDestForItin(itin) {
  for (const cand of [disneyRegionOf(itin.name), itin.name]) {
    try { return disneyDest(cand, itin.departPort || ""); } catch { /* try next */ }
  }
  return null;
}

// ---------------------------------------------------------------------------------------
// Silversea — page-data `destination.name.en` → canonical destination.
// ---------------------------------------------------------------------------------------
// silversea.com tags each voyage with one destination (the value at cruise.data.destination.name.en,
// e.g. "MEDITERRANEAN", "CARIBBEAN & CENTRAL AMERICA"). All 13 live values are mapped; lookup is
// case-insensitive (the source is uppercase). Galápagos → South America (Ecuador); Antarctica →
// Expedition (Polar).
export const SILVERSEA_DEST = {
  "africa & indian ocean": "Middle East & Africa journeys",
  "alaska": "Alaska",
  "antarctica": "Expedition (Polar)",
  "asia": "Asia (Far East)",
  "australia & new zealand": "Australia & New Zealand",
  "canada & new england": "North America & Canada",
  "caribbean & central america": "Caribbean",
  "french polynesia & pacific": "South Pacific",
  "galápagos islands": "South America",
  "mediterranean": "Mediterranean",
  "northern europe & british isles": "Northern Europe & Baltic",
  "south america": "South America",
  "transoceanic": "Transatlantic & repositioning",
};

export function silverseaDest(region) {
  const dest = SILVERSEA_DEST[String(region).trim().toLowerCase()];
  if (!dest) throw new Error(`classify: unmapped Silversea destination "${region}"`);
  return dest;
}

// ---------------------------------------------------------------------------------------
// Costa — the CostaClick API's `Destination.Name` on each cruise (GetExtendedCruiseListData).
// ---------------------------------------------------------------------------------------
// Costa groups by a handful of coarse marketing regions. The clear geographic ones map straight to a
// canonical bucket; the duration/type labels (Mini/Special) that aren't a place map to their usual
// region (Costa's mini breaks are Mediterranean) or are left unmapped rather than guessed.
export const COSTA_DEST = {
  "western mediterranean": "Mediterranean",
  "eastern mediterranean": "Mediterranean",
  "mediterranean": "Mediterranean",
  "asia": "Asia (Far East)",
  "asian cruises": "Asia (Far East)",
  "northern europe & fjords": "Norwegian Fjords",
  "north europe and fjords": "Norwegian Fjords",
  "mini cruises": "Mediterranean",       // Costa mini-breaks are Med short hops
  "ocean cruises": "Transatlantic & repositioning",
  "world cruise": "World & Grand Voyages",
  "caribbean & antilles": "Caribbean",
  "canaries & african atlantic": "Middle East & Africa journeys",
  // "Special Cruises" left unmapped on purpose — it's a themed/type label, not a place, so the
  // sailing is kept with no dest rather than guessed.
};

// Lenient (unlike Silversea): an unmapped/absent Costa destination returns undefined so the sailing is
// still kept rather than dropped. The fetcher then falls back to costaDestFromName.
export function costaDest(name) {
  if (!name) return undefined;
  return COSTA_DEST[String(name).trim().toLowerCase()];   // undefined when unmapped
}

// Fallback for Costa's "Special Cruises" catch-all (spans several real regions): infer the canonical
// destination from the itinerary NAME, which Costa builds from the countries visited ("Argentina,
// Uruguay, Brazil", "Germany, Norway", "Italy, France, Balearic Islands, Spain"). Region-specific
// patterns are tried before the broad Mediterranean one, and the first match wins.
const COSTA_NAME_DEST = [
  [/argentin|uruguay|brazil|brasil|chile|falkland|patagon/i, "South America"],
  [/norway|norweg|fjord|bergen|narvik|geiranger|tromso/i, "Norwegian Fjords"],
  [/germany|denmark|iceland|baltic|sweden|finland|hamburg|norther/i, "Northern Europe & Baltic"],
  [/caribbe|antilles|bahamas/i, "Caribbean"],
  [/canar|africa|morocco|senegal|cape verde|namibia/i, "Middle East & Africa journeys"],
  [/japan|china|korea|taiwan|\basia\b|singapore|thailand|vietnam/i, "Asia (Far East)"],
  [/italy|france|spain|balearic|malta|greece|croatia|portugal|mediterran|adriatic/i, "Mediterranean"],
];

export function costaDestFromName(name) {
  if (!name) return undefined;
  for (const [re, dest] of COSTA_NAME_DEST) if (re.test(name)) return dest;
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Norwegian (NCL) — the vacations API's destinationCodes (GET /api/vacations/v2/itineraries).
// ---------------------------------------------------------------------------------------
export const NCL_DEST = {
  ALASKA: "Alaska",
  CARIBBEAN: "Caribbean",
  BAHAMAS: "Bahamas",
  WEEKEND: "Bahamas",                         // NCL weekend getaways are Bahamas/FL short breaks
  BERMUDA: "North America & Canada",
  CANADA_NEW_ENGL: "North America & Canada",
  PACIFIC_COASTAL: "North America & Canada",
  HAWAII: "Hawaii",
  MEXICAN_RIVIERA: "Mexico & Baja",
  MEDITERRANEAN: "Mediterranean",
  GREEK_ISLES: "Greek Isles & Aegean",
  NORTHERN_EUROPE: "Northern Europe & Baltic",
  ASIA: "Asia (Far East)",
  AUSTRALIA: "Australia & New Zealand",
  SOUTH_PACIFIC: "South Pacific",
  AFRICA: "Middle East & Africa journeys",
  SOUTH_AMERICA: "South America",
  TRANSATLANTIC: "Transatlantic & repositioning",
  PANAMA_CANAL: "Transatlantic & repositioning",
  EXTRAORDINARY_JOURNEYS: "World & Grand Voyages",   // NCL's long/exotic grand voyages
};

// Lenient: an unmapped code returns undefined (fetcher falls back to a name-based guess).
export function nclDest(code) {
  if (!code) return undefined;
  return NCL_DEST[String(code).trim().toUpperCase().replace(/[\s-]+/g, "_")];
}

// ---------------------------------------------------------------------------------------
// Royal Caribbean — the GraphQL itinerary.destination.name (POST /cruises/graph). Names are
// descriptive, so classify by keyword (more robust than learning RCL's internal codes).
// ---------------------------------------------------------------------------------------
const RCL_NAME_DEST = [
  [/bahamas|perfect day|coco ?cay/i, "Bahamas"],
  [/caribbean|antilles/i, "Caribbean"],
  [/alaska/i, "Alaska"],
  [/bermuda/i, "North America & Canada"],
  [/canada|new england/i, "North America & Canada"],
  [/hawaii/i, "Hawaii"],
  [/mexico|baja/i, "Mexico & Baja"],
  [/greek|greece|aegean/i, "Greek Isles & Aegean"],
  [/fjord/i, "Norwegian Fjords"],
  [/baltic|scandinav|iceland|northern europe/i, "Northern Europe & Baltic"],
  [/mediterran/i, "Mediterranean"],
  [/japan|\basia\b|far east|singapore|vietnam|thailand/i, "Asia (Far East)"],
  [/australia|new zealand/i, "Australia & New Zealand"],
  [/south pacific|tahiti|fiji|hawaii/i, "South Pacific"],
  [/dubai|middle east|arabia|africa|suez/i, "Middle East & Africa journeys"],
  [/pacific northwest/i, "North America & Canada"],
  [/panama/i, "Transatlantic & repositioning"],
  [/transatlantic|transpacific|repositioning|crossing/i, "Transatlantic & repositioning"],
  [/gal[aá]pagos/i, "South America"],   // Celebrity's Galápagos (canonical has no Galápagos bucket)
  [/south america/i, "South America"],
  [/world|grand voyage/i, "World & Grand Voyages"],
  [/europe/i, "Mediterranean"],   // generic "Europe" (RCG's is mostly Med) — broad, last
];

export function rclDest(name) {
  if (!name) return undefined;
  for (const [re, dest] of RCL_NAME_DEST) if (re.test(name)) return dest;
  return undefined;
}

// ---------------------------------------------------------------------------------------
// Scenic & Emerald — from the scenic-catalog departures API (productLine + productDestination)
// plus the tour NAME. River in Europe is the big bucket; ocean/expedition classified by keywords.
// ---------------------------------------------------------------------------------------
export function scenicDest(productLine, productDestination, name = "") {
  const line = String(productLine || "").toLowerCase();
  const dst = String(productDestination || "").toLowerCase();
  // Expedition/polar first (Scenic Eclipse ocean voyages), by name.
  if (/antarctic|arctic|greenland|svalbard|northwest passage|north pole|polar/i.test(name)) return "Expedition (Polar)";
  if (line.includes("river")) {
    if (dst.includes("europe")) return "European rivers";
    if (/nile|egypt/i.test(name)) return "Middle East & Africa journeys";
    if (/mekong|vietnam|cambodia|ganges|india/i.test(name)) return "Southeast Asia";  // closest canonical bucket
    if (dst.includes("asia")) return "Southeast Asia";
    return "European rivers";                              // Scenic's rivers are overwhelmingly European
  }
  // Ocean / discovery voyages: keyword-classify the name, then the destination word.
  return rclDest(name) || rclDest(productDestination) || costaDestFromName(name);
}

// ---------------------------------------------------------------------------------------
// Dispatcher — classify one acquired itinerary for a line into a canonical destination.
// ---------------------------------------------------------------------------------------
// Reads the natural signal per line (Carnival: destinationCode; Disney: name+port; Silversea:
// region). A snapshot that already carries a canonical `dest` is accepted as-is (curated lines,
// TD.14). Returns the canonical dest, or null when a lenient source can't be classified (the caller
// skips + logs rather than guessing). Carnival/Silversea throw on an unmapped code/region.
export function classify(line, itin) {
  if (itin.dest && isDestination(itin.dest)) return itin.dest;   // already canonical (curated)
  switch (line) {
    case "carnival": return carnivalDest(itin.destinationCode);
    case "disney": return disneyDestForItin(itin);
    case "silversea": return silverseaDest(itin.region);
    case "costa": return costaDest(itin.destination);       // fetcher usually bakes dest already
    case "norwegian": return nclDest(itin.destination);     // fetcher usually bakes dest already
    case "royal-caribbean": return rclDest(itin.destination);
    case "celebrity": return rclDest(itin.destination);     // same RCG GraphQL destination names
    case "scenic-emerald": return itin.dest || null;        // fetcher bakes dest (scenicDest); unmapped → skip
    default:
      throw new Error(`classify: no classifier for line "${line}" (itinerary "${itin.name}")`);
  }
}
