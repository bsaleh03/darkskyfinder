"""Builds a tiny fake data directory (one metro, 'test') for API tests."""
from __future__ import annotations

import json
import math
import sqlite3
from pathlib import Path

import numpy as np
from pyproj import Transformer

from darksky_api.config import MetroInfo

TEST_METRO = MetroInfo("test", "Test Metro", (-84.40, 41.75, -84.00, 42.05), (-84.20, 41.90), 9.0,
                       "America/Detroit", "Testville", "US", "US-MI")
CITY = (-84.05, 42.00)
HUDSON = (-84.25, 41.83)
EPSG = 32617
RES = 500.0


def make_spot(id_, name, lon, lat, sqm, badge="check_hours", horizon="partial", penalty=0.0,
              unavailable=False, display_name=None, area=None,
              country="US", recommended=False, sources=None, region="US-MI", entry=None):
    return {
        "id": id_, "name": name, "display_name": display_name or name, "area": area, "country": country, "region": region,
        "recommended": recommended, "sources": sources or [],
        "category": "park", "lon": lon, "lat": lat, "entry": entry, "sqm": sqm, "bortle": 4,
        "sky_label": "Milky Way vivid" if sqm >= 21.3 else "Milky Way not visible",
        "radiance": 0.2,
        "glare": {"buildings_1km": 0, "highway_m": None, "penalty": penalty},
        "horizon": {"class": horizon, "open_frac": 0.5, "closed_frac": 0.1, "water_frac": 0.0},
        "access": {"badge": badge, "road_class": "tertiary", "paved": True, "parking": False, "note": None},
        "dark_sky_place": False, "unavailable": unavailable,
        "unavailable_reason": "Closed for repairs" if unavailable else None,
        "amenities": {"restroom": None, "fuel": None, "food": None},
        "why": [],
    }


SPOTS = [
    make_spot("sp_hudson", "Lake Hudson", -84.25, 41.83, 21.6, "verified", "open", 0.01),
    make_spot("sp_camp", "Pine Campground", -84.15, 41.78, 21.4, "likely", "enclosed", 0.0),
    make_spot("sp_city", "Downtown Park", -84.05, 42.00, 18.2, "check_hours", "partial", 0.7),
    make_spot("sp_closed", "Closed Preserve", -84.30, 41.95, 21.5, "check_hours", "open", 0.0, unavailable=True),
    make_spot("sp_far", "Far Ridge", -84.39, 42.04, 21.7, "check_hours", "open", 0.0),
]

# Not part of SPOTS (keeps the base expectations stable); tests add it explicitly.
CA_SPOT = make_spot("sp_ca", "Maple Provincial Park", -84.10, 41.95, 21.6, "verified", "open", 0.0, country="CA", region="CA-ON")
OH_SPOT = make_spot("sp_oh", "Ohio Preserve", -84.12, 41.97, 21.6, "verified", "open", 0.0, region="US-OH")

SEARCH_ROWS = [
    ("Testville", "locality", 42.00, -84.05),
    ("Lake Hudson Recreation Area", "place", 41.83, -84.25),
    ("O'Neill Park", "place", 41.90, -84.10),
]


# Compact address index, same schema as the pipeline's search_index.build_search_index:
# streets (id, normalized text, display) and blocks (street_id, lo, hi, lo point, hi point) in degrees.
STREETS = [
    (0, "main st testville mi 49999", "Main St, Testville"),
    (1, "n main st hudson mi 49247", "N Main St, Hudson"),
    (2, "lakeview rd testville mi 49999", "Lakeview Rd, Testville"),
]
BLOCKS = [
    (0, 100, 198, 42.0, -84.05, 42.001, -84.052),
    (0, 200, 250, 42.002, -84.053, 42.003, -84.054),
    (1, 1000, 1090, 41.85, -84.35, 41.86, -84.35),
    (2, 7, 7, 41.86, -84.25, 41.86, -84.25),
]


def write_address_tables(con: sqlite3.Connection, streets=STREETS, blocks=BLOCKS) -> None:
    con.execute("CREATE VIRTUAL TABLE streets USING fts5(text, content='', detail=none, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.execute("CREATE TABLE street_names (id INTEGER PRIMARY KEY, display TEXT NOT NULL)")
    for sid, text, display in streets:
        con.execute("INSERT INTO streets (rowid, text) VALUES (?, ?)", (sid, text))
        con.execute("INSERT INTO street_names (id, display) VALUES (?, ?)", (sid, display))
    con.execute("CREATE TABLE blocks (street_id INTEGER NOT NULL, lo INTEGER NOT NULL, hi INTEGER NOT NULL, "
                "lat_lo INTEGER NOT NULL, lon_lo INTEGER NOT NULL, dlat_hi INTEGER NOT NULL, "
                "dlon_hi INTEGER NOT NULL, PRIMARY KEY (street_id, lo)) WITHOUT ROWID")
    e5 = lambda v: round(v * 1e5)  # noqa: E731
    con.executemany("INSERT INTO blocks VALUES (?, ?, ?, ?, ?, ?, ?)",
                    [(sid, lo, hi, e5(alo), e5(olo), e5(ahi) - e5(alo), e5(ohi) - e5(olo))
                     for sid, lo, hi, alo, olo, ahi, ohi in blocks])


def _write_grid(path: Path) -> None:
    fwd = Transformer.from_crs(4326, EPSG, always_xy=True)
    w, s, e, n = TEST_METRO.bbox
    xs, ys = fwd.transform([w, e, w, e], [s, s, n, n])
    x0, y0 = math.floor(min(xs) / RES) * RES, math.ceil(max(ys) / RES) * RES
    cols = math.ceil((max(xs) - x0) / RES)
    rows = math.ceil((y0 - min(ys)) / RES)
    sqm = np.full((rows, cols), 21.5, dtype=np.float32)
    cx, cy = fwd.transform(*CITY)
    yy, xx = np.mgrid[0:rows, 0:cols]
    cell_x = x0 + (xx + 0.5) * RES
    cell_y = y0 - (yy + 0.5) * RES
    sqm[np.hypot(cell_x - cx, cell_y - cy) <= 3_000] = 18.0
    np.savez_compressed(path, sqm=sqm, meta=np.array([x0, y0, RES, EPSG], dtype=np.float64))


def _write_search(path: Path) -> None:
    con = sqlite3.connect(path)
    con.execute("CREATE VIRTUAL TABLE search USING fts5(name, kind UNINDEXED, lat UNINDEXED, lon UNINDEXED, "
                "tokenize='unicode61 remove_diacritics 2')")
    con.executemany("INSERT INTO search (name, kind, lat, lon) VALUES (?, ?, ?, ?)", SEARCH_ROWS)
    write_address_tables(con)
    con.commit()
    con.close()


def build_data_dir(root: Path, spots=None, schema_version: int = 5) -> Path:
    d = root / TEST_METRO.key
    d.mkdir(parents=True, exist_ok=True)
    doc = {"schema_version": schema_version, "metro": "test", "release": "2099-01-01.0",
           "generated_at": "2026-10-16T00:00:00Z", "spots": SPOTS if spots is None else spots}
    (d / "spots_test.json").write_text(json.dumps(doc), encoding="utf-8")
    _write_grid(d / "darkness_test.npz")
    _write_search(d / "search_test.sqlite")
    return root
