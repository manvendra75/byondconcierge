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

import re
from typing import Literal

from pydantic import BaseModel, EmailStr, Field, field_validator

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
        """Accept an international number: a leading '+' then 8–15 digits.
        Spaces and dashes are stripped first so '+971 4 458 0111' is fine."""
        cleaned = re.sub(r"[\s-]", "", v)
        if not re.fullmatch(r"\+\d{8,15}", cleaned):
            raise ValueError("phone must be '+' followed by 8–15 digits")
        return cleaned


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
    dest_label: str | None = None
    port: str | None = None
    line: str | None = None                       # a cruise-line slug
    month: str | None = None                      # "YYYY-MM"
    nights_min: int | None = Field(default=None, ge=1)
    nights_max: int | None = Field(default=None, ge=1)
    ship: str | None = None


class SailingRow(BaseModel):
    """One row in a search result, shaped for display. ``coverage`` is a
    human-readable date signal — an actual month range, a season hint, or
    'departure dates on request' for undated catalogue lines."""

    line: str
    ship: str
    name: str
    dest_label: str
    nights: str
    port: str
    coverage: str
    count: int = Field(ge=0)                       # how many departures aggregate here


class SearchSailingsOutput(BaseModel):
    """The tool's full reply. ``status`` is the discriminator the orchestrator
    branches on — never string-matching an error message."""

    status: Literal["ok", "no_results", "invalid_filters"]
    rows: list[SailingRow] = []
    note: str | None = None                        # e.g. "+7 more in the full list"
    total_matches: int = Field(default=0, ge=0)


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

    user_email: EmailStr
    agency: str
    full_name: str
    phone: str
    summary: str = Field(min_length=1)             # the enquiry in one short paragraph
    line_slug: str | None = None
    itinerary_name: str | None = None
    month: str | None = None
    party_size: int | None = Field(default=None, ge=1)   # ge=1 rejects 0 / -1
    transcript_excerpt: str = ""                   # last few turns for context


# ---------------------------------------------------------------------------
# Tool errors — the structured failure shape any tool may return
# ---------------------------------------------------------------------------
class ToolError(BaseModel):
    """Machine-readable error, returned instead of raising, so the orchestrator
    can branch cleanly. ``detail`` is a short reason, never a stack trace."""

    status: str = "error"
    detail: str
