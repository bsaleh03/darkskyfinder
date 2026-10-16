"""Start-point search over each metro's FTS5 index (read-only)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .data import DataStore


def _ranked_hits(path: Path, text: str, limit: int) -> list[tuple[float, dict]]:
    """(bm25 rank, hit) pairs for one index; lower rank is a better match."""
    tokens = re.findall(r"\w+", text.lower())
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
    return [hit for _, hit in _ranked_hits(path, text, limit)]


def search(store: DataStore, text: str, metro: str | None = None, limit: int = 8) -> list[dict]:
    keys = [metro] if metro is not None else sorted(store.metros)
    ranked: list[tuple[float, dict]] = []
    for key in keys:
        m = store.metros.get(key)
        if m is None:
            continue
        ranked += [(rank, {**hit, "metro": key}) for rank, hit in _ranked_hits(m.search_path, text, limit)]
    ranked.sort(key=lambda p: (p[0], p[1]["metro"], p[1]["name"]))
    return [hit for _, hit in ranked[:limit]]
