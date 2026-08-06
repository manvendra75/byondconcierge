#!/usr/bin/env node
// fetch-aroya.mjs — harvest Aroya's dated sailings from its SeawareTouch B2B portal.
// Thin wrapper over the shared SeawareTouch harvester (see seaware-harvest.mjs for how it works).
// Aroya (Cruise Saudi) runs the same SeawareTouch engine as StarDream; one ship ("Aroya"), sailing
// the Red Sea (Jeddah/Yanbu/Aqaba homeports) and the Mediterranean (Istanbul/Turkey/Greece).
//
// YOU (once, session live): launch the debug Chrome, log into booking.aroya.com/touchb2b, run the
// WIDEST voyage search, set results to "All", leave the results showing. Then:
//    node scripts/itinerary/fetch-aroya.mjs                 # attaches to localhost:9222
//    node scripts/itinerary/fetch-aroya.mjs --diagnose      # show what the grid parser sees

import { harvestSeaware } from "./seaware-harvest.mjs";
import { aroyaDest } from "./classify.mjs";

harvestSeaware({
  line: "aroya",
  ships: ["Aroya"],
  classify: aroyaDest,
  source: "booking.aroya.com SeawareTouch voyage search (authorized agent session; dated, no prices)",
}).catch((e) => { console.error(e); process.exit(1); });
