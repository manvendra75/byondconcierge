"""Acceptance tests for the line tools (T2.3).

Spec "Done when": get_line_overview("celebrity") returns 15 ships and the
gccAccess string; compare_lines(["msc","costa"]) returns two aligned columns.
Plus the error paths (unknown slug, bad slug count).

Pure reads from the committed cruise-lines.json — no DB, no LLM.

Run with: ``pytest evals/test_lines.py``.
"""

from engine.schemas import ToolError
from engine.tools.lines import compare_lines, get_line_overview


# ---------------------------------------------------------------------------
# get_line_overview
# ---------------------------------------------------------------------------
def test_overview_celebrity_ships_and_gcc():
    o = get_line_overview("celebrity")
    assert not isinstance(o, ToolError)
    assert o["name"] == "Celebrity Cruises"
    assert len(o["ships"]) == 15                       # full verified fleet
    assert isinstance(o["gccAccess"], str) and o["gccAccess"]   # non-empty string
    assert o["relationship"] in ("PSA", "Wholesale")
    assert len(o["faqs"]) <= 3                          # top few only


def test_overview_unknown_slug_is_toolerror():
    o = get_line_overview("cunard")
    assert isinstance(o, ToolError)
    assert "cunard" in o.detail


# ---------------------------------------------------------------------------
# compare_lines
# ---------------------------------------------------------------------------
def test_compare_two_lines_aligned_columns():
    c = compare_lines(["msc", "costa"])
    assert not isinstance(c, ToolError)
    assert c["names"] == ["MSC Cruises", "Costa Cruises"]
    # every comparison row has one value per line, in the same order
    for row in c["rows"]:
        assert len(row["values"]) == 2
    # the expected attributes are present
    labels = [r["label"] for r in c["rows"]]
    assert labels == ["Relationship", "Fleet size", "GCC access", "Best for"]


def test_compare_rejects_unknown_and_bad_count():
    assert isinstance(compare_lines(["msc", "atlantis"]), ToolError)   # unknown slug
    assert isinstance(compare_lines([]), ToolError)                    # too few
    assert isinstance(compare_lines(["a", "b", "c", "d"]), ToolError)  # too many
