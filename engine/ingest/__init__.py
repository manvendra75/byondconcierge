"""engine.ingest — the offline data pipeline.

Loads the website's own verified data into the concierge's stores: the
sailings index into SQLite (for deterministic search) and the research briefs
plus line prose into ChromaDB (for retrieval). Re-runnable whenever the
website content changes.

Modules are added by later tasks (T1.x); this file just marks the directory as
a Python package.
"""
