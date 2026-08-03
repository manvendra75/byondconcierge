"""engine.tools.knowledge — semantic search over the RAG knowledge store.

The one place we query the vector store: given a natural-language question, find
the most relevant prose chunks (line briefs + marketing content) and return them
as typed ``KnowledgeHit``s. No LLM here — just embedding-based retrieval.

Safety note (the guide's injection boundary): the returned ``text`` is the raw
retrieved content. It is NOT trusted as instructions — it gets wrapped in a
labeled ``<data>`` block by ``fence_data`` at prompt-assembly time (T3.1). This
tool just hands back the raw text + provenance; fencing happens downstream.
"""

from __future__ import annotations

from functools import lru_cache

import chromadb

from engine.config import settings
from engine.ingest.load_knowledge import COLLECTION_NAME, get_embedding_function
from engine.schemas import KnowledgeHit


# ---------------------------------------------------------------------------
# Collection handle — opened once per chroma path (cached)
# ---------------------------------------------------------------------------
# Keyed on the path string so tests that point settings.chroma_dir at a temp
# directory get their own handle, while production reuses one. The embedding
# function must match the one used to BUILD the collection, so we reuse the
# shared get_embedding_function().
@lru_cache(maxsize=4)
def _collection_for(path: str):
    client = chromadb.PersistentClient(path=path)
    return client.get_collection(COLLECTION_NAME, embedding_function=get_embedding_function())


def _collection():
    """The knowledge collection at the currently-configured chroma directory."""
    return _collection_for(str(settings.chroma_dir))


# ---------------------------------------------------------------------------
# Provenance string — where a chunk came from
# ---------------------------------------------------------------------------
def _source(meta: dict) -> str:
    """Build a human-readable source label from a chunk's metadata. Briefs cite
    the Markdown file + heading; content cites the JSON field. This is what an
    answer can show as its citation."""
    line, section = meta.get("line", "?"), meta.get("section", "")
    if meta.get("doc_type") == "brief":
        return f"{line}.md#{section}"                 # e.g. celebrity.md#What's included
    return f"cruise-lines.json:{line}/{section}"      # e.g. cruise-lines.json:celebrity/faqs


# ---------------------------------------------------------------------------
# The tool
# ---------------------------------------------------------------------------
def search_knowledge(query: str, line_slug: str | None = None, k: int = 4) -> list[KnowledgeHit]:
    """Retrieve the top-``k`` knowledge chunks most relevant to ``query``.

    When ``line_slug`` is given, results are restricted to that line's chunks via
    a metadata filter (so "what's included on Celebrity" only returns Celebrity
    content). With no slug, the whole store is searched — useful for the shared
    'general' GCC facts.

    Returns a list of ``KnowledgeHit`` (line, doc_type, raw text, source),
    ordered most-relevant first. Empty query or no matches -> empty list.
    """
    if not query or not query.strip():
        return []

    # Metadata filter: only when a line is specified.
    where = {"line": line_slug} if line_slug else None

    res = _collection().query(query_texts=[query], n_results=k, where=where)

    # Chroma returns parallel lists nested one level per query; we sent one query,
    # so index [0]. Zip documents with their metadata into typed hits.
    documents = res["documents"][0]
    metadatas = res["metadatas"][0]
    return [
        KnowledgeHit(
            line=meta["line"],
            doc_type=meta["doc_type"],
            text=doc,                    # raw text — fenced later, never trusted as instruction
            source=_source(meta),
        )
        for doc, meta in zip(documents, metadatas)
    ]
