"""SQLite FTS5 index for start-point search (places, addresses, areas)."""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Iterable

import pandas as pd

from .config import DIVISION_SUBTYPES
from .util import as_list, wkb_to_geoms

MIN_SEARCH_PLACE_CONFIDENCE = 0.5

Row = tuple[str, str, float, float]  # name, kind, lat, lon


def format_address(number, street, address_levels) -> str | None:
    if not isinstance(street, str) or not street.strip():
        return None
    head = f"{number.strip()} {street.strip()}" if isinstance(number, str) and number.strip() else street.strip()
    levels = [lv.get("value") for lv in as_list(address_levels) if isinstance(lv, dict) and lv.get("value")]
    return f"{head}, {levels[-1]}" if levels else head


def search_rows(places: pd.DataFrame, addresses: pd.DataFrame, divisions: pd.DataFrame) -> list[Row]:
    rows: list[Row] = []
    p = places[places["name"].notna() & (places["confidence"] >= MIN_SEARCH_PLACE_CONFIDENCE)]
    rows += [(str(n), "place", float(lat), float(lon)) for n, lat, lon in p[["name", "lat", "lon"]].itertuples(index=False)]
    for number, street, levels, lat, lon in addresses[["number", "street", "address_levels", "lat", "lon"]].itertuples(index=False):
        text = format_address(number, street, levels)
        if text:
            rows.append((text, "address", float(lat), float(lon)))
    d = divisions[divisions["name"].notna() & divisions["subtype"].isin(DIVISION_SUBTYPES)].reset_index(drop=True)
    if len(d):
        for (name, subtype), g in zip(d[["name", "subtype"]].itertuples(index=False), wkb_to_geoms(d["wkb"])):
            rp = g.representative_point()
            rows.append((str(name), str(subtype), float(rp.y), float(rp.x)))
    return rows


def build_search_index(rows: Iterable[Row], path: Path) -> None:
    path = Path(path)
    if path.exists():
        path.unlink()
    con = sqlite3.connect(path)
    try:
        con.execute("CREATE VIRTUAL TABLE search USING fts5("
                    "name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                    "tokenize='unicode61 remove_diacritics 2')")
        con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", rows)
        con.commit()
    finally:
        con.close()


def query(path: Path, text: str, limit: int = 10) -> list[dict]:
    tokens = re.findall(r"\w+", text.lower())
    if not tokens:
        return []
    match = " ".join(f'"{t}"*' for t in tokens)
    con = sqlite3.connect(path)
    try:
        cur = con.execute("SELECT name, kind, lat, lon FROM search WHERE search MATCH ? ORDER BY rank LIMIT ?",
                          (match, limit))
        return [{"name": n, "kind": k, "lat": float(la), "lon": float(lo)} for n, k, la, lo in cur.fetchall()]
    finally:
        con.close()
