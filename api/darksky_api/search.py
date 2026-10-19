"""Start-point search over each metro's FTS5 index (read-only).

FTS bm25 ranks are not comparable across indexes, so hits are merged by a
sort tuple: divisions (towns, counties, neighborhoods) before places, then
exact name > whole-word match > prefix-only, then bm25 as the last tiebreak.

A query starting with a house number ("1000 Woodward Ave Royal Oak") is also
looked up in the compact street-address index (`streets` + `blocks`, see the
pipeline's search_index.py): the number is interpolated along its 100-number
block, and these address hits come first. When Overture has no address hit, an
optional geocoder (geocode.GeocodeClient) supplies them instead.
"""
from __future__ import annotations

import re
import sqlite3
from dataclasses import dataclass
from pathlib import Path
from typing import Protocol

from . import config
from .address_text import TOKEN_MAP, tokens as address_tokens
from .config import BBox
from .data import DataStore
from .routing import haversine_km

DIVISION_KINDS = frozenset({"locality", "localadmin", "county", "neighborhood", "macrohood", "microhood"})
MIN_TOKEN_LEN = 2
FETCH_MIN = 40
FETCH_PER_RESULT = 5
DEDUPE_KM = 1.0
ADDRESS_FETCH = 40  # streets matched per metro before picking blocks
ADDRESS_NEAREST_MAX = 100  # house numbers from the nearest block when none contains the number
_HOUSE = re.compile(r"^\s*(\d+[a-z]?)\b(.*)$", re.IGNORECASE | re.DOTALL)


class Geocoder(Protocol):
    def search(self, text: str, bboxes: dict[str, BBox]) -> list[dict]: ...


@dataclass(frozen=True)
class AddressQuery:
    number: int
    label: str  # the house number as typed, e.g. "150b"
    tokens: list[str]  # normalized street/city/postcode tokens
    letters: int  # letters typed after the house number


def parse_address(text: str) -> AddressQuery | None:
    """A query that starts with a house number followed by street text."""
    m = _HOUSE.match(text)
    if not m:
        return None
    toks = address_tokens(m.group(2))
    if not toks:
        return None
    label = m.group(1).lower()
    return AddressQuery(int(re.match(r"\d+", label).group()), label, toks, sum(c.isalpha() for c in m.group(2)))


def _street_match(tokens: list[str]) -> str:
    """FTS query: every token, the last as a prefix; a partly typed long form ("stre") also tries its short form."""
    *head, last = tokens
    alts = [last] + sorted({short for long_, short in TOKEN_MAP.items() if long_.startswith(last) and short != last})
    tail = alts[0] if len(alts) == 1 else None
    parts = [f'"{t}"' for t in head]
    parts.append(f'"{tail}"*' if tail else "(" + " OR ".join(f'"{a}"*' for a in alts) + ")")
    return " AND ".join(parts)


def _pick_point(blocks: list[tuple], n: int) -> tuple[bool, float, float] | None:
    """(inside a block, lat, lon) for house number n, or None when no block is within reach."""
    best = None
    for lo, hi, lat_lo, lon_lo, dlat, dlon in blocks:
        if lo <= n <= hi:
            t = (n - lo) / (hi - lo) if hi > lo else 0.0
            return True, (lat_lo + t * dlat) / 1e5, (lon_lo + t * dlon) / 1e5
        gap, t = (lo - n, 0.0) if n < lo else (n - hi, 1.0)
        if gap <= ADDRESS_NEAREST_MAX and (best is None or gap < best[0]):
            best = (gap, (lat_lo + t * dlat) / 1e5, (lon_lo + t * dlon) / 1e5)
    return None if best is None else (False, best[1], best[2])


def _address_hits(path: Path, q: AddressQuery) -> list[tuple[tuple, dict]]:
    """(sort key, hit) pairs for one metro's address index; empty if the index has no address tables."""
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        try:
            streets = con.execute("SELECT s.rowid, n.display, s.rank FROM streets s "
                                  "JOIN street_names n ON n.id = s.rowid "
                                  "WHERE streets MATCH ? ORDER BY s.rank LIMIT ?",
                                  (_street_match(q.tokens), ADDRESS_FETCH)).fetchall()
        except sqlite3.OperationalError:  # an index built before addresses were added
            return []
        out = []
        for sid, display, rank in streets:
            blocks = con.execute("SELECT lo, hi, lat_lo, lon_lo, dlat_hi, dlon_hi FROM blocks WHERE street_id = ? "
                                 "ORDER BY lo", (sid,)).fetchall()
            point = _pick_point(blocks, q.number)
            if point is None:
                continue
            inside, lat, lon = point
            hit = {"name": f"{q.label} {display}", "kind": "address", "lat": round(lat, 6), "lon": round(lon, 6)}
            out.append(((0 if inside else 1, float(rank)), hit))
        return out
    finally:
        con.close()


def _addresses(store: DataStore, keys: list[str], q: AddressQuery, limit: int) -> list[dict]:
    scored = []
    for key in keys:
        for (inside, rank), hit in _address_hits(store.metros[key].search_path, q):
            scored.append(((inside, rank, key, hit["name"]), {**hit, "metro": key, "source": "overture"}))
    scored.sort(key=lambda p: p[0])
    out: list[dict] = []
    seen: set[tuple[str, str]] = set()
    for _, hit in scored:
        ident = (hit["name"].lower(), hit["metro"])
        if ident not in seen:
            seen.add(ident)
            out.append(hit)
            if len(out) >= limit:
                break
    return out


def _tokens(text: str) -> list[str]:
    return [t for t in re.findall(r"\w+", text.lower()) if len(t) >= MIN_TOKEN_LEN]


def _ranked_hits(path: Path, tokens: list[str], limit: int) -> list[tuple[float, dict]]:
    """(bm25 rank, hit) pairs for one index; lower rank is a better match."""
    if not tokens:
        return []
    match = " ".join(f'"{t}"*' for t in tokens)
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT name, kind, lat, lon, rank FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
                           (match, limit)).fetchall()
    finally:
        con.close()
    return [(float(r), {"name": n, "kind": k, "lat": float(la), "lon": float(lo)}) for n, k, la, lo, r in rows]


def query_index(path: Path, text: str, limit: int) -> list[dict]:
    return [hit for _, hit in _ranked_hits(path, _tokens(text), limit)]


def _match_quality(name: str, query: str, tokens: list[str]) -> int:
    lowered = name.lower()
    if lowered.strip() == query:
        return 0
    words = set(re.findall(r"\w+", lowered))
    return 1 if all(t in words for t in tokens) else 2


def search(store: DataStore, text: str, metro: str | None = None, limit: int = 8,
           geocoder: Geocoder | None = None) -> list[dict]:
    tokens = _tokens(text)
    keys = [k for k in ([metro] if metro is not None else sorted(store.metros)) if k in store.metros]
    out: list[dict] = []
    addr = parse_address(text)
    if addr is not None and keys:
        out = _addresses(store, keys, addr, limit)
        if not out and geocoder is not None and addr.letters >= config.GEOCODE_MIN_LETTERS:
            out = geocoder.search(text, {k: store.metros[k].info.bbox for k in keys})[:limit]
    if not tokens:
        return out
    query = " ".join(text.lower().split())
    fetch = max(limit * FETCH_PER_RESULT, FETCH_MIN)
    scored: list[tuple[tuple, dict]] = []
    for key in keys:
        m = store.metros[key]
        for rank, hit in _ranked_hits(m.search_path, tokens, fetch):
            kind_priority = 0 if hit["kind"] in DIVISION_KINDS else 1
            sort_key = (kind_priority, _match_quality(hit["name"], query, tokens), rank, key, hit["name"])
            scored.append((sort_key, {**hit, "metro": key, "source": "overture"}))
    scored.sort(key=lambda p: p[0])
    for _, hit in scored:
        if len(out) >= limit:
            break
        ident = (hit["name"].lower(), hit["kind"], hit["metro"])
        if any((o["name"].lower(), o["kind"], o["metro"]) == ident
               and haversine_km(o["lon"], o["lat"], hit["lon"], hit["lat"]) <= DEDUPE_KM for o in out):
            continue
        out.append(hit)
    return out
