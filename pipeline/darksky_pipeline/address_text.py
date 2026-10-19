"""Street-address text normalization.

Two byte-identical copies: darksky_pipeline/address_text.py normalizes the indexed
street text and darksky_api/address_text.py normalizes queries the same way, so
"123 Main Street" finds "Main St" (api/tests/test_address_text.py pins them equal).
"""
from __future__ import annotations

import re

STREET_TYPES = {
    "street": "st", "avenue": "ave", "road": "rd", "drive": "dr", "boulevard": "blvd", "lane": "ln",
    "court": "ct", "place": "pl", "circle": "cir", "terrace": "ter", "parkway": "pkwy", "highway": "hwy",
    "trail": "trl",
}
DIRECTIONS = {
    "north": "n", "south": "s", "east": "e", "west": "w",
    "northeast": "ne", "northwest": "nw", "southeast": "se", "southwest": "sw",
}
TOKEN_MAP = {**STREET_TYPES, **DIRECTIONS}
_SHORT_DIRECTIONS = frozenset(DIRECTIONS.values())
_APOSTROPHES = re.compile(r"['’]")
_WORD = re.compile(r"[^\W_]+")


def tokens(text: str | None) -> list[str]:
    """Lowercased words with punctuation stripped and canonical short forms applied."""
    if not text:
        return []
    return [TOKEN_MAP.get(t, t) for t in _WORD.findall(_APOSTROPHES.sub("", text.lower()))]


def normalize(text: str | None) -> str:
    return " ".join(tokens(text))


def _cap(word: str) -> str:
    return word[:1].upper() + word[1:] if word[:1].isalpha() else word


def display_street(norm: str) -> str:
    """Tidy title case for a normalized street ("s state st" -> "S State St")."""
    return " ".join(w.upper() if w in _SHORT_DIRECTIONS else _cap(w) for w in norm.split())


def display_city(city: str | None) -> str:
    return " ".join(_cap(w.lower()) for w in city.split()) if city else ""
