"""Renderer tests for the sailings itinerary output (TA.6).

``_route_summary`` must present a sailing's route HONESTLY and never invent stops.
Three grounded cases:
  * a full route is published -> the ordered ports of call;
  * only the endpoints are known (one-way, no intermediate list) -> "embark -> arrival",
    explicitly flagged so the agent offers the port-by-port detail on request;
  * nothing is published (or a round trip with no stops) -> "port-by-port itinerary on
    request" — the agent must offer to confirm, not guess.

These are pure functions (no API key / no agent build), so the tests are fast.

Run with: ``pytest evals/test_agent.py``.
"""

from engine.agent import _render_sailings, _route_summary
from engine.schemas import SailingRow, SearchSailingsOutput


def _row(**overrides) -> SailingRow:
    """A SailingRow with sensible defaults; override just the fields a case needs."""
    base = dict(line="aroya", ship="Aroya", name="Test Sailing", dest_label="Mediterranean",
                nights="6 nights", port="Istanbul", coverage="Aug 2026", count=1)
    base.update(overrides)
    return SailingRow(**base)


# ---------------------------------------------------------------------------
# Case 1 — a full route renders as the ordered ports of call
# ---------------------------------------------------------------------------
def test_full_route_renders_ordered_ports():
    r = _row(ports=["Istanbul", "Alexandria", "Kas", "Bodrum", "Marmaris"], port_disembark="Marmaris")
    assert _route_summary(r) == "route: Istanbul → Alexandria → Kas → Bodrum → Marmaris"


# ---------------------------------------------------------------------------
# Case 2 — endpoints only (one-way): show both, flag intermediate ports on request
# ---------------------------------------------------------------------------
def test_endpoints_only_flags_intermediate_on_request():
    r = _row(port="Stockholm", ports=[], port_disembark="Oslo")
    assert _route_summary(r) == "route: Stockholm → Oslo (intermediate ports on request)"


# ---------------------------------------------------------------------------
# Case 3 — nothing published (or a round trip with no stops): never invent
# ---------------------------------------------------------------------------
def test_no_route_falls_back_to_on_request():
    # No ports and no arrival at all (e.g. Royal Caribbean's region-only rows).
    assert _route_summary(_row(ports=[], port_disembark=None)) == "port-by-port itinerary on request"
    # A round trip whose stops aren't published: arrival == embark, so no useful route.
    assert _route_summary(_row(port="Papeete", ports=[], port_disembark="Papeete")) == (
        "port-by-port itinerary on request")


# ---------------------------------------------------------------------------
# The full block includes the route on each row
# ---------------------------------------------------------------------------
def test_render_sailings_includes_route_per_row():
    out = SearchSailingsOutput(
        status="ok", total_matches=1,
        rows=[_row(ports=["Istanbul", "Marmaris"], port_disembark="Marmaris")],
    )
    text = _render_sailings(out)
    assert text.startswith("Showing 1 of 1 matching sailings")
    assert "route: Istanbul → Marmaris" in text
