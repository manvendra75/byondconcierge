"""engine.tools.lines — structured cruise-line facts from verified content.

Two read tools that serve line-level questions straight from the exported
``cruise-lines.json`` (the website's verified content) — no LLM, no invention:

* ``get_line_overview(slug)`` — the key facts about one line (fleet, home ports,
  GCC access, who it's best for, top FAQs), shaped for a grounded answer.
* ``compare_lines(slugs)`` — the same handful of attributes aligned across up to
  three lines, shaped for a comparison table.

Both draw only from the committed content, so answers cite real, checked facts.
An unknown slug returns a structured ``ToolError`` (never a crash) so the
orchestrator can branch on it cleanly.
"""

from __future__ import annotations

import json
from functools import lru_cache

from engine.config import PROJECT_ROOT
from engine.schemas import ToolError

# The committed content snapshot (published from the website repo). Same file the
# RAG loader reads; here we use its structured fields directly.
CRUISE_LINES_JSON = PROJECT_ROOT / "data" / "cruise-lines.json"

# How many FAQs to surface in an overview — enough to be useful, not a wall.
_TOP_FAQS = 3


# ---------------------------------------------------------------------------
# Load once, index by slug (cached for the process)
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _lines_by_slug() -> dict[str, dict]:
    """Read cruise-lines.json a single time and return a {slug: line} map. The
    lru_cache means every later lookup is an in-memory dict access."""
    data = json.loads(CRUISE_LINES_JSON.read_text(encoding="utf-8"))
    return {line["slug"]: line for line in data}


def _at_a_glance(line: dict, key: str) -> str | None:
    """Safely read one field out of a line's atAGlance block
    (fleetSize / homePorts / gccAccess)."""
    return line.get("atAGlance", {}).get(key)


# ---------------------------------------------------------------------------
# get_line_overview — the facts for a single line
# ---------------------------------------------------------------------------
def get_line_overview(line_slug: str) -> dict | ToolError:
    """Return the key facts about one cruise line as a plain dict, or a
    ``ToolError`` if the slug isn't one of the represented lines.

    The dict is deliberately compact — name, tagline, relationship, fleet size &
    ships, home ports, GCC access, who it's best for, and the top few FAQs — so
    it drops straight into a grounded answer without extra prose.
    """
    line = _lines_by_slug().get(line_slug)
    if line is None:
        return ToolError(detail=f"unknown line slug '{line_slug}'")

    return {
        "slug": line["slug"],
        "name": line["name"],
        "tagline": line["tagline"],
        "relationship": line["relationship"],       # PSA | Wholesale
        "fleetSize": _at_a_glance(line, "fleetSize"),
        "ships": line.get("ships", []),
        "homePorts": _at_a_glance(line, "homePorts"),
        "gccAccess": _at_a_glance(line, "gccAccess"),
        "bestFor": line.get("bestFor", []),
        "faqs": line.get("faqs", [])[:_TOP_FAQS],   # top FAQs, each {q, a}
    }


# ---------------------------------------------------------------------------
# compare_lines — a few attributes aligned across up to 3 lines
# ---------------------------------------------------------------------------
def compare_lines(slugs: list[str]) -> dict | ToolError:
    """Return a small comparison of 1–3 lines, shaped for a table, or a
    ``ToolError`` on a bad request (too many/few slugs, or an unknown one).

    Output shape::

        {
          "slugs": ["msc", "costa"],
          "names": ["MSC Cruises", "Costa Cruises"],
          "rows": [
            {"label": "Relationship", "values": ["PSA", "PSA"]},
            {"label": "Fleet size",   "values": ["23 ships", "9 ships"]},
            {"label": "GCC access",   "values": ["...", "..."]},
            {"label": "Best for",     "values": ["...; ...", "...; ..."]},
          ],
        }

    Each row's ``values`` line up column-by-column with ``names``/``slugs``, so a
    caller can render it directly.
    """
    # Validate the request shape before touching data.
    if not slugs or len(slugs) > 3:
        return ToolError(detail="compare_lines takes 1 to 3 line slugs")

    by_slug = _lines_by_slug()
    resolved: list[dict] = []
    for slug in slugs:
        line = by_slug.get(slug)
        if line is None:
            return ToolError(detail=f"unknown line slug '{slug}'")
        resolved.append(line)

    # Build one row per compared attribute, values aligned to the slug order.
    rows = [
        {"label": "Relationship", "values": [l["relationship"] for l in resolved]},
        {"label": "Fleet size", "values": [_at_a_glance(l, "fleetSize") for l in resolved]},
        {"label": "GCC access", "values": [_at_a_glance(l, "gccAccess") for l in resolved]},
        {"label": "Best for", "values": ["; ".join(l.get("bestFor", [])) for l in resolved]},
    ]
    return {
        "slugs": list(slugs),
        "names": [l["name"] for l in resolved],
        "rows": rows,
    }
