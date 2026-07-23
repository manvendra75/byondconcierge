"""Round-trip tests for the Pydantic contracts (T0.3 acceptance).

For each schema: one *good* example must validate, and one *bad* example must
raise. These are the deterministic checks that prove the contracts behave
before any logic is built on top of them. Run with: ``pytest evals/``.
"""

import pytest
from pydantic import ValidationError

from engine.schemas import (
    IntentResult,
    KnowledgeHit,
    LeadEnquiry,
    SailingFilters,
    SailingRow,
    SearchSailingsOutput,
    ToolError,
    UserProfile,
)


# ---------------------------------------------------------------------------
# UserProfile — the phone validator is the interesting part
# ---------------------------------------------------------------------------
def test_user_profile_good():
    u = UserProfile(
        agency="Sunrise Travel", full_name="Aisha Khan",
        email="aisha@sunrise.ae", phone="+971 4 458 0111",
    )
    assert u.phone == "+97144580111"          # spaces stripped by the validator


def test_user_profile_rejects_bad_phone():
    with pytest.raises(ValidationError):
        UserProfile(agency="X Co", full_name="Jo Lee",
                    email="jo@x.com", phone="abc")


def test_user_profile_rejects_bad_email():
    with pytest.raises(ValidationError):
        UserProfile(agency="X Co", full_name="Jo Lee",
                    email="not-an-email", phone="+12345678")


# ---------------------------------------------------------------------------
# IntentResult — literal set + confidence bounds
# ---------------------------------------------------------------------------
def test_intent_good():
    assert IntentResult(intent="price_intent", confidence=0.9).confidence == 0.9


def test_intent_rejects_unknown_label():
    with pytest.raises(ValidationError):
        IntentResult(intent="buy_now", confidence=0.5)


def test_intent_rejects_out_of_range_confidence():
    with pytest.raises(ValidationError):
        IntentResult(intent="in_scope", confidence=1.5)


# ---------------------------------------------------------------------------
# SailingFilters — all-optional, but nights must be >= 1 when given
# ---------------------------------------------------------------------------
def test_sailing_filters_good():
    f = SailingFilters(dest="Mediterranean", month="2027-01", nights_min=7)
    assert f.line is None and f.nights_min == 7


def test_sailing_filters_rejects_zero_nights():
    with pytest.raises(ValidationError):
        SailingFilters(nights_min=0)


# ---------------------------------------------------------------------------
# SailingRow + SearchSailingsOutput
# ---------------------------------------------------------------------------
def test_sailing_row_good():
    r = SailingRow(line="msc", ship="MSC Euribia", name="Emirates Cruises",
                   dest_label="Arabian Gulf", nights="7 nights",
                   port="Dubai", coverage="Nov 2026 – Mar 2027", count=12)
    assert r.count == 12


def test_search_output_good_and_bad_status():
    ok = SearchSailingsOutput(status="ok", total_matches=3)
    assert ok.rows == []
    with pytest.raises(ValidationError):
        SearchSailingsOutput(status="whatever")     # not in the Literal


# ---------------------------------------------------------------------------
# KnowledgeHit
# ---------------------------------------------------------------------------
def test_knowledge_hit_good_and_bad():
    KnowledgeHit(line="celebrity", doc_type="brief",
                 text="All Included fare...", source="celebrity.md#whats-included")
    with pytest.raises(ValidationError):
        KnowledgeHit(line="celebrity")              # missing required fields


# ---------------------------------------------------------------------------
# LeadEnquiry — party_size >= 1 is the key guard
# ---------------------------------------------------------------------------
def test_lead_good():
    lead = LeadEnquiry(
        user_email="aisha@sunrise.ae", agency="Sunrise Travel",
        full_name="Aisha Khan", phone="+97144580111",
        summary="Wants MSC Gulf fares for Dec, family of 4.",
        line_slug="msc", party_size=4,
    )
    assert lead.party_size == 4


def test_lead_rejects_negative_party_size():
    with pytest.raises(ValidationError):
        LeadEnquiry(user_email="a@b.com", agency="X", full_name="Jo",
                    phone="+12345678", summary="hi", party_size=-1)


# ---------------------------------------------------------------------------
# ToolError
# ---------------------------------------------------------------------------
def test_tool_error_good_and_bad():
    assert ToolError(detail="unknown line slug").status == "error"
    with pytest.raises(ValidationError):
        ToolError()                                 # detail is required
