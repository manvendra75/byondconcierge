"""engine.schemas — the typed contracts every boundary in the system obeys.

Following the guide's principle that "any step that feeds another system should
return predictable structure, not freeform prose", these Pydantic models are
the *contracts*: model outputs are validated into them, tools take and return
them, and the UI collects into them. Defining them all up front — before any
logic — means the rest of the build just fills in behaviour behind fixed shapes.

Nothing here has side effects; it is pure data definitions plus a couple of
field validators.
"""

from __future__ import annotations

import calendar
import re
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

# ---------------------------------------------------------------------------
# Shared field-validation hooks (reused by more than one contract)
# ---------------------------------------------------------------------------
# These small helpers back the ``@field_validator`` hooks below. Defining the
# rule once here — rather than inline in each model — means UserProfile and
# LeadEnquiry enforce the *same* phone format and blank-check, so the two places
# that capture the same B2B agent can never drift apart.
_PHONE_RE = re.compile(r"\+\d{8,15}")


def _clean_phone(v: str) -> str:
    """Normalise an international phone number: strip spaces and dashes, then
    require a leading '+' followed by 8–15 digits. Raises ``ValueError`` (which
    Pydantic surfaces as a validation error) on anything else. So '+971 4 458
    0111' is accepted and stored as '+97144580111'."""
    cleaned = re.sub(r"[\s-]", "", v)
    if not _PHONE_RE.fullmatch(cleaned):
        raise ValueError("phone must be '+' followed by 8–15 digits")
    return cleaned


def _non_blank(v: str) -> str:
    """Trim surrounding whitespace and reject an empty/whitespace-only string.
    Used for text fields where a blank value is meaningless (agency, name,
    summary) — a ``min_length`` alone would let a single space through."""
    trimmed = v.strip()
    if not trimmed:
        raise ValueError("must not be blank")
    return trimmed


# The English month names, lowercased, for the lead's free-text month hook. Sourced
# from the stdlib ``calendar`` so this module stays pure — no import of the resolvers.
_MONTH_NAMES = {name.lower() for name in calendar.month_name if name}
_YYYYMM_RE = re.compile(r"\d{4}-\d{2}")


def _valid_month(v: str) -> str:
    """Normalise a lead's free-text month: accept a month NAME ('december' ->
    'December') or a ``'YYYY-MM'`` string, and reject anything else. A lead's month
    is context for the sales desk, so a plain name is fine — ``build_lead_draft``
    (via ``detect_month``) produces names, while other callers pass 'YYYY-MM'.
    Both are kept; a garbage value (e.g. 'sometime') is rejected here rather than
    reaching the desk. (Distinct from SailingFilters.month, which is 'YYYY-MM' only
    because it drives an exact SQL filter.)"""
    s = v.strip()
    if _YYYYMM_RE.fullmatch(s):
        return s
    if s.lower() in _MONTH_NAMES:
        return s.title()                       # 'december' -> 'December'
    raise ValueError("month must be a month name (e.g. 'December') or 'YYYY-MM'")


# ---------------------------------------------------------------------------
# Registration — the B2B user captured at the entry gate
# ---------------------------------------------------------------------------
class UserProfile(BaseModel):
    """Collected by the Streamlit registration form before chat unlocks.
    Length bounds and the phone format are enforced here so the UI can rely on
    a single source of validation."""

    agency: str = Field(min_length=2, max_length=120)
    full_name: str = Field(min_length=2, max_length=80)
    email: EmailStr                       # RFC-valid, checked by email-validator
    phone: str

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        """Accept an international number via the shared phone hook (a leading
        '+' then 8–15 digits, spaces/dashes stripped)."""
        return _clean_phone(v)


# ---------------------------------------------------------------------------
# Intent — output of the cheap scope gate (small model)
# ---------------------------------------------------------------------------
class IntentResult(BaseModel):
    """How each incoming turn is classified before any expensive work. The
    orchestrator branches on ``intent`` (e.g. price_intent -> lead flow,
    out_of_scope -> polite decline, injection_suspect -> refuse)."""

    intent: Literal[
        "in_scope",          # a genuine cruise question we can answer
        "greeting",          # hello / thanks / small talk
        "price_intent",      # asking fares/quotes/booking -> capture a lead
        "out_of_scope",      # visas, flights, unrelated topics
        "injection_suspect", # attempts to override instructions
    ]
    confidence: float = Field(ge=0.0, le=1.0)


# ---------------------------------------------------------------------------
# Sailings search — filters in, rows out (deterministic SQL tool)
# ---------------------------------------------------------------------------
class SailingFilters(BaseModel):
    """The structured filters the model extracts from a natural-language query.
    Every field is optional — the search tool applies only those provided.
    ``month`` is a 'YYYY-MM' string; ``dest`` is a canonical destination bucket
    while ``dest_label`` matches the line's own sub-region wording."""

    dest: str | None = None
    # A SET of canonical destinations for an umbrella-region query ("Europe" -> the 5 European
    # buckets, TE.2). When present, search matches ANY of them (dest IN (...)); a single-destination
    # query still uses `dest`. Kept separate so both paths stay explicit.
    dests: list[str] | None = None
    dest_label: str | None = None
    port: str | None = None
    line: str | None = None                       # a cruise-line slug
    month: str | None = None                      # "YYYY-MM"
    nights_min: int | None = Field(default=None, ge=1)
    nights_max: int | None = Field(default=None, ge=1)
    ship: str | None = None
    name: str | None = None                       # itinerary name substring, e.g. "Idyllic Rhône"
    date_from: str | None = None                  # "YYYY-MM-DD" inclusive lower bound (TB.5)
    date_to: str | None = None                    # "YYYY-MM-DD" inclusive upper bound (TB.5)


class SailingRow(BaseModel):
    """One row in a search result, shaped for display. ``coverage`` is a
    human-readable date signal — an actual month range, a season hint, or
    'departure dates on request' for undated catalogue lines."""

    line: str
    ship: str
    name: str
    dest_label: str
    nights: str
    port: str                                      # embarkation / departure port
    coverage: str
    count: int = Field(ge=0)                       # how many departures aggregate here
    # Itinerary detail (TA.5), surfaced from the sailings table:
    ports: list[str] = []                          # ordered ports of call (empty if none published)
    port_disembark: str | None = None              # arrival port (None if the line publishes none)
    sail_date: str | None = None                   # exact departure date for a dated line, else None (TB.4)


class SearchSailingsOutput(BaseModel):
    """The tool's full reply. ``status`` is the discriminator the orchestrator
    branches on — never string-matching an error message."""

    status: Literal["ok", "no_results", "invalid_filters"]
    rows: list[SailingRow] = []
    note: str | None = None                        # e.g. "+7 more in the full list"
    total_matches: int = Field(default=0, ge=0)


# ---------------------------------------------------------------------------
# Itinerary detail — deep routing for one line/sailing (TA.7)
# ---------------------------------------------------------------------------
class FeaturedItinerary(BaseModel):
    """One curated, official-source example itinerary (exported from cruise-lines.json,
    TA.3). ``ports`` is the ordered port run — may be empty for region-level entries."""

    region: str
    name: str
    ship: str
    nights: str
    departs: str
    ports: list[str] = []


class ItineraryDay(BaseModel):
    """One day of a numbered day-by-day schedule (TC.1).

    ``day`` is the 1-based day number; ``port`` is where the ship is that day (a real
    port of call, or a label like "At sea" for a day with no call). ``is_sea_day`` flags
    those sea days explicitly so a renderer never has to guess from the port text.
    ``date`` is the calendar date when the source publishes dated days (e.g. Crystal),
    and ``None`` for an undated template schedule (e.g. Elixir) — we never fabricate a
    date the source didn't give."""

    day: int = Field(ge=1)
    date: str | None = None                         # "YYYY-MM-DD" when the source dates each day
    port: str                                       # port of call, or "At sea" on a sea day
    is_sea_day: bool = False


class ItineraryResult(BaseModel):
    """Deep itinerary detail for one line, combining the grounded sources (TA.7 / TC.1): the
    routes of matching sailings from the catalogue, the curated featured itineraries, and — when
    published — the numbered day-by-day schedule. ``note`` carries a human hint when nothing
    routable is found — the agent should then offer to confirm with the desk rather than invent
    stops. ``itinerary_days`` is empty unless a matching sailing publishes a real day list; the
    renderer shows "on request" in that case rather than fabricating days."""

    line: str
    sailings: list[SailingRow] = []                 # matching catalogue sailings (with routes)
    featured: list[FeaturedItinerary] = []          # curated example itineraries
    featured_as_of: str | None = None               # capture-date note for the featured set
    itinerary_days: list[ItineraryDay] = []         # numbered day-by-day schedule, empty if none published (TC.1)
    note: str | None = None


# ---------------------------------------------------------------------------
# Knowledge retrieval — one RAG hit from the vector store
# ---------------------------------------------------------------------------
class KnowledgeHit(BaseModel):
    """A single retrieved chunk. ``text`` is raw content — it gets wrapped as
    fenced <data> at prompt-assembly time, never trusted as an instruction."""

    line: str                                      # line slug, or "general"
    doc_type: str                                  # "brief" | "content"
    text: str
    source: str                                    # where it came from (file/section)


# ---------------------------------------------------------------------------
# Lead capture — the one write path (email/quote requests)
# ---------------------------------------------------------------------------
class LeadEnquiry(BaseModel):
    """Assembled when a user wants fares/booking. Stored in SQLite and emailed
    to the sales desk. Contact fields come from the registered profile; the
    sailing references are best-effort from the conversation (hence optional)."""

    # Contact fields mirror UserProfile's bounds — the lead captures the same
    # B2B agent, so the two contracts enforce the same shape (see the shared
    # hooks above). user_email is EmailStr, so an empty/invalid address is
    # rejected at construction.
    user_email: EmailStr
    agency: str = Field(min_length=2, max_length=120)
    full_name: str = Field(min_length=2, max_length=80)
    phone: str
    summary: str = Field(min_length=1)             # the enquiry in one short paragraph
    line_slug: str | None = None
    itinerary_name: str | None = None
    month: str | None = None
    party_size: int | None = Field(default=None, ge=1)   # ge=1 rejects 0 / -1
    transcript_excerpt: str = ""                   # last few turns for context

    # --- Validation hooks -------------------------------------------------
    # These enforce the contract at construction, so a LeadEnquiry that reaches
    # the write path is already well-formed. The tool (engine/tools/leads.py)
    # keeps an equivalent re-check as defence-in-depth for a model built via
    # ``model_construct`` (which bypasses validation), plus the data-dependent
    # ``line_slug`` ∈ known-slugs check that can't live in this pure module.

    @field_validator("agency", "full_name", "summary")
    @classmethod
    def _text_non_blank(cls, v: str) -> str:
        """Reject a blank/whitespace-only agency, name, or summary — the desk
        can't act on an enquiry that omits who it's from or what it wants."""
        return _non_blank(v)

    @field_validator("phone")
    @classmethod
    def _check_phone(cls, v: str) -> str:
        """Enforce the same international phone format as UserProfile."""
        return _clean_phone(v)

    @field_validator("month")
    @classmethod
    def _check_month(cls, v: str | None) -> str | None:
        """Normalise the free-text month, or leave it unset. Rejects a value that's
        neither a month name nor 'YYYY-MM', so a mis-detected timeframe can't reach
        the desk as noise (T5.2 populates this from the conversation)."""
        return _valid_month(v) if v is not None else v


# ---------------------------------------------------------------------------
# Tool errors — the structured failure shape any tool may return
# ---------------------------------------------------------------------------
class ToolError(BaseModel):
    """Machine-readable error, returned instead of raising, so the orchestrator
    can branch cleanly. ``detail`` is a short reason, never a stack trace."""

    status: str = "error"
    detail: str
