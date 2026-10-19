"""SQLite FTS5 index for start-point search (places, areas, street addresses).

Addresses are stored compactly: one `streets` FTS row (+ `street_names` display)
per (street, city) and one `blocks` row per 100-number block holding the lowest
and highest house numbers and their points, so the API interpolates a house
number along the block.
"""
from __future__ import annotations

import re
import sqlite3
from pathlib import Path
from typing import Iterable

import pandas as pd

from .address_text import display_city, display_street, normalize
from .config import DIVISION_SUBTYPES
from .util import as_list, atomic_path, wkb_to_geoms

MIN_SEARCH_PLACE_CONFIDENCE = 0.5
ADDRESS_BLOCK = 100  # house numbers per block
COORD_DECIMALS = 5  # ~1 m

Row = tuple[str, str, float, float]  # name, kind, lat, lon
StreetRow = tuple[int, str, str]  # id, normalized "street city state postcodes" text, display
BlockRow = tuple[int, int, int, float, float, float, float]  # street_id, lo, hi, lat_lo, lon_lo, lat_hi, lon_hi


def search_rows(places: pd.DataFrame, divisions: pd.DataFrame) -> list[Row]:
    rows: list[Row] = []
    p = places[places["name"].notna() & (places["confidence"] >= MIN_SEARCH_PLACE_CONFIDENCE)]
    rows += [(str(n), "place", float(lat), float(lon)) for n, lat, lon in p[["name", "lat", "lon"]].itertuples(index=False)]
    d = divisions[divisions["name"].notna() & divisions["subtype"].isin(DIVISION_SUBTYPES)].reset_index(drop=True)
    if len(d):
        for (name, subtype), g in zip(d[["name", "subtype"]].itertuples(index=False), wkb_to_geoms(d["wkb"])):
            rp = g.representative_point()
            rows.append((str(name), str(subtype), float(rp.y), float(rp.x)))
    return rows


def _levels(value) -> tuple[str, str]:
    """(state, city) from Overture address_levels ([state, city]; city may be missing)."""
    vals = [lv.get("value") for lv in as_list(value) if isinstance(lv, dict) and lv.get("value")]
    return (vals[0] if vals else "", vals[-1] if len(vals) >= 2 else "")


def _postcode(value) -> str:
    if not isinstance(value, str):
        return ""
    return normalize(value.split("-")[0].replace(" ", ""))


def address_blocks(addresses: pd.DataFrame) -> tuple[list[StreetRow], list[BlockRow]]:
    """Group addresses by (normalized street, city) and 100-block of the leading house number."""
    num = addresses["number"].astype("string").str.extract(r"^\s*(\d+)", expand=False)
    df = pd.DataFrame({"n": pd.to_numeric(num, errors="coerce"), "street": addresses["street"],
                       "postcode": addresses["postcode"], "levels": addresses["address_levels"],
                       "lat": addresses["lat"].astype(float), "lon": addresses["lon"].astype(float)})
    df = df[df["n"].notna() & df["street"].notna()]
    if df.empty:
        return [], []
    street_norm = {s: normalize(s) for s in df["street"].unique()}
    df["s_norm"] = df["street"].map(street_norm)
    state_city = [_levels(v) for v in df["levels"]]
    df["state"] = [normalize(st) for st, _ in state_city]
    df["city_raw"] = [c for _, c in state_city]
    city_norm = {c: normalize(c) for c in df["city_raw"].unique()}
    df["c_norm"] = df["city_raw"].map(city_norm)
    df = df[df["s_norm"] != ""]
    if df.empty:
        return [], []
    df["n"] = df["n"].astype("int64")
    df["pc"] = [_postcode(v) for v in df["postcode"]]

    streets: list[StreetRow] = []
    sid_of: dict[tuple[str, str], int] = {}
    for sid, ((s_norm, c_norm), g) in enumerate(df.groupby(["s_norm", "c_norm"], sort=True)):
        sid_of[(s_norm, c_norm)] = sid
        state = g["state"].iloc[0]
        pcs = sorted({pc for pc in g["pc"] if pc})
        text = " ".join(t for t in [s_norm, c_norm, state, *pcs] if t)
        city = display_city(g["city_raw"].iloc[0])
        display = f"{display_street(s_norm)}, {city}" if city else display_street(s_norm)
        streets.append((sid, text, display))

    df["sid"] = [sid_of[k] for k in zip(df["s_norm"], df["c_norm"])]
    df["block"] = df["n"] // ADDRESS_BLOCK
    pts = df.groupby(["sid", "block", "n"], sort=True)[["lat", "lon"]].mean().reset_index()
    grouped = pts.groupby(["sid", "block"], sort=True)
    lo, hi = grouped.first().reset_index(), grouped.last().reset_index()
    r = COORD_DECIMALS
    blocks: list[BlockRow] = [
        (int(sid), int(nlo), int(nhi), round(float(alo), r), round(float(olo), r), round(float(ahi), r), round(float(ohi), r))
        for sid, nlo, alo, olo, nhi, ahi, ohi in zip(lo["sid"], lo["n"], lo["lat"], lo["lon"],
                                                      hi["n"], hi["lat"], hi["lon"])]
    return streets, blocks


def _e5(deg: float) -> int:
    return round(deg * 10 ** COORD_DECIMALS)


def _block_ints(b: BlockRow) -> tuple[int, ...]:
    sid, lo, hi, lat_lo, lon_lo, lat_hi, lon_hi = b
    return sid, lo, hi, _e5(lat_lo), _e5(lon_lo), _e5(lat_hi) - _e5(lat_lo), _e5(lon_hi) - _e5(lon_lo)


def build_search_index(rows: Iterable[Row], path: Path, streets: Iterable[StreetRow] = (),
                       blocks: Iterable[BlockRow] = ()) -> None:
    with atomic_path(path) as tmp:
        con = sqlite3.connect(tmp)
        try:
            con.execute("CREATE VIRTUAL TABLE search USING fts5("
                        "name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                        "tokenize='unicode61 remove_diacritics 2')")
            con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", rows)
            # Contentless (the text is only matched, never read back) with detail=none: a fraction of the size.
            con.execute("CREATE VIRTUAL TABLE streets USING fts5(text, content='', detail=none, "
                        "tokenize='unicode61 remove_diacritics 2')")
            con.execute("CREATE TABLE street_names (id INTEGER PRIMARY KEY, display TEXT NOT NULL)")
            for sid, text, display in streets:
                con.execute("INSERT INTO streets (rowid, text) VALUES (?, ?)", (sid, text))
                con.execute("INSERT INTO street_names (id, display) VALUES (?, ?)", (sid, display))
            # Points as 1e-5 degree integers, the hi point as an offset from the lo point (small varints).
            # Keyed by (street_id, lo): the primary key doubles as the street_id index.
            con.execute("CREATE TABLE blocks (street_id INTEGER NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "
                        "lat_lo INTEGER NOT NULL, lon_lo INTEGER NOT NULL, dlat_hi INTEGER NOT NULL, "
                        "dlon_hi INTEGER NOT NULL, PRIMARY KEY (street_id, lo)) WITHOUT ROWID")
            con.executemany("INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?)", (_block_ints(b) for b in blocks))
            # Merge each FTS index into one segment, then drop the freed pages (smaller file to ship).
            con.execute("INSERT INTO search (search) VALUES ('optimize')")
            con.execute("INSERT INTO streets (streets) VALUES ('optimize')")
            con.commit()
            con.execute("VACUUM")
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
