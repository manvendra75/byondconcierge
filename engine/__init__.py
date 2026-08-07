"""engine — the Byond Borders Cruise Concierge backend.

This package holds everything that is NOT the Streamlit UI: configuration and
model routing, the Pydantic contracts, the SQLite/Chroma storage layer, the
tools the agent may call, the guards, and the orchestrator.

Kept deliberately import-light at the top level so that ``import engine``
works before any third-party dependency is installed (used as the smoke test
for the project scaffold). Submodules pull in their own dependencies as needed.
"""

import os

# Silence a spurious Pydantic-plugin warning. ``logfire`` (a transitive dependency of pydantic-ai that
# we don't use) registers a Pydantic plugin which fails to import against our opentelemetry-sdk version,
# printing an ImportError UserWarning the first time any model is validated. We use no Pydantic plugins,
# so disable them here — this runs before any submodule builds a model, so every entrypoint that imports
# ``engine`` (the app and the ``python -m engine.*`` CLIs) gets clean output. ``setdefault`` respects an
# explicit override. (Production also sets this via the Dockerfile ENV, as a belt-and-suspenders.)
os.environ.setdefault("PYDANTIC_DISABLE_PLUGINS", "1")

# Single source of truth for the package version.
__version__ = "0.1.0"
