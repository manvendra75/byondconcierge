"""engine.tools.resolve — deterministic natural-language → filter helpers.

These are pure, LLM-free functions that turn the loose way people phrase a query
("med in jan", "royal caribbean") into the exact canonical values the sailings
search filters on. Doing this in code (not the model) is the guide's "code owns
business rules" principle: the mapping is testable, cheap, and can't hallucinate.

Four resolvers, each returning a canonical value or ``None`` when nothing matches
(``resolve_month`` also returns the sentinel ``"AMBIGUOUS"``):

* resolve_month       "Jan" -> "2027-01"        (against the data's month window)
* resolve_destination "med" -> "Mediterranean"  (one of 22 canonical buckets)
* resolve_port        "rome" -> "Rome"          (a departure port in the data)
* resolve_line        "royal caribbean" -> "royal-caribbean"  (a line slug)
"""

from __future__ import annotations

import calendar
import json
import re
from functools import lru_cache

from engine.config import PROJECT_ROOT

# ---------------------------------------------------------------------------
# resolve_month — month word -> "YYYY-MM" within the sailable window
# ---------------------------------------------------------------------------
# The sailings data covers Jul 2026 – Dec 2027. A bare month name is resolved to
# the single in-window occurrence; if two occurrences fall in the window (any
# month Jul–Dec appears in BOTH 2026 and 2027) we can't guess, so we say so.
_WINDOW_START = (2026, 7)     # inclusive (year, month)
_WINDOW_END = (2027, 12)      # inclusive

# Month names + common abbreviations -> month number.
_MONTHS = {
    "jan": 1, "january": 1, "feb": 2, "february": 2, "mar": 3, "march": 3,
    "apr": 4, "april": 4, "may": 5, "jun": 6, "june": 6, "jul": 7, "july": 7,
    "aug": 8, "august": 8, "sep": 9, "sept": 9, "september": 9,
    "oct": 10, "october": 10, "nov": 11, "november": 11, "dec": 12, "december": 12,
}

# Filler words to drop so "next jan" / "in March" resolve like "jan" / "march".
_FILLER = re.compile(r"\b(next|this|coming|in|by|during|early|late|mid|the|of|for)\b")


def _in_window(year: int, month: int) -> bool:
    """True if (year, month) falls inside the sailable window (inclusive)."""
    return _WINDOW_START <= (year, month) <= _WINDOW_END


def resolve_month(word: str) -> str | None:
    """Resolve a month expression to a canonical ``"YYYY-MM"`` string.

    Returns:
      * ``"YYYY-MM"`` when there is exactly one in-window match (e.g. "Jan" ->
        "2027-01", since 2026-01 is before the window),
      * ``"AMBIGUOUS"`` when the month occurs twice in the window and no year was
        given (e.g. "August" -> both 2026-08 and 2027-08),
      * ``None`` when it can't be parsed or lands outside the window.

    Accepts a bare month ("january"), filler-prefixed ("next jan"), an explicit
    year ("jan 2027"), or an already-formatted "2027-01".
    """
    if not word:
        return None
    s = word.strip().lower()

    # Already "YYYY-MM"? Accept it if it's inside the window.
    m = re.fullmatch(r"(\d{4})-(\d{2})", s)
    if m:
        year, month = int(m.group(1)), int(m.group(2))
        return f"{year:04d}-{month:02d}" if _in_window(year, month) else None

    s = _FILLER.sub(" ", s)

    # An explicit 4-digit year pins the answer (no ambiguity).
    year_match = re.search(r"20\d{2}", s)
    explicit_year = int(year_match.group(0)) if year_match else None

    # First recognised month token wins.
    month = next((_MONTHS[t] for t in re.findall(r"[a-z]+", s) if t in _MONTHS), None)
    if month is None:
        return None

    if explicit_year is not None:
        return f"{explicit_year:04d}-{month:02d}" if _in_window(explicit_year, month) else None

    # No year: which window years contain this month?
    candidates = [y for y in (2026, 2027) if _in_window(y, month)]
    if len(candidates) == 1:
        return f"{candidates[0]:04d}-{month:02d}"
    if len(candidates) > 1:
        return "AMBIGUOUS"
    return None


# ---------------------------------------------------------------------------
# detect_month — the month a user NAMED, as free text (no year pinned)
# ---------------------------------------------------------------------------
def detect_month(text: str) -> str | None:
    """Return the first calendar month named in free text, title-cased
    ("December"), or ``None`` if none is mentioned.

    Unlike :func:`resolve_month`, this does NOT resolve to a ``"YYYY-MM"`` or care
    about the sailable window — it just reports which month was said. It backs the
    lead draft (T5.2), where ``month`` is free-text context for the sales desk, so
    "December" is more useful (and never "AMBIGUOUS") than a guessed year.
    """
    if not text:
        return None
    for tok in re.findall(r"[a-z]+", text.lower()):
        if tok in _MONTHS:
            return calendar.month_name[_MONTHS[tok]]   # e.g. 12 -> "December"
    return None


# ---------------------------------------------------------------------------
# resolve_date_range — natural-language timeframe -> a bounded date range (TB.5)
# ---------------------------------------------------------------------------
def resolve_date_range(text: str) -> tuple[str | None, str | None]:
    """Map a natural-language timeframe to an inclusive ``("YYYY-MM-DD", "YYYY-MM-DD")``
    range inside the sailing window, or ``(None, None)`` when it can't be parsed.

    Handles a month (optionally with a year) plus an optional sub-month qualifier::

        "August 2026" / "August"     -> the whole month
        "first half of August"       -> days 1–15
        "second half of August"      -> day 16 – end of month
        "first week of September"    -> days 1–7      (also 2nd / 3rd / last week)
        "early / mid / late October" -> the month's first / middle / last stretch

    Year: an explicit 4-digit year wins; otherwise the EARLIEST in-window occurrence of
    the month is used (Jul–Dec -> 2026, Jan–Jun -> 2027), i.e. the soonest bookable one.
    A range that has already passed isn't special-cased here — the past-date guard in
    ``search_sailings`` (TB.4) drops departed dates at query time.
    """
    if not text:
        return (None, None)
    s = _norm(text)                                   # lowercase, strip punctuation, keep digits
    if not s:
        return (None, None)

    # The month is the first recognised month token in the phrase.
    month = next((_MONTHS[t] for t in re.findall(r"[a-z]+", s) if t in _MONTHS), None)
    if month is None:
        return (None, None)

    # Year: an explicit 20xx wins; else the earliest in-window occurrence of this month.
    year_match = re.search(r"20\d{2}", s)
    if year_match:
        year = int(year_match.group(0))
        if not _in_window(year, month):
            return (None, None)
    else:
        candidates = [y for y in (2026, 2027) if _in_window(y, month)]
        if not candidates:
            return (None, None)
        year = candidates[0]                          # soonest bookable occurrence

    last = calendar.monthrange(year, month)[1]        # number of days in the month

    # Sub-month qualifier -> (start_day, end_day). Default is the whole month.
    start, end = 1, last
    if re.search(r"\b(first|1st) half\b", s):
        start, end = 1, 15
    elif re.search(r"\b(second|2nd|last) half\b", s):
        start, end = 16, last
    elif re.search(r"\b(first|1st) week\b", s):
        start, end = 1, 7
    elif re.search(r"\b(second|2nd) week\b", s):
        start, end = 8, 14
    elif re.search(r"\b(third|3rd) week\b", s):
        start, end = 15, 21
    elif re.search(r"\blast week\b", s):
        start, end = max(1, last - 6), last
    elif re.search(r"\bearly\b", s):
        start, end = 1, 10
    elif re.search(r"\b(mid|middle)\b", s):
        start, end = 11, 20
    elif re.search(r"\blate\b", s):
        start, end = 21, last

    return (f"{year:04d}-{month:02d}-{start:02d}", f"{year:04d}-{month:02d}-{end:02d}")


# ---------------------------------------------------------------------------
# resolve_destination — free text -> one of the 22 canonical destinations
# ---------------------------------------------------------------------------
# The canonical taxonomy (mirrors searchTypes.ts DESTINATIONS on the website).
_DESTINATIONS = (
    "Mediterranean", "Greek Isles & Aegean", "Caribbean", "Bahamas", "Arabian Gulf",
    "Red Sea", "Northern Europe & Baltic", "Norwegian Fjords", "Alaska",
    "Asia (Far East)", "Southeast Asia", "Australia & New Zealand", "South Pacific",
    "Hawaii", "Mexico & Baja", "South America", "Transatlantic & repositioning",
    "World & Grand Voyages", "European rivers", "Expedition (Polar)",
    "North America & Canada", "Middle East & Africa journeys",
)

# Common ways people say each bucket -> the canonical value. Keys are normalized
# (lowercased); the exact canonical names are also matched before this map.
_DEST_SYNONYMS = {
    "med": "Mediterranean", "medi": "Mediterranean", "mediterranean": "Mediterranean",
    "greece": "Greek Isles & Aegean", "greek": "Greek Isles & Aegean",
    "greek isles": "Greek Isles & Aegean", "aegean": "Greek Isles & Aegean",
    "caribbean": "Caribbean", "caribs": "Caribbean", "west indies": "Caribbean",
    "bahamas": "Bahamas",
    "gulf": "Arabian Gulf", "arabian gulf": "Arabian Gulf", "persian gulf": "Arabian Gulf",
    "dubai": "Arabian Gulf",
    "red sea": "Red Sea",
    "baltic": "Northern Europe & Baltic", "northern europe": "Northern Europe & Baltic",
    "scandinavia": "Northern Europe & Baltic",
    "fjords": "Norwegian Fjords", "norway": "Norwegian Fjords", "norwegian fjords": "Norwegian Fjords",
    "alaska": "Alaska",
    "asia": "Asia (Far East)", "far east": "Asia (Far East)", "japan": "Asia (Far East)",
    "southeast asia": "Southeast Asia", "se asia": "Southeast Asia",
    "australia": "Australia & New Zealand", "new zealand": "Australia & New Zealand",
    "anz": "Australia & New Zealand", "australia and new zealand": "Australia & New Zealand",
    "south pacific": "South Pacific", "tahiti": "South Pacific", "fiji": "South Pacific",
    "hawaii": "Hawaii",
    "mexico": "Mexico & Baja", "baja": "Mexico & Baja",
    "south america": "South America",
    "transatlantic": "Transatlantic & repositioning", "repositioning": "Transatlantic & repositioning",
    "crossing": "Transatlantic & repositioning",
    "world": "World & Grand Voyages", "world cruise": "World & Grand Voyages",
    "grand voyage": "World & Grand Voyages",
    "river": "European rivers", "rivers": "European rivers", "european rivers": "European rivers",
    "danube": "European rivers", "rhine": "European rivers",
    "expedition": "Expedition (Polar)", "polar": "Expedition (Polar)",
    "arctic": "Expedition (Polar)", "antarctic": "Expedition (Polar)", "antarctica": "Expedition (Polar)",
    "canada": "North America & Canada", "north america": "North America & Canada",
    "new england": "North America & Canada",
    "africa": "Middle East & Africa journeys", "middle east": "Middle East & Africa journeys",
    "seychelles": "Middle East & Africa journeys",
}


def _norm(text: str) -> str:
    """Lowercase, drop punctuation, collapse whitespace — the shared normaliser
    for fuzzy text matching."""
    return re.sub(r"\s+", " ", re.sub(r"[^a-z0-9 ]", " ", text.lower())).strip()


def resolve_destination(text: str) -> str | None:
    """Map free text to one of the 22 canonical destinations, or ``None``.

    Order of attempts: exact canonical name -> known synonym -> substring overlap
    (input contained in a canonical name or vice-versa). "med" -> "Mediterranean".
    """
    if not text:
        return None
    q = _norm(text)
    if not q:
        return None

    # Exact canonical (case-insensitive).
    for dest in _DESTINATIONS:
        if _norm(dest) == q:
            return dest
    # Known synonym.
    if q in _DEST_SYNONYMS:
        return _DEST_SYNONYMS[q]
    # Loose overlap: the query is a substring of a canonical name, or vice-versa.
    for dest in _DESTINATIONS:
        nd = _norm(dest)
        if q in nd or nd in q:
            return dest
    return None


# ---------------------------------------------------------------------------
# Umbrella regions — one broad word -> the SET of canonical destinations it spans
# ---------------------------------------------------------------------------
# A term like "Europe" is not a single destination: it covers the Mediterranean, the Greek Isles,
# Northern Europe, the Fjords and the rivers. resolve_destination() (single-value) collapses it to
# ONE bucket, so a search for "Carnival in Europe" silently misses everything outside that one bucket.
# This map expands an umbrella term to ALL the canonical destinations it contains, and search matches
# any of them (TE.2). Every value MUST be a member of _DESTINATIONS (guarded by the region_expansion
# validator, TE.4). Keys are normalised (lowercase); each umbrella must expand to >= 2 destinations —
# a single-destination term belongs in _DEST_SYNONYMS, not here.
_EUROPE = ["Mediterranean", "Greek Isles & Aegean", "Northern Europe & Baltic",
           "Norwegian Fjords", "European rivers"]
_REGION_DESTINATIONS = {
    "europe": _EUROPE,
    "european": _EUROPE,
    "asia": ["Asia (Far East)", "Southeast Asia"],
    "americas": ["North America & Canada", "South America", "Caribbean", "Bahamas", "Mexico & Baja"],
    "middle east and africa": ["Middle East & Africa journeys", "Red Sea", "Arabian Gulf"],
}

# Filler words stripped before the umbrella lookup, so "cruises in Europe" / "the Americas" still
# resolve to their key. Whole-word only (won't touch "india"/"asian" etc.).
_REGION_FILLER = re.compile(r"\b(cruises?|sailings?|region|area|holidays?|vacations?|in|to|the)\b")


def resolve_region(text: str) -> list[str] | None:
    """Map a broad umbrella region to the SET of canonical destinations it spans, or ``None``.

    Deliberately EXACT-key (not substring) so a more specific term is never over-broadened:
    "Southeast Asia" stays a single destination (returns ``None`` here -> resolve_destination handles
    it), while "Asia" expands to both Asian buckets. Filler words ("in", "the", "cruises") are stripped
    first so "cruises in Europe" still matches "europe". Returns ``None`` for anything that isn't a
    registered umbrella — the caller then falls back to the single-destination resolver.
    """
    if not text:
        return None
    q = _norm(text)
    if not q:
        return None
    # Try the raw query, then the query with filler words removed.
    stripped = re.sub(r"\s+", " ", _REGION_FILLER.sub(" ", q)).strip()
    for cand in (q, stripped):
        if cand in _REGION_DESTINATIONS:
            return list(_REGION_DESTINATIONS[cand])
    return None


# ---------------------------------------------------------------------------
# resolve_port — free text -> a canonical departure port present in the data
# ---------------------------------------------------------------------------
@lru_cache(maxsize=1)
def _known_ports() -> tuple[str, ...]:
    """The distinct departure ports in the committed sailings index, loaded once
    and cached. Reading the committed snapshot keeps this deterministic."""
    data = json.loads((PROJECT_ROOT / "data" / "sailings-index.json").read_text(encoding="utf-8"))
    return tuple(sorted({r["port"] for r in data["records"]}))


def _norm_port(name: str) -> str:
    """Normalise a port for matching: drop any '(...)' qualifier (so
    'Rome (Civitavecchia)' -> 'rome'), then lowercase/strip punctuation."""
    return _norm(re.sub(r"\([^)]*\)", "", name))


def resolve_port(text: str) -> str | None:
    """Map free text to a canonical departure port, or ``None``.

    Tries an exact normalised match first (ignoring '(...)' qualifiers), then a
    substring overlap. When several ports match, the shortest name is chosen so
    'rome' -> 'Rome' rather than 'Rome (Civitavecchia)'.
    """
    if not text:
        return None
    q = _norm_port(text)
    if not q:
        return None

    ports = _known_ports()
    exact = [p for p in ports if _norm_port(p) == q]
    if exact:
        return min(exact, key=lambda p: (len(p), p))

    # Substring overlap in either direction (e.g. "civitavecchia" within a port).
    loose = [p for p in ports if q in _norm_port(p) or _norm_port(p) in q]
    if loose:
        return min(loose, key=lambda p: (len(p), p))
    return None


# ---------------------------------------------------------------------------
# resolve_line — name / slug / alias -> line slug
# ---------------------------------------------------------------------------
# One row per line: (slug, extra aliases). The slug itself and the display name
# are always accepted; aliases cover abbreviations and alternate spellings.
_LINE_ALIASES: dict[str, tuple[str, ...]] = {
    "costa": ("costa", "costa cruises"),
    "norwegian": ("norwegian", "ncl", "norwegian cruise line"),
    "carnival": ("carnival", "carnival cruises", "carnival cruise line", "ccl"),
    "royal-caribbean": ("royal caribbean", "royal caribbean international", "rccl", "rci"),
    "msc": ("msc", "msc cruises"),
    "disney": ("disney", "disney cruise line", "dcl"),
    "celebrity": ("celebrity", "celebrity cruises"),
    "silversea": ("silversea", "silversea cruises"),
    "crystal": ("crystal", "crystal cruises"),
    "scenic-emerald": ("scenic", "emerald", "scenic emerald", "scenic and emerald",
                       "scenic cruises", "emerald cruises"),
    "aroya": ("aroya", "aroya cruises"),
    "dream-star": ("stardream", "star dream", "stardream cruises", "dream star"),
    "elixir": ("elixir", "elixir cruises"),
}

# Flatten aliases into one lookup: normalized phrase -> slug (built once).
_LINE_LOOKUP: dict[str, str] = {}
for _slug, _aliases in _LINE_ALIASES.items():
    _LINE_LOOKUP[_slug] = _slug                       # the slug maps to itself
    for _alias in _aliases:
        _LINE_LOOKUP[_norm(_alias)] = _slug


def resolve_line(text: str) -> str | None:
    """Map a cruise-line name, slug, or alias to its canonical slug, or ``None``.

    "royal caribbean" -> "royal-caribbean", "NCL" -> "norwegian". Matches the
    normalised phrase exactly first, then falls back to a partial match so
    "book celebrity for me" still finds "celebrity".
    """
    if not text:
        return None
    q = _norm(text)
    if not q:
        return None

    if q in _LINE_LOOKUP:
        return _LINE_LOOKUP[q]
    # Partial: an alias phrase appears as a whole inside the input.
    for phrase, slug in _LINE_LOOKUP.items():
        if re.search(rf"\b{re.escape(phrase)}\b", q):
            return slug
    return None
