"""engine — the Byond Borders Cruise Concierge backend.

This package holds everything that is NOT the Streamlit UI: configuration and
model routing, the Pydantic contracts, the SQLite/Chroma storage layer, the
tools the agent may call, the guards, and the orchestrator.

Kept deliberately import-light at the top level so that ``import engine``
works before any third-party dependency is installed (used as the smoke test
for the project scaffold). Submodules pull in their own dependencies as needed.
"""

# Single source of truth for the package version.
__version__ = "0.1.0"
