"""Start-point search over each metro's FTS5 index (read-only)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path

from .data import DataStore


def query_index(path: Path, text: str, limit: int) -> list[dict]:
    tokens = re.findall(r"\w+", text.lower())
    if not tokens:
        return []
    match = " ".join(f'"{t}"*' for t in tokens)
    con = sqlite3.connect(f"file:{Path(path).as_posix()}?mode=ro", uri=True)
    try:
        rows = con.execute("SELECT name, kind, lat, lon FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
                           (match, limit)).fetchall()
    finally:
        con.close()
    return [{"name": n, "kind": k, "lat": float(la), "lon": float(lo)} for n, k, la, lo in rows]


def search(store: DataStore, text: str, metro: str | None = None, limit: int = 8) -> list[dict]:
    keys = [metro] if metro is not None else sorted(store.metros)
    out: list[dict] = []
    for key in keys:
        m = store.metros.get(key)
        if m is None:
            continue
        out += [{**hit, "metro": key} for hit in query_index(m.search_path, text, limit)]
    return out[:limit]
