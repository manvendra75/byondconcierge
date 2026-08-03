# Costa Cruises — Reference Brief for GCC Travel Agents

**Research date:** 6 July 2026.
**Source policy:** Costa Cruises official websites only (costacruises.com and its live booking-engine data feeds served from that domain). No trade press, blogs, Wikipedia or OTAs were used. Claims not verifiable on official Costa pages are marked **UNVERIFIED**. No prices or exact departure dates are included — only ship names, home ports, representative port sequences and general season months, as found on official pages/feeds.

**Method note:** Costa's site (costacruises.com) is an Adobe-AEM/React application — visible copy and live inventory are delivered as JSON to the browser rather than sitting in static HTML. To read it reliably, this research fetched the same JSON the official site itself loads: the live cruise-search results feed (`/search/costa_en_US/handler/occupancysearch`, which returned 1,746 currently bookable sailings) and the per-sailing itinerary feed (`/itineraries/{itineraryId}/{cruiseId}.cruiseData.light.json`) for a sample drawn from every home port present in that live feed. This is first-party Costa data, not a third-party aggregator.

---

## 1. Fleet & ships

Per Costa's own fleet-page FAQ: **"Costa Cruises has a total of 9 ships in service, recently renovated, all flying the Italian flag."** (Source: Costa official — https://www.costacruises.com/fleet.html)

The 9 ships (confirmed via the official fleet navigation, each with its own ship page):
- Costa Toscana — https://www.costacruises.com/fleet/toscana.html
- Costa Smeralda — https://www.costacruises.com/fleet/smeralda.html
- Costa Diadema — https://www.costacruises.com/fleet/diadema.html
- Costa Deliziosa — https://www.costacruises.com/fleet/deliziosa.html
- Costa Fascinosa — https://www.costacruises.com/fleet/fascinosa.html
- Costa Favolosa — https://www.costacruises.com/fleet/favolosa.html
- Costa Fortuna — https://www.costacruises.com/fleet/fortuna.html
- Costa Pacifica — https://www.costacruises.com/fleet/pacifica.html
- Costa Serena — https://www.costacruises.com/fleet/serena.html
(Source: Costa official — https://www.costacruises.com/fleet.html)

**Largest ship — Costa Toscana**, described on the official fleet page as "the next flagship": gross tonnage 185,000 tons, passenger capacity over 6,500, length 337m, width 42m, max speed 21.5 knots, 19 decks, 2,663 guest cabins (28 Suites, 106 Sea Terrace Cabins, 1,534 Sea Balcony Cabins), 17 restaurants, 16 bars, four swimming pools (one covered), a water park with three slides, a 65-metre scenic promenade ("Volare"), two theatres, a casino and a 4,500 sq m spa. Fuel type is **liquefied natural gas (LNG)**, marketed as "one of the most environmentally friendly ships in the industry" (Source: Costa official — https://www.costacruises.com/fleet.html).

**Smallest ship — Costa Deliziosa**: renovation year 2024, gross tonnage 92,600 tons, passenger capacity over 1,100, length 294m, width 32m, max speed 23 knots, 17 decks, 1,130 guest cabins (110 Suites, 662 Sea Balcony Cabins), seven restaurants, eight bars, two pools (one with retractable cover), an 800+-seat two-deck theatre, casino, five jacuzzis and a 3,500 sq m spa (Source: Costa official — https://www.costacruises.com/fleet.html).

Costa Smeralda is referred to elsewhere on the fleet page as Costa's (prior) flagship, and the cabin FAQ notes that **Costa Toscana and Costa Smeralda** are the two ships in the fleet without a standard in-cabin minibar (offering a customisable minibar instead), which — together with the LNG detail on Toscana — identifies these two as the newest, most premium ships in the current fleet (Source: Costa official — https://www.costacruises.com/fleet.html).

**Gulf/Middle East-deployed ships: none, currently.** Costa's own live sailings feed (see Section 2 below) lists zero departures from any Gulf home port across the entire window presently on sale (July 2026 – January 2028). No ship in the 9-strong fleet is currently rostered to the Gulf on the official site (Source: Costa official — https://www.costacruises.com/search/costa_en_US/handler/occupancysearch).

---

## 2. Worldwide 2026/27 deployment by region

Costa's official site organises sailings into named destination clusters (used both in main navigation and in the booking engine's destination filter, where each carries a short code, e.g. `CW`, `PG`, `RW`). The clusters found live on site: Western Mediterranean, Eastern Mediterranean, Mediterranean (aggregate)/Mini Cruises, Northern Europe & Fjords, Caribbean & Antilles, Canaries & African Atlantic, South America, Ocean Cruises, Asia, Dubai & Middle East, Special Cruises, World Cruise (Source: Costa official — https://www.costacruises.com/destinations.html, https://www.costacruises.com/ports.html).

Representative itineraries below were pulled directly from Costa's live per-sailing data feed for real, currently-listed departures (not illustrative/marketing copy), so ports and night-counts are exact; season months are the month of the sampled departure.

### Western Mediterranean
**Home ports:** Marseille, Barcelona, Palma de Mallorca, Valencia, Civitavecchia (Rome), Savona, Genoa (Portofino), Palermo, Cagliari, Alicante, Málaga, Cádiz, Taranto, La Seyne (St Tropez), Naples (Source: Costa official — live itinerary feed, costacruises.com).
- 10-night round-trip from Marseille on Costa Fascinosa: Marseille · Savona · Barcelona · Gibraltar · Tangier (Morocco) · Casablanca (Morocco) · Cádiz · Málaga · Marseille — sampled departure November 2026.
- 7-night round-trip from Palermo on Costa Toscana: Palermo · Civitavecchia (Rome) · Savona · Marseille · Barcelona · Palma de Mallorca · Palermo — sampled departure March 2027.
- 6-night round-trip from Genoa (Portofino) on Costa Fascinosa: Genoa · Civitavecchia (Rome) · Salerno · Messina (Sicily) · La Seyne (St Tropez) · Genoa — sampled departure April 2027.
(Source: Costa official — costacruises.com live itinerary feed)

### Eastern Mediterranean (Greek Isles/Adriatic)
**Home ports:** Istanbul, Piraeus (Athens), Trieste, Marghera (Venice), Bari, Catania, Taranto (Source: Costa official — live itinerary feed, costacruises.com).
- 7-night round-trip from Istanbul on Costa Fortuna: Istanbul · Mykonos · Heraklion (Crete) · Rhodes · Santorini · Piraeus (Athens) · Istanbul — sampled departure July 2026.
- 7-night round-trip from Piraeus (Athens) on Costa Pacifica: Piraeus · Istanbul · Mykonos · Heraklion (Crete) · Rhodes · Santorini · Piraeus — sampled departure July 2027.
- 6-night from Bari to Marghera (Venice) on Costa Deliziosa: Bari · Corfu · Zakynthos · Kefalonia · Dubrovnik (Croatia) · Split (Croatia) · Marghera (Venice) — sampled departure September 2026.
(Source: Costa official — costacruises.com live itinerary feed)

### Mini Cruises
Short 3-night round-trip sailings positioned as an entry-level/taster product, e.g. Savona ⇄ Barcelona ⇄ Marseille ⇄ Savona on Costa Favolosa, sampled departure May 2027 (Source: Costa official — costacruises.com live itinerary feed).

### Northern Europe & Fjords
**Home ports:** Kiel, Copenhagen, Hamburg (Source: Costa official — live itinerary feed, costacruises.com).
- 7-night round-trip from Kiel on Costa Diadema, calling at Copenhagen, Geiranger (Norwegian fjords) and Bergen among other Norwegian fjord ports — sampled departure July 2026.
- 12-night round-trip from Hamburg on Costa Favolosa, calling at Tromsø, Honningsvåg (North Cape), Trondheim and Ålesund (Norway) — an Arctic Norway/North Cape itinerary, sampled departure August 2026.
- Season is the northern summer (itineraries sampled fall between July and August).
(Source: Costa official — costacruises.com live itinerary feed)

### Caribbean & Antilles
**Home ports:** La Romana, Santo Domingo, Fort-de-France (Martinique), Pointe-à-Pitre (Guadeloupe) (Source: Costa official — live itinerary feed, costacruises.com).
- 7-night round-trip from La Romana on Costa Fascinosa: La Romana · St Lucia · Pointe-à-Pitre (Guadeloupe) · Antigua · Barbados · Tortola (BVI) · La Romana — sampled departure December 2026.
- 7-night round-trip from Santo Domingo on Costa Favolosa: Santo Domingo · Antigua · Fort-de-France (Martinique) · Pointe-à-Pitre · Barbados · Sint Maarten · Santo Domingo — sampled departure January 2027.
- A 14-night extended Antilles round-trip from La Romana on Costa Fascinosa was also sampled, departing January 2027.
- Season: northern-hemisphere winter (all sampled departures fall December–January).
(Source: Costa official — costacruises.com live itinerary feed)

### Canaries & African Atlantic
**Home ports:** Las Palmas (Gran Canaria), Santa Cruz (Tenerife) (Source: Costa official — live itinerary feed, costacruises.com).
- 7-night round-trip from Las Palmas on Costa Smeralda: Las Palmas (Gran Canaria) · Funchal (Madeira) · Tenerife · Fuerteventura · Lanzarote · Las Palmas — sampled departures in both November 2026 and February 2027, indicating the route runs across the winter season.
(Source: Costa official — costacruises.com live itinerary feed)

### South America
**Home ports:** Santos (São Paulo), Buenos Aires, Montevideo, Rio de Janeiro, Itajaí (Source: Costa official — live itinerary feed, costacruises.com).
- 9-night round-trip from Buenos Aires on Costa Serena: Buenos Aires · Montevideo · Rio de Janeiro · Ilhabela · Buenos Aires — sampled departure January 2027.
- 4-night short round-trip from Santos (São Paulo) on Costa Diadema: Santos · Ilhabela · Itajaí · Santos — sampled departure March 2027.
- Season: southern-hemisphere summer (sampled departures November–April).
(Source: Costa official — costacruises.com live itinerary feed)

### Ocean Cruises (transatlantic/repositioning)
**Home ports/typical routings:** Le Havre, Hamburg, Lisbon sailing to Caribbean or South American home ports (Source: Costa official — live itinerary feed, costacruises.com).
- 20-night repositioning cruise from Le Havre to Pointe-à-Pitre (Guadeloupe) on Costa Favolosa, calling at Lisbon, Cádiz, Las Palmas, Fort-de-France (Martinique) and further Antilles ports — sampled departure December 2026.
- 14-night repositioning cruise from Lisbon to Rio de Janeiro on Costa Diadema — sampled departure November 2026, timed to open the South America season.
(Source: Costa official — costacruises.com live itinerary feed)

### Asia
**Home ports (seasonal, Japan/Taiwan/Korea/Hong Kong region):** Yokohama (Tokyo), Shanghai, Busan, Hong Kong, Keelung (Taipei), Naha (Okinawa), Fukuoka, Nagasaki, Sasebo — all on Costa Serena (Source: Costa official — live itinerary feed, costacruises.com).
- 11-night round-Japan cruise from Yokohama (Tokyo) on Costa Serena, calling at Kobe and multiple Japanese/Korean ports including Nagasaki and Busan before returning to Tokyo — sampled departure October 2026.
- 7-night cruise from Hong Kong to Benoa (Bali) on Costa Serena, calling at Subic Bay and Philippine ports — sampled departure October 2026.
- Shorter 2–4 night island-hop sailings are also common in this region (e.g. Shanghai–Busan, Keelung–Naha, Nagasaki–Busan).
(Source: Costa official — costacruises.com live itinerary feed)

### World Cruise
Costa runs round-the-world sailings that can be booked as a full voyage or as individual segments, on Costa Deliziosa and Costa Serena (Source: Costa official — live itinerary feed, costacruises.com).
- A 100-night segment from San Francisco to Civitavecchia (Rome) on Costa Deliziosa, routed via Hawaii, French Polynesia, the South Pacific, Australia, East Asia (Japan/Korea/Taiwan/Hong Kong), Vietnam, Singapore, Sri Lanka, the Maldives, Mauritius and South Africa — sampled departure April 2027.
- A 51-night segment from Tokyo to San Antonio (Chile) on Costa Serena, routed via Taiwan, Hong Kong, the Philippines, Bali, Australia and South Pacific islands — sampled departure December 2026.
- Individual shorter segments (e.g. a 2-night Tokyo–Keelung leg, a 26-night San Francisco–Sydney leg, a 17-night Cape Town–Barcelona leg) are separately bookable, which matters for GCC agents wanting to sell a partial world-cruise segment rather than the full voyage.
(Source: Costa official — costacruises.com live itinerary feed)

### Special Cruises
"Special Cruises" is a named destination category in Costa's official navigation and search-engine filters (Source: Costa official — https://www.costacruises.com/destinations/special-cruises.html), but no representative sailing under this specific label was captured in the live-feed sample used for this research. **UNVERIFIED**: specific itineraries/theme for this category — agents should check this page directly for current content.

### Arabian Gulf / Dubai & Middle East — extra depth for GCC relevance

"Dubai & Middle East" (internal code `PG`) **is** a defined destination category in Costa's official cruise-search engine, and Costa still maintains dedicated marketing/port pages for the region:
- Dedicated port pages exist for Dubai (https://www.costacruises.com/ports/dubai.html) and Abu Dhabi (https://www.costacruises.com/ports/abu-dhabi.html), each carrying the meta description "Explore [Dubai/Abu Dhabi] on our stopover during the cruise to United Arab Emirates. A special adventure in Dubai & Middle East awaits you!" A similarly-worded page exists for Doha, Qatar (https://www.costacruises.com/ports/doha.html) (Source: Costa official, URLs above).
- By contrast, Muscat, Khasab, Bahrain, Sir Bani Yas and Fujairah do **not** have dedicated port pages on the official site — requests for these paths redirect to the generic all-ports listing, meaning only Dubai, Abu Dhabi and Doha are formally catalogued Gulf ports of call (Source: Costa official — https://www.costacruises.com/ports.html and redirect behaviour of the above paths).
- Two historical Gulf itinerary codes are still crawlable: an 8-day "Dubai and UAE" cruise ex-Abu Dhabi (itinerary code `AUH07A0O`) and a 12-day "Dubai and UAE" cruise ex-Abu Dhabi (itinerary code `AUH11A08`) (Source: Costa official — https://www.costacruises.com/cruises/AUH07A0O/TO07260206.html, https://www.costacruises.com/cruises/AUH11A08/SM11241223.html).
- **However**, querying Costa's own live sailings feed — the same feed the website's search results page uses, currently listing 1,746 bookable sailings spanning July 2026 to January 2028 — returns **zero** sailings with an Abu Dhabi or Dubai home port anywhere in that window (Source: Costa official — https://www.costacruises.com/search/costa_en_US/handler/occupancysearch). Querying the specific data feed for the two AUH itinerary codes above likewise returns an empty result (no ship, no ports, no dates), confirming those specific sailings are not currently open for sale (Source: Costa official — costacruises.com itinerary data feed for AUH07A0O/TO07260206 and AUH11A08/SM11241223).

**Net finding for GCC agents:** as of this research date, Costa Cruises has **no currently bookable cruise departing from or homeported in the Arabian Gulf** (Dubai, Abu Dhabi, Doha or elsewhere) on its official website, despite the brand retaining "Dubai & Middle East" as a named category and keeping Dubai/Abu Dhabi/Doha port pages live. This should be treated as the current, verified state of the official site rather than a permanent policy — agents should re-check https://www.costacruises.com/destinations.html and the Dubai/Abu Dhabi/Doha port pages periodically for any resumption.

---

## 3. Target clientele & positioning

As presented on the official site:
- **Overall brand tone:** the homepage meta description frames Costa cruises as "a holiday that's all about being happy" (Source: Costa official — https://www.costacruises.com/).
- **Italian heritage:** the fleet FAQ emphasises that all 9 ships are "recently renovated" and "all flying the Italian flag" — Italian design/hospitality is a stated brand pillar (Source: Costa official — https://www.costacruises.com/fleet.html).
- **Family cruising:** a dedicated "Family" deals page is promoted from the main navigation (Source: Costa official — https://www.costacruises.com/deals/family-cruise.html).
- **Honeymoon/couples:** a dedicated "Honeymoon trip" deals page is promoted alongside the family offer (Source: Costa official — https://www.costacruises.com/deals/honeymoons.html).
- **Accessibility:** a "Travel without barriers" page and a "Cruises for everyone" page are both promoted in main navigation, positioning Costa as accessible to guests with disabilities (Source: Costa official — https://www.costacruises.com/experience/cruises-for-disabled.html, https://www.costacruises.com/cruises-for-everyone.html).
- **Sustainability:** a dedicated Sustainability page is linked from the global navigation (Source: Costa official — https://www.costacruises.com/experience/sustainability.html); on-ship, the two newest/flagship-class vessels, Costa Toscana and Costa Smeralda, are LNG-powered, marketed as "one of the most environmentally friendly ships in the industry" (Source: Costa official — https://www.costacruises.com/fleet.html).
- **Shore experiences beyond standard excursions:** Costa promotes "Land Experiences" on its homepage as "more than just excursions" — "A New Way To Explore Each Destination," built around curated themes ("See it All") for guests wanting deeper destination immersion (Source: Costa official — https://www.costacruises.com/).
- **Loyalty and self-service:** Costa operates a "C|Club" loyalty programme (member discounts up to 20% on cruises, up to 50% on selected onboard products/services, plus a points system) and "MyCosta," a self-service digital portal/app promoted from the main navigation (Source: Costa official — https://www.costacruises.com/c-club.html, https://www.costacruises.com/mycosta.html).
- **Suite-tier butler service:** Suite guests fleet-wide (per the fleet FAQ) receive a personal butler (in-cabin dining, spa/excursion/restaurant reservations, fruit basket on embarkation, luggage rearrangement), a welcome bottle of Ferrari Maximum sparkling wine, a coffee machine with capsules, and — on Costa Toscana and Costa Smeralda specifically — a customisable minibar (Source: Costa official — https://www.costacruises.com/fleet.html).

---

## 4. Notes for GCC agents

- **No current Gulf embarkation option.** As detailed in Section 2, Costa's official live inventory shows no Abu Dhabi/Dubai-homeported sailings through at least January 2028. GCC-based clients wanting to sail Costa currently need a fly-cruise arrangement into one of Costa's active home ports — most relevantly the Mediterranean (Civitavecchia/Rome, Barcelona, Marseille, Savona, Palma, Venice/Marghera, Istanbul, Piraeus/Athens) or Northern Europe (Kiel, Copenhagen, Hamburg), depending on season and client preference (Source: Costa official — costacruises.com live itinerary feed, as cited in Section 2).
- **Fly-cruise/flight-inclusive fares exist in the booking engine.** Costa's own cruise-search interface includes an "Available flight" filter label, indicating flight-inclusive fare options are a standard, filterable product on the official booking engine — relevant for GCC agents packaging air+sea for clients travelling to a European or other overseas embarkation port (Source: Costa official — costacruises.com search-engine UI labels).
- **Gulf port pages remain live as marketing content.** The Dubai, Abu Dhabi and Doha port pages continue to be indexed and promoted ("A special adventure in Dubai & Middle East awaits you!"), which may indicate the brand's intent to keep the Gulf market warm even without current live sailings — worth monitoring for a resumption announcement rather than assuming permanent exit (Source: Costa official — https://www.costacruises.com/ports/dubai.html, https://www.costacruises.com/ports/abu-dhabi.html, https://www.costacruises.com/ports/doha.html).
- **World Cruise segments are separately bookable.** For GCC clients wanting a shorter taste of Costa's round-the-world product without the full multi-month commitment, individual segments (e.g. a Hong Kong–Bali leg, a Cape Town–Barcelona leg) can be booked on their own, per the segment-level itinerary codes found in the official live feed (Source: Costa official — costacruises.com live itinerary feed, Section 2 World Cruise notes).
- **Loyalty/self-service tools to set client expectations:** C|Club (tiered loyalty discounts) and the MyCosta portal/app are both official, English-language-accessible tools GCC agents can point clients to for pre-cruise self-service and on-board discount tracking (Source: Costa official — https://www.costacruises.com/c-club.html, https://www.costacruises.com/mycosta.html).

---

### UNVERIFIED items (kept out of main sections)
1. Exact contents/theme of the "Special Cruises" destination category — page exists officially but no representative sailing was captured in this research's live-feed sample.
2. Precise identity of a small number of ambiguous 3-letter port codes encountered in sampled itineraries (e.g. a code in one Northern-Europe fjord itinerary and one Eastern-Mediterranean itinerary) that could not be confidently matched to a named port from official pages alone — these ports were omitted from the representative itinerary descriptions above rather than guessed.
3. Whether Costa's Gulf withdrawal for the 2026/27 season (as observed via the live feed) is a one-season pause or a longer-term change — the official site gives no forward-looking statement either way; only the current absence of live inventory is verified.
