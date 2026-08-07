"""engine.config — one place for configuration and every model decision.

Loads settings from the local ``.env`` file, then defines two lookup tables
that the rest of the codebase depends on:

* ``MODEL_ROUTES`` — which model + limits each workflow step uses.
* ``PRICE_PER_1K`` — token prices, used only to compute cost figures in traces.

The rule this module exists to enforce: **no model name, temperature, or price
is written literally anywhere else.** Change them here and the whole system
follows.
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from enum import Enum
from pathlib import Path

from dotenv import load_dotenv

# ---------------------------------------------------------------------------
# Load the .env file
# ---------------------------------------------------------------------------
# The project root is the folder containing "engine/" (one level up from this
# file). We load the .env sitting there. If there is no .env yet — only the
# committed .env.example — load_dotenv is a harmless no-op and the defaults
# below take over.
PROJECT_ROOT = Path(__file__).resolve().parent.parent
load_dotenv(PROJECT_ROOT / ".env")


def _resolve(path_str: str) -> Path:
    """Turn a possibly-relative path from .env into an absolute path anchored
    at the project root, so the app finds its data regardless of the directory
    it is launched from."""
    p = Path(path_str)
    return p if p.is_absolute() else PROJECT_ROOT / p


# ---------------------------------------------------------------------------
# Settings — the typed view of the environment
# ---------------------------------------------------------------------------
@dataclass(frozen=True)
class Settings:
    """All runtime configuration, read once from the environment at import."""

    # --- LLM provider ---
    openai_api_key: str
    model_small: str            # cheap/fast model: intent gate + extraction
    model_large: str            # stronger model: synthesis + comparison

    # Which embedding backend the RAG store uses. Default "local" (a bundled
    # model, no key, works offline). This is deliberately DECOUPLED from the
    # OpenAI key: setting the key enables the chat models but keeps embeddings
    # local, so an existing local-built Chroma store keeps matching at query time.
    # Set EMBEDDINGS_PROVIDER=openai to use OpenAI embeddings (then rebuild ingest).
    embeddings_provider: str

    # --- Lead notifications ---
    resend_api_key: str         # blank => dev mode (log the email instead of sending)
    sales_email: str

    # --- Sidebar ad banner (advertising space sold to cruise companies, T4.3) ---
    # The concierge's left panel carries a banner slot we monetise. It is DATA, not code: both fields
    # are read from env, so an ad can be sold, swapped, or pulled by editing env vars + redeploying —
    # the app itself never changes. When both are blank the sidebar shows a neutral "advertising space"
    # placeholder (which also advertises the slot itself), so there is always something to render.
    banner_image_url: str       # https URL of the ad creative; blank/non-http => the placeholder shows
    banner_link_url: str        # advertiser landing URL the banner links to; blank => image not clickable

    # --- Local storage (absolute paths) ---
    db_path: Path
    chroma_dir: Path

    @property
    def email_enabled(self) -> bool:
        """True when a Resend key is configured, so leads are actually emailed
        rather than only logged to the console."""
        return bool(self.resend_api_key)


# The single Settings instance the rest of the app imports.
settings = Settings(
    openai_api_key=os.getenv("OPENAI_API_KEY", ""),
    model_small=os.getenv("OPENAI_MODEL_SMALL", "gpt-4o-mini"),
    model_large=os.getenv("OPENAI_MODEL_LARGE", "gpt-4o"),
    embeddings_provider=os.getenv("EMBEDDINGS_PROVIDER", "local"),
    resend_api_key=os.getenv("RESEND_API_KEY", ""),
    sales_email=os.getenv("SALES_EMAIL", "sales@byondborders.com"),
    # Sidebar ad slot — both default to "" (placeholder shown); set to run a live ad (T4.3).
    banner_image_url=os.getenv("BANNER_IMAGE_URL", ""),
    banner_link_url=os.getenv("BANNER_LINK_URL", ""),
    db_path=_resolve(os.getenv("DB_PATH", "data/app.db")),
    chroma_dir=_resolve(os.getenv("CHROMA_DIR", "data/chroma")),
)


# ---------------------------------------------------------------------------
# Steps — every point in a turn where the system calls a model
# ---------------------------------------------------------------------------
class Step(str, Enum):
    """The named model-using steps. Each maps to a routing entry below, so
    adding a step forces a deliberate model + limits choice for it."""

    SCOPE_GATE = "scope_gate"            # classify the user's intent (cheap gate)
    EXTRACT_FILTERS = "extract_filters"  # pull structured sailing filters from text
    SYNTHESIZE = "synthesize"            # write the grounded answer
    COMPARE = "compare"                  # build a line-vs-line comparison
    SUMMARIZE = "summarize"              # condense a long thread for context


# ---------------------------------------------------------------------------
# Model routing — the single source of truth for model decisions
# ---------------------------------------------------------------------------
# Cheap steps (classification, extraction, summarizing) use the SMALL model at
# temperature 0 for determinism; the reasoning/writing steps use the LARGE
# model with a little warmth. ``max_tokens`` caps output for both cost and
# latency. Note that "model" is taken from ``settings`` — swapping models in
# .env re-routes every step at once, and no model name appears literally here.
MODEL_ROUTES: dict[Step, dict] = {
    Step.SCOPE_GATE:      {"model": settings.model_small, "max_tokens": 50,   "temperature": 0.0},
    Step.EXTRACT_FILTERS: {"model": settings.model_small, "max_tokens": 500,  "temperature": 0.0},
    Step.SYNTHESIZE:      {"model": settings.model_large, "max_tokens": 1200, "temperature": 0.3},
    Step.COMPARE:         {"model": settings.model_large, "max_tokens": 1000, "temperature": 0.2},
    Step.SUMMARIZE:       {"model": settings.model_small, "max_tokens": 300,  "temperature": 0.0},
}


# ---------------------------------------------------------------------------
# Token pricing — used to compute cost per step/turn (see engine/trace.py)
# ---------------------------------------------------------------------------
# Indicative OpenAI prices in USD per 1,000 tokens, split into input ("in")
# and output ("out"), keyed by model name. These affect ONLY the cost numbers
# recorded in traces, never behaviour — update them if OpenAI changes pricing
# or you switch models. A model missing from this map simply costs $0 in the
# accounting (handled where the lookup happens, in T0.5).
PRICE_PER_1K: dict[str, dict[str, float]] = {
    "gpt-4o-mini": {"in": 0.00015, "out": 0.00060},
    "gpt-4o":      {"in": 0.00250, "out": 0.01000},
}
