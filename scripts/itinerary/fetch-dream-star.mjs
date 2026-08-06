#!/usr/bin/env node
// fetch-dream-star.mjs — harvest StarDream's dated sailings from its SeawareTouch B2B portal.
// Thin wrapper over the shared SeawareTouch harvester (see seaware-harvest.mjs for how it works).
//
// YOU (once, session live): launch the debug Chrome, log into booking.stardreamcruises.com/touchb2b,
// run the WIDEST voyage search, set results to "All", leave the results showing. Then:
//    node scripts/itinerary/fetch-dream-star.mjs                 # attaches to localhost:9222
//    node scripts/itinerary/fetch-dream-star.mjs --diagnose      # show what the grid parser sees

import { harvestSeaware } from "./seaware-harvest.mjs";
import { stardreamDest } from "./classify.mjs";

harvestSeaware({
  line: "dream-star",
  ships: ["Genting Dream", "Star Navigator", "Star Voyager"],
  classify: stardreamDest,
  source: "booking.stardreamcruises.com SeawareTouch voyage search (authorized agent session; dated, no prices)",
}).catch((e) => { console.error(e); process.exit(1); });
