"""engine.db — the SQLite application store and its typed helpers.

This is the transactional backbone: every durable thing the app produces —
registered users, chat sessions, individual messages, captured leads, model/tool
traces, and the searchable sailings table — lives in one on-disk SQLite file
(``settings.db_path``, default ``data/app.db``).

The module exposes two kinds of function:

* ``init_db()`` — creates every table and index if they do not already exist.
  It is *idempotent*: safe to call on every app start, does nothing on a DB that
  is already set up.
* thin typed helpers (``upsert_user``, ``create_session``, ``add_message``,
  ``insert_lead``, ``insert_trace``) — the only sanctioned way the rest of the
  code writes rows, so SQL never leaks into the agent/UI layers.

We use the standard-library ``sqlite3`` (no ORM) to keep the pilot dependency-light
and the schema obvious. Following the guide's "storage by access pattern" rule,
structured/relational data lives here; only prose knowledge goes to the vector
store.
"""

from __future__ import annotations

import sqlite3
from datetime import datetime, timezone

from engine.config import settings
from engine.schemas import LeadEnquiry, UserProfile

# ---------------------------------------------------------------------------
# Connection helper
# ---------------------------------------------------------------------------
# Every helper opens a short-lived connection through this function. Centralising
# it means the DB path, row factory, and foreign-key pragma are configured in one
# place. ``row_factory = sqlite3.Row`` lets callers read columns by name.
def _connect() -> sqlite3.Connection:
    """Open a connection to the app database, creating the parent folder if
    needed so a fresh clone works before anyone has made ``data/``."""
    settings.db_path.parent.mkdir(parents=True, exist_ok=True)
    conn = sqlite3.connect(settings.db_path)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA foreign_keys = ON")   # enforce the FK relationships below
    return conn


def _now() -> str:
    """A UTC ISO-8601 timestamp string — the single time format stored in every
    ``created_at`` / ``started_at`` column."""
    return datetime.now(timezone.utc).isoformat()


# ---------------------------------------------------------------------------
# Schema — one CREATE statement per table, all IF NOT EXISTS (idempotent)
# ---------------------------------------------------------------------------
# The column sets mirror the Pydantic contracts in engine/schemas.py and the
# fields the trace logger (T0.5) records. Types are SQLite's flexible affinities;
# we keep them descriptive (TEXT/INTEGER/REAL) for readability.
_SCHEMA = """
-- Registered B2B users. email is the natural primary key, so re-registering
-- with the same email updates the existing row (see upsert_user).
CREATE TABLE IF NOT EXISTS users (
    email       TEXT PRIMARY KEY,
    agency      TEXT NOT NULL,
    full_name   TEXT NOT NULL,
    phone       TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- One chat session per browser session; links back to the user.
CREATE TABLE IF NOT EXISTS sessions (
    id          TEXT PRIMARY KEY,
    user_email  TEXT NOT NULL REFERENCES users(email),
    started_at  TEXT NOT NULL
);

-- Every turn of the conversation, persisted for context + audit.
CREATE TABLE IF NOT EXISTS messages (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id  TEXT NOT NULL REFERENCES sessions(id),
    role        TEXT NOT NULL,          -- 'user' | 'assistant' | 'system'
    content     TEXT NOT NULL,
    created_at  TEXT NOT NULL
);

-- Captured sales enquiries (the one write path). email_status tracks whether
-- the notification email was sent, logged in dev mode, or failed.
CREATE TABLE IF NOT EXISTS leads (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    user_email          TEXT NOT NULL,
    summary             TEXT NOT NULL,
    line_slug           TEXT,
    itinerary_name      TEXT,
    month               TEXT,
    party_size          INTEGER,
    transcript_excerpt  TEXT,
    created_at          TEXT NOT NULL,
    email_status        TEXT NOT NULL   -- 'sent' | 'logged' | 'failed'
);

-- Per-step observability: one row for each model call or tool invocation.
CREATE TABLE IF NOT EXISTS traces (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id       TEXT,
    step             TEXT,              -- a Step enum value (scope_gate, synthesize, ...)
    model            TEXT,
    tokens_in        INTEGER,
    tokens_out       INTEGER,
    cost_usd         REAL,
    latency_ms       INTEGER,
    tool             TEXT,              -- tool name, when the step called one
    tool_args_masked TEXT,             -- JSON string of args with PII masked
    retries          INTEGER,
    guard_outcome    TEXT,              -- e.g. 'ok' | 'currency_masked'
    created_at       TEXT NOT NULL
);

-- The searchable sailings table, loaded from sailings-index.json (T1.2).
-- No single natural key (aggregated rows repeat lines/ships), so the implicit
-- rowid is the key; the deterministic search filters on the indexed columns.
CREATE TABLE IF NOT EXISTS sailings (
    line           TEXT,
    ship           TEXT,
    name           TEXT,
    dest           TEXT,
    dest_label     TEXT,
    nights         TEXT,
    port           TEXT,
    months_json    TEXT,                -- the months[] array, stored as JSON
    season_hint    TEXT,
    count          INTEGER,
    ports_json     TEXT,                -- ordered ports of call, JSON array (TA.4)
    port_disembark TEXT,                -- arrival/disembark port, may be NULL (TA.4)
    sail_date      TEXT,                -- exact departure date (dated lines only), else NULL (TB.3)
    itinerary_days_json TEXT            -- numbered day-by-day schedule, JSON array, NULL if none (TC.1)
);

-- Indexes on the columns search filters by most often.
CREATE INDEX IF NOT EXISTS idx_sailings_dest ON sailings(dest);
CREATE INDEX IF NOT EXISTS idx_sailings_port ON sailings(port);
CREATE INDEX IF NOT EXISTS idx_sailings_line ON sailings(line);
"""


# Columns added to existing tables after the first schema shipped. `CREATE TABLE IF
# NOT EXISTS` only ever creates a *missing* table — it never alters one that already
# exists — so a database built by an earlier version keeps its old shape. This map lets
# init_db top up those columns on an existing DB (see _ensure_columns). New Phase 4B
# itinerary columns are added here so an app.db from a prior task keeps working.
_ADDED_COLUMNS = {
    "sailings": [
        ("ports_json", "TEXT"),            # ordered ports of call, JSON array (TA.4)
        ("port_disembark", "TEXT"),        # arrival/disembark port (TA.4)
        ("sail_date", "TEXT"),             # exact departure date, dated lines only (TB.3)
        ("itinerary_days_json", "TEXT"),   # numbered day-by-day schedule, JSON array (TC.1)
    ],
}


def _ensure_columns(conn: sqlite3.Connection) -> None:
    """Add any columns in `_ADDED_COLUMNS` that an older on-disk table is missing.
    SQLite has no 'ADD COLUMN IF NOT EXISTS', so we read the current columns from
    PRAGMA table_info and ALTER in only the absent ones. Idempotent: on a fresh DB
    (where _SCHEMA already created the columns) every column is present, so this is a
    no-op; on an old DB it backfills the new columns as NULLable."""
    for table, columns in _ADDED_COLUMNS.items():
        existing = {row["name"] for row in conn.execute(f"PRAGMA table_info({table})")}
        for name, coltype in columns:
            if name not in existing:
                conn.execute(f"ALTER TABLE {table} ADD COLUMN {name} {coltype}")


def init_db() -> None:
    """Create all tables and indexes if they are missing, then top up any columns an
    older database is missing. Idempotent: running it on an already-initialised database
    is a harmless no-op. Call this once at application start (and it is what the T0.4
    acceptance command runs)."""
    conn = _connect()
    try:
        conn.executescript(_SCHEMA)   # executescript runs the multi-statement DDL
        _ensure_columns(conn)         # migrate an existing DB to the current column set
        conn.commit()
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Typed write helpers — the sanctioned way to insert rows
# ---------------------------------------------------------------------------
# Each helper takes a validated Pydantic model (or plain scalars for the log-like
# tables) so bad data is rejected before it reaches SQL. They return the useful
# key (email / session id / row id) for the caller to reference.
def upsert_user(user: UserProfile) -> str:
    """Insert the user, or update their details if the email already exists.
    Returns the user's email (the primary key). ``created_at`` is only set on
    first insert — ON CONFLICT leaves the original timestamp untouched."""
    conn = _connect()
    try:
        conn.execute(
            """
            INSERT INTO users (email, agency, full_name, phone, created_at)
            VALUES (?, ?, ?, ?, ?)
            ON CONFLICT(email) DO UPDATE SET
                agency    = excluded.agency,
                full_name = excluded.full_name,
                phone     = excluded.phone
            """,
            (user.email, user.agency, user.full_name, user.phone, _now()),
        )
        conn.commit()
        return user.email
    finally:
        conn.close()


def create_session(session_id: str, user_email: str) -> str:
    """Open a chat session for a user. The caller supplies the id (e.g. a UUID
    from the Streamlit layer) so it can key ``st.session_state`` by the same
    value. Returns the session id."""
    conn = _connect()
    try:
        conn.execute(
            "INSERT INTO sessions (id, user_email, started_at) VALUES (?, ?, ?)",
            (session_id, user_email, _now()),
        )
        conn.commit()
        return session_id
    finally:
        conn.close()


def add_message(session_id: str, role: str, content: str) -> int:
    """Persist one conversation turn. Returns the new message's row id."""
    conn = _connect()
    try:
        cur = conn.execute(
            "INSERT INTO messages (session_id, role, content, created_at) VALUES (?, ?, ?, ?)",
            (session_id, role, content, _now()),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Read helpers — used by the UI to restore a session after a browser refresh
# ---------------------------------------------------------------------------
# Streamlit's in-memory state is lost on a hard refresh; these let the app reload
# the user + conversation from SQLite using the session id kept in the URL.
def get_session(session_id: str) -> dict | None:
    """Return the session row ``{id, user_email}`` for a session id, or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT id, user_email FROM sessions WHERE id = ?", (session_id,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_user(email: str) -> dict | None:
    """Return the user row ``{email, agency, full_name, phone}`` for an email, or None."""
    conn = _connect()
    try:
        row = conn.execute(
            "SELECT email, agency, full_name, phone FROM users WHERE email = ?", (email,)
        ).fetchone()
        return dict(row) if row else None
    finally:
        conn.close()


def get_messages(session_id: str) -> list[dict]:
    """Return the session's messages as ``[{role, content}, ...]`` in order."""
    conn = _connect()
    try:
        rows = conn.execute(
            "SELECT role, content FROM messages WHERE session_id = ? ORDER BY id",
            (session_id,),
        ).fetchall()
        return [{"role": r["role"], "content": r["content"]} for r in rows]
    finally:
        conn.close()


# ---------------------------------------------------------------------------
# Reporting reads — the whole users / leads tables, for the export report (T7.3)
# ---------------------------------------------------------------------------
# These back `python -m engine.reports` and return every row (not one keyed lookup
# like get_user). They intentionally include real contact details — the report is
# for authorized internal use — unlike the trace layer, which masks PII.
def list_users() -> list[dict]:
    """Return every registered agency, newest first, each with a count of the
    enquiries (leads) it has raised. The LEFT JOIN keeps agencies with zero
    enquiries (they show ``enquiries = 0``)."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT u.agency, u.full_name, u.email, u.phone, u.created_at,
                   COUNT(l.id) AS enquiries
            FROM users u
            LEFT JOIN leads l ON l.user_email = u.email
            GROUP BY u.email
            ORDER BY u.created_at DESC, u.email
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def list_leads() -> list[dict]:
    """Return every captured lead, newest first, with the raising agency's name
    joined in (LEFT JOIN so a lead survives even if its user row was removed)."""
    conn = _connect()
    try:
        rows = conn.execute(
            """
            SELECT l.created_at, u.agency, l.user_email, l.line_slug, l.month,
                   l.party_size, l.email_status, l.summary
            FROM leads l
            LEFT JOIN users u ON u.email = l.user_email
            ORDER BY l.created_at DESC, l.id DESC
            """
        ).fetchall()
        return [dict(r) for r in rows]
    finally:
        conn.close()


def insert_lead(lead: LeadEnquiry, email_status: str) -> int:
    """Store a captured enquiry. ``email_status`` records what happened to the
    notification ('sent' | 'logged' | 'failed'), set by the lead tool (T5.x).
    Returns the new lead's row id."""
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO leads (
                user_email, summary, line_slug, itinerary_name, month,
                party_size, transcript_excerpt, created_at, email_status
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                lead.user_email, lead.summary, lead.line_slug, lead.itinerary_name,
                lead.month, lead.party_size, lead.transcript_excerpt, _now(),
                email_status,
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()


def insert_trace(
    *,
    session_id: str | None = None,
    step: str | None = None,
    model: str | None = None,
    tokens_in: int | None = None,
    tokens_out: int | None = None,
    cost_usd: float | None = None,
    latency_ms: int | None = None,
    tool: str | None = None,
    tool_args_masked: str | None = None,
    retries: int | None = None,
    guard_outcome: str | None = None,
) -> int:
    """Write one observability row. Every field is optional because different
    steps fill in different columns (a model call has tokens/cost; a tool call
    has tool/args). Keyword-only to avoid positional-argument mistakes across so
    many columns. The higher-level trace API (T0.5) wraps this. Returns row id."""
    conn = _connect()
    try:
        cur = conn.execute(
            """
            INSERT INTO traces (
                session_id, step, model, tokens_in, tokens_out, cost_usd,
                latency_ms, tool, tool_args_masked, retries, guard_outcome,
                created_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                session_id, step, model, tokens_in, tokens_out, cost_usd,
                latency_ms, tool, tool_args_masked, retries, guard_outcome,
                _now(),
            ),
        )
        conn.commit()
        return cur.lastrowid
    finally:
        conn.close()
