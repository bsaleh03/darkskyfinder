"""Start-point search over each metro's FTS5 index (read-only).

FTS bm25 ranks are not comparable across indexes, so hits are merged by a
sort tuple: divisions (towns, counties, neighborhoods) before places, then
exact name > whole-word match > prefix-only, then bm25 as the last tiebreak.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .data import DataStore
from .routing import haversine_km

DIVISION_KINDS = frozenset({"locality", "localadmin", "county", "neighborhood", "macrohood", "microhood"})
MIN_TOKEN_LEN = 2
FETCH_MIN = 40
FETCH_PER_RESULT = 5
DEDUPE_KM = 1.0


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


def search(store: DataStore, text: str, metro: str | None = None, limit: int = 8) -> list[dict]:
    tokens = _tokens(text)
    if not tokens:
        return []
    query = " ".join(text.lower().split())
    fetch = max(limit * FETCH_PER_RESULT, FETCH_MIN)
    keys = [metro] if metro is not None else sorted(store.metros)
    scored: list[tuple[tuple, dict]] = []
    for key in keys:
        m = store.metros.get(key)
        if m is None:
            continue
        for rank, hit in _ranked_hits(m.search_path, tokens, fetch):
            kind_priority = 0 if hit["kind"] in DIVISION_KINDS else 1
            sort_key = (kind_priority, _match_quality(hit["name"], query, tokens), rank, key, hit["name"])
            scored.append((sort_key, {**hit, "metro": key}))
    scored.sort(key=lambda p: p[0])
    out: list[dict] = []
    for _, hit in scored:
        ident = (hit["name"].lower(), hit["kind"], hit["metro"])
        if any((o["name"].lower(), o["kind"], o["metro"]) == ident
               and haversine_km(o["lon"], o["lat"], hit["lon"], hit["lat"]) <= DEDUPE_KM for o in out):
            continue
        out.append(hit)
        if len(out) >= limit:
            break
    return out
