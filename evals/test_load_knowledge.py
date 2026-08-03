"""Acceptance tests for the knowledge loader (T1.3).

The spec's "Done when": the collection has >100 chunks, and querying
"Captain's Club loyalty" filtered to line=celebrity returns the loyalty chunk.

These tests build the collection in a temp Chroma dir (never the real one) and
use the local default embeddings (no OpenAI key needed to run them).

Run with: ``pytest evals/test_load_knowledge.py``.
"""

import chromadb
import pytest

import engine.config as config
from engine.ingest.load_knowledge import (
    COLLECTION_NAME,
    get_embedding_function,
    load_knowledge,
)


# ---------------------------------------------------------------------------
# Build the collection once for the module, in a throwaway Chroma directory
# ---------------------------------------------------------------------------
@pytest.fixture(scope="module")
def built(tmp_path_factory):
    tmp = tmp_path_factory.mktemp("chroma")
    object.__setattr__(config.settings, "chroma_dir", tmp)
    summary = load_knowledge()
    return summary, tmp


def _collection(chroma_dir):
    client = chromadb.PersistentClient(path=str(chroma_dir))
    return client.get_collection(COLLECTION_NAME, embedding_function=get_embedding_function())


# ---------------------------------------------------------------------------
# >100 chunks, split across both doc types
# ---------------------------------------------------------------------------
def test_collection_has_over_100_chunks(built):
    summary, chroma_dir = built
    assert summary["total"] > 100
    assert summary["briefs"] > 0 and summary["content"] > 0
    # the persisted collection agrees with the reported count
    assert _collection(chroma_dir).count() == summary["total"]


# ---------------------------------------------------------------------------
# The key retrieval: Captain's Club loyalty, filtered to celebrity
# ---------------------------------------------------------------------------
def test_loyalty_query_returns_celebrity_chunk(built):
    _, chroma_dir = built
    res = _collection(chroma_dir).query(
        query_texts=["Captain's Club loyalty"],
        n_results=1,
        where={"line": "celebrity"},           # metadata filter
    )
    top_doc = res["documents"][0][0]
    top_meta = res["metadatas"][0][0]
    assert top_meta["line"] == "celebrity"      # filter honoured
    assert "Captain's Club" in top_doc          # it's the loyalty content


# ---------------------------------------------------------------------------
# Idempotent rebuild: running twice yields the same count (no duplicates)
# ---------------------------------------------------------------------------
def test_rebuild_is_idempotent(built):
    _, chroma_dir = built
    first = _collection(chroma_dir).count()
    load_knowledge()                            # rebuild in the same dir
    assert _collection(chroma_dir).count() == first
