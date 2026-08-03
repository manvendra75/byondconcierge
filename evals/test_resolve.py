"""Unit tests for the deterministic resolvers (T2.1).

Pure functions, no DB or LLM — so these are fast, exact checks. Includes the
three "Done when" assertions from the spec plus the tricky cases: month
ambiguity, synonyms, aliases, and clean None returns for junk input.

Run with: ``pytest evals/test_resolve.py``.
"""

from engine.tools.resolve import (
    resolve_date_range,
    resolve_destination,
    resolve_line,
    resolve_month,
    resolve_port,
)


# ---------------------------------------------------------------------------
# resolve_month
# ---------------------------------------------------------------------------
def test_month_spec_example():
    assert resolve_month("Jan") == "2027-01"          # the spec's headline case


def test_month_variants_all_resolve_to_2027_01():
    assert resolve_month("january") == "2027-01"
    assert resolve_month("next jan") == "2027-01"
    assert resolve_month("in January") == "2027-01"


def test_month_ambiguous_when_two_in_window():
    # Aug appears in both 2026 and 2027 within the Jul2026–Dec2027 window.
    assert resolve_month("August") == "AMBIGUOUS"
    assert resolve_month("December") == "AMBIGUOUS"


def test_month_explicit_year_pins_it():
    assert resolve_month("aug 2027") == "2027-08"     # year given -> no ambiguity
    assert resolve_month("2027-01") == "2027-01"      # already-formatted passthrough


def test_month_out_of_window_or_junk_is_none():
    assert resolve_month("2025-05") is None           # before the window
    assert resolve_month("someday") is None
    assert resolve_month("") is None


# ---------------------------------------------------------------------------
# resolve_date_range (TB.5)
# ---------------------------------------------------------------------------
def test_date_range_spec_example():
    # The spec's headline case: "first half of August" -> days 1–15 of the soonest August.
    assert resolve_date_range("first half of August") == ("2026-08-01", "2026-08-15")


def test_date_range_qualifiers():
    assert resolve_date_range("second half of August") == ("2026-08-16", "2026-08-31")
    assert resolve_date_range("first week of September") == ("2026-09-01", "2026-09-07")
    assert resolve_date_range("last week of December") == ("2026-12-25", "2026-12-31")
    assert resolve_date_range("early October") == ("2026-10-01", "2026-10-10")
    assert resolve_date_range("mid October") == ("2026-10-11", "2026-10-20")
    assert resolve_date_range("late October") == ("2026-10-21", "2026-10-31")


def test_date_range_whole_month_and_year():
    # A bare month is the whole month; an explicit year pins it.
    assert resolve_date_range("August") == ("2026-08-01", "2026-08-31")
    assert resolve_date_range("August 2027") == ("2027-08-01", "2027-08-31")
    # A month whose 2026 occurrence is before the window resolves to 2027 (end-of-month is correct).
    assert resolve_date_range("late February") == ("2027-02-21", "2027-02-28")


def test_date_range_unparseable_or_out_of_window():
    assert resolve_date_range("sometime soon") == (None, None)   # no month
    assert resolve_date_range("") == (None, None)
    assert resolve_date_range("March 2025") == (None, None)      # before the window


# ---------------------------------------------------------------------------
# resolve_destination
# ---------------------------------------------------------------------------
def test_destination_spec_example():
    assert resolve_destination("med") == "Mediterranean"


def test_destination_exact_and_synonyms():
    assert resolve_destination("Mediterranean") == "Mediterranean"
    assert resolve_destination("caribbean") == "Caribbean"
    assert resolve_destination("gulf") == "Arabian Gulf"
    assert resolve_destination("fjords") == "Norwegian Fjords"


def test_destination_unknown_is_none():
    assert resolve_destination("the moon") is None
    assert resolve_destination("") is None


# ---------------------------------------------------------------------------
# resolve_port
# ---------------------------------------------------------------------------
def test_port_exact_and_shortest_pref():
    assert resolve_port("Dubai") == "Dubai"
    assert resolve_port("rome") == "Rome"             # shortest over "Rome (Civitavecchia)"


def test_port_qualifier_ignored():
    # "civitavecchia" appears only inside qualifiers, still resolves to a port.
    assert resolve_port("civitavecchia") is not None
    assert resolve_port("nowhere-town") is None


# ---------------------------------------------------------------------------
# resolve_line
# ---------------------------------------------------------------------------
def test_line_spec_example():
    assert resolve_line("royal caribbean") == "royal-caribbean"


def test_line_slug_name_alias():
    assert resolve_line("celebrity") == "celebrity"            # slug
    assert resolve_line("Costa Cruises") == "costa"            # display name
    assert resolve_line("NCL") == "norwegian"                  # abbreviation alias
    assert resolve_line("stardream") == "dream-star"           # alt spelling


def test_line_unknown_is_none():
    assert resolve_line("cunard") is None                     # not represented
    assert resolve_line("") is None
