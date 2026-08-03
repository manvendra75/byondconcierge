"""engine.ingest.load_knowledge — build the Chroma knowledge collection.

This is the RAG store, and the ONLY place we use a vector database — following
the guide's rule that vectors are for *prose you search by meaning*, not for
structured data (sailings live in SQL). Two kinds of prose go in:

* **briefs**  — the 13 research briefs + gcc-cruise-facts.md (Markdown), chunked
  by ``## `` heading.
* **content** — the marketing prose from cruise-lines.json (intro, description,
  highlights, FAQs, at-a-glance), one chunk per field per line.

Every chunk carries metadata ``{line, doc_type, section}`` so the search tool can
filter (e.g. only ``line=celebrity``). Chunk IDs are deterministic, so re-running
replaces rather than duplicates.

Embeddings: OpenAI if an API key is set (better quality), otherwise Chroma's
built-in local model (all-MiniLM, no key needed). The same choice must be used at
query time — import ``get_embedding_function`` from here so both agree.

Run it directly:

    python -m engine.ingest.load_knowledge
"""

from __future__ import annotations

import json
import re

import chromadb
from chromadb.utils import embedding_functions

from engine.config import PROJECT_ROOT, settings

# Where the source prose lives (committed into this repo for self-containment).
KNOWLEDGE_DIR = PROJECT_ROOT / "data" / "knowledge"          # the 14 Markdown briefs
CRUISE_LINES_JSON = PROJECT_ROOT / "data" / "cruise-lines.json"  # the exported content

COLLECTION_NAME = "knowledge"

# Brief headings that are notes/metadata, not sellable knowledge — skipped so they
# don't pollute retrieval (e.g. a list of hero-image URLs).
_SKIP_SECTIONS = {"hero image urls"}

# The cruise-lines.json fields we turn into "content" chunks, in a sensible order.
_CONTENT_FIELDS = ("intro", "description", "highlights", "faqs", "atAGlance")


# ---------------------------------------------------------------------------
# Embedding function — one choice, shared by ingest and query
# ---------------------------------------------------------------------------
def get_embedding_function():
    """Return the embedding function used to BOTH build and query the store (they
    must match, or vectors won't compare). Defaults to Chroma's local model — no
    key, works offline — and only uses OpenAI embeddings when explicitly opted in
    via EMBEDDINGS_PROVIDER=openai. This decoupling means simply having an OpenAI
    key (for the chat models) does NOT silently change the embedding space and
    break an existing local-built collection."""
    if settings.embeddings_provider == "openai" and settings.openai_api_key:
        return embedding_functions.OpenAIEmbeddingFunction(
            api_key=settings.openai_api_key,
            model_name="text-embedding-3-small",
        )
    return embedding_functions.DefaultEmbeddingFunction()


# ---------------------------------------------------------------------------
# Helpers — turn source text into (id, document, metadata) chunk tuples
# ---------------------------------------------------------------------------
def _slugify(text: str) -> str:
    """Compress a heading into an id-safe token: lowercase, non-alphanumerics
    collapsed to single hyphens."""
    return re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-") or "section"


def _split_brief(text: str) -> list[tuple[str, str]]:
    """Split a Markdown brief into (section_heading, section_text) pairs, one per
    ``## `` heading. Any text before the first ``## `` (the ``# Title`` and intro)
    becomes an 'Overview' section. Each section_text keeps its heading line so the
    chunk is self-describing when retrieved."""
    sections: list[tuple[str, str]] = []
    heading = "Overview"          # name for the preamble before the first "## "
    buffer: list[str] = []

    def flush():
        body = "\n".join(buffer).strip()
        if body:
            sections.append((heading, body))

    for line in text.splitlines():
        if line.startswith("## "):
            flush()                       # close the previous section
            heading = line[3:].strip()    # start a new one
            buffer = [line]
        else:
            buffer.append(line)
    flush()                               # close the final section
    return sections


def _brief_chunks() -> list[tuple[str, str, dict]]:
    """Build chunks from every Markdown file in data/knowledge/. The file stem is
    the line slug (gcc-cruise-facts -> the shared 'general' bucket)."""
    chunks: list[tuple[str, str, dict]] = []
    for path in sorted(KNOWLEDGE_DIR.glob("*.md")):
        slug = "general" if path.stem == "gcc-cruise-facts" else path.stem
        for heading, body in _split_brief(path.read_text(encoding="utf-8")):
            if heading.lower() in _SKIP_SECTIONS:
                continue
            chunk_id = f"brief:{slug}:{_slugify(heading)}"
            meta = {"line": slug, "doc_type": "brief", "section": heading}
            chunks.append((chunk_id, body, meta))
    return chunks


def _content_chunks() -> list[tuple[str, str, dict]]:
    """Build chunks from the exported cruise-lines.json prose — one chunk per
    field (intro/description/highlights/faqs/atAGlance) per line. Each chunk is
    prefixed with the line name + field so it reads clearly on its own."""
    lines = json.loads(CRUISE_LINES_JSON.read_text(encoding="utf-8"))
    chunks: list[tuple[str, str, dict]] = []
    for line in lines:
        slug, name = line["slug"], line["name"]
        for field in _CONTENT_FIELDS:
            body = _render_field(line.get(field))
            if not body:
                continue
            chunk_id = f"content:{slug}:{field}"
            document = f"{name} — {field}\n\n{body}"
            meta = {"line": slug, "doc_type": "content", "section": field}
            chunks.append((chunk_id, document, meta))
    return chunks


def _render_field(value) -> str:
    """Flatten one cruise-lines.json field into readable plain text. Handles the
    shapes present: a string, a list of strings, a list of {q,a} FAQ objects, or
    the atAGlance dict."""
    if value is None:
        return ""
    if isinstance(value, str):
        return value.strip()
    if isinstance(value, dict):                       # atAGlance -> "Key: value" lines
        return "\n".join(f"{k}: {v}" for k, v in value.items())
    if isinstance(value, list):
        if value and isinstance(value[0], dict):      # FAQs -> "Q / A" blocks
            return "\n\n".join(f"Q: {i['q']}\nA: {i['a']}" for i in value)
        return "\n".join(f"- {item}" for item in value)   # bullet list
    return str(value)


# ---------------------------------------------------------------------------
# The load — rebuild the collection from scratch (idempotent)
# ---------------------------------------------------------------------------
def load_knowledge() -> dict:
    """(Re)build the Chroma 'knowledge' collection from all source prose. Drops
    any existing collection first so the result is a clean mirror of the current
    files — no stale chunks if a heading was removed. Returns a small summary."""
    client = chromadb.PersistentClient(path=str(settings.chroma_dir))

    # Fresh start: delete then recreate. (delete_collection raises if absent, so
    # guard it.) Deterministic IDs still make individual chunks stable across runs.
    try:
        client.delete_collection(COLLECTION_NAME)
    except Exception:
        pass
    collection = client.create_collection(
        name=COLLECTION_NAME,
        embedding_function=get_embedding_function(),
        metadata={"hnsw:space": "cosine"},   # cosine similarity suits text embeddings
    )

    chunks = _brief_chunks() + _content_chunks()
    ids = [c[0] for c in chunks]
    documents = [c[1] for c in chunks]
    metadatas = [c[2] for c in chunks]

    # add() embeds every document via the collection's embedding function and
    # persists to disk (PersistentClient). One call handles the whole batch.
    collection.add(ids=ids, documents=documents, metadatas=metadatas)

    briefs = sum(1 for c in chunks if c[2]["doc_type"] == "brief")
    content = len(chunks) - briefs
    return {"total": len(chunks), "briefs": briefs, "content": content}


# ---------------------------------------------------------------------------
# CLI entry point
# ---------------------------------------------------------------------------
def main() -> None:
    ef = "OpenAI" if settings.openai_api_key else "Chroma default (local)"
    summary = load_knowledge()
    print(f"Embedded {summary['total']} chunks into '{COLLECTION_NAME}' "
          f"({summary['briefs']} brief + {summary['content']} content) using {ef}")


if __name__ == "__main__":
    main()
