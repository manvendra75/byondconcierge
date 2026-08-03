"""Acceptance tests for the search_knowledge tool (T2.4).

Spec "Done when": query "what's included on Celebrity" (line=celebrity) returns
the "What's included" chunk in the top-k. Plus filter scoping, k limit, and the
empty-query guard.

Builds the knowledge collection in a throwaway Chroma dir (local embeddings, no
OpenAI key needed).

Run with: ``pytest evals/test_knowledge.py``.
"""

import pytest

import engine.config as config
from engine.ingest.load_knowledge import load_knowledge
from engine.schemas import KnowledgeHit
from engine.tools.knowledge import search_knowledge


# ---------------------------------------------------------------------------
# Build the collection once for the module in a temp dir
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module", autouse=True)
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("chroma")
    object.__setattr__(config.settings, "chroma_dir", tmp)
    load_knowledge()
    return tmp


# ---------------------------------------------------------------------------
# The headline case: "what's included on Celebrity", scoped to celebrity
# ---------------------------------------------------------------------------
def test_whats_included_celebrity_in_top_k():
    hits = search_knowledge("what's included on Celebrity", line_slug="celebrity", k=4)
    assert hits and all(isinstance(h, KnowledgeHit) for h in hits)
    assert all(h.line == "celebrity" for h in hits)          # filter honoured
    # the "What's included" chunk should be among the top hits
    assert any("included" in h.source.lower() or "included" in h.text.lower() for h in hits)


# ---------------------------------------------------------------------------
# k is respected and hits carry provenance
# ---------------------------------------------------------------------------
def test_k_limit_and_source():
    hits = search_knowledge("loyalty programme tiers", line_slug="celebrity", k=2)
    assert len(hits) <= 2
    for h in hits:
        assert h.doc_type in ("brief", "content")
        assert h.source                                      # non-empty citation


# ---------------------------------------------------------------------------
# No slug searches the whole store (can surface general GCC facts)
# ---------------------------------------------------------------------------
def test_unscoped_search_returns_hits():
    hits = search_knowledge("cruising from the Arabian Gulf", k=5)
    assert hits and len(hits) <= 5


# ---------------------------------------------------------------------------
# Empty query short-circuits to no hits (no wasted embedding call)
# ---------------------------------------------------------------------------
def test_empty_query_returns_empty():
    assert search_knowledge("   ", line_slug="celebrity") == []
    assert search_knowledge("") == []
