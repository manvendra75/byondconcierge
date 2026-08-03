# Aroya — day-by-day refresh

**Status:** ⛔ Not scraped — robots.txt blocks us · **Route:** PSA partner channel · **Cadence:** when the partner sends updated content

**Do NOT run automated scraping against aroya.com.** Its `robots.txt` explicitly disallows
`User-agent: ClaudeBot` (`Disallow: /`) and signals `ai-train=no`. Per the hard compliance boundary,
we obtain Aroya's day-by-day through the **partner channel**, not scraping. (Aroya is a Byond Borders
PSA partner, so a licensed content pack / feed is the right basis.)

Low urgency: only ~14 sailings, and the catalogue already carries the port route, so day-by-day is
enrichment.

## To populate

1. **Get the day-by-day from the Aroya PSA partner channel** (trade content pack / licensed feed) in the
   canonical format — see [../README.md](../README.md#canonical-acquired-file-format).
   - *Alternative, business's call:* Aroya's `User-agent: *` is unrestricted, so Byond Borders could run a
     **non-Claude** importer from its own infrastructure under that rule. That is a decision for the
     business (not run by Claude), and the trade agreement should back it.
2. Save the result as `docs\research\cruise-lines\aroya-itineraries-<date>.json`.
3. Publish into the engine — see [../README.md](../README.md#publish-into-the-engine-same-for-every-line-after-acquiring).

## Notes

- Compliance basis recorded in `skills\cruise-line-scraper\workdir\aroya\registry.yaml` (`status: blocked`).
- No prices in itinerary data.
