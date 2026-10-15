"""Builds a tiny fake Overture release (GeoParquet via DuckDB) for tests.

Layout mirrors S3: <root>/<release>/theme=<theme>/type=<type>/part-0.parquet
"""
from __future__ import annotations

from pathlib import Path

import duckdb

RELEASE = "2099-01-01.0"
REGION_BBOX = (-84.40, 41.75, -84.00, 42.05)
TEST_EPSG = 32617
CITY = (-84.05, 42.00)
HUDSON = (-84.25, 41.83)

PLACES = [
    # id, name, category, confidence, lon, lat
    ("pl_hudson", "Lake Hudson Recreation Area", "park", 0.95, -84.25, 41.83),
    ("pl_hudson_launch", "Lake Hudson Boat Launch", "boat_launch", 0.80, -84.24, 41.82),
    ("pl_city", "Downtown Park", "park", 0.90, -84.05, 42.00),
    ("pl_camp", "Pine Campground", "campground", 0.90, -84.15, 41.78),
    ("pl_noname", None, "park", 0.90, -84.10, 41.80),
    ("pl_lowconf", "Sketchy Park", "park", 0.30, -84.12, 41.90),
    ("pl_cafe", "Moon Cafe", "restaurant", 0.90, -84.20, 41.84),
    ("pl_gas", "Hudson Fuel", "gas_station", 0.90, -84.26, 41.86),
    ("pl_lot", "Hudson Lot", "parking", 0.90, -84.27, 41.815),
    ("pl_out", "Far Away Park", "park", 0.90, -86.00, 43.00),
]

LAND_USE = [
    # id, name, subtype, class, wkt
    ("lu_hudson", "Lake Hudson Recreation Area", "recreation", "recreation_area",
     "POLYGON((-84.28 41.81, -84.22 41.81, -84.22 41.85, -84.28 41.85, -84.28 41.81))"),
    ("lu_city", "Downtown Park", "park", "park",
     "POLYGON((-84.06 41.99, -84.04 41.99, -84.04 42.01, -84.06 42.01, -84.06 41.99))"),
    ("lu_woods", "Hidden Woods Preserve", "protected", "nature_reserve",
     "POLYGON((-84.35 41.95, -84.33 41.95, -84.33 41.97, -84.35 41.97, -84.35 41.95))"),
    ("lu_tiny", None, "park", "park",
     "POLYGON((-84.300 41.900, -84.299 41.900, -84.299 41.901, -84.300 41.901, -84.300 41.900))"),
    ("lu_out", "Far Away Forest", "protected", "forest",
     "POLYGON((-86.1 43.0, -86.0 43.0, -86.0 43.1, -86.1 43.1, -86.1 43.0))"),
    # Not a park subtype: filtered out in the extract SQL (I5).
    ("lu_resi", "Sunny Acres", "residential", "residential",
     "POLYGON((-84.38 41.76, -84.36 41.76, -84.36 41.78, -84.38 41.78, -84.38 41.76))"),
]

LAND_COVER = [
    ("lc_grass", "grass", "POLYGON((-84.32 41.80, -84.18 41.80, -84.18 41.87, -84.32 41.87, -84.32 41.80))"),
    ("lc_forest", "forest", "POLYGON((-84.17 41.77, -84.13 41.77, -84.13 41.79, -84.17 41.79, -84.17 41.77))"),
]

WATER = [
    ("w_lake", "lake", "lake",
     "POLYGON((-84.255 41.825, -84.235 41.825, -84.235 41.84, -84.255 41.84, -84.255 41.825))"),
]

SEGMENTS = [
    # id, subtype, class, surface, access_type, wkt
    ("rd_hudson", "road", "tertiary", "paved", None, "LINESTRING(-84.30 41.83, -84.20 41.83)"),
    ("rd_city", "road", "residential", "paved", None, "LINESTRING(-84.07 42.00, -84.03 42.00)"),
    ("rd_camp", "road", "track", "unpaved", None, "LINESTRING(-84.16 41.78, -84.14 41.78)"),
    ("rd_highway", "road", "motorway", "paved", None, "LINESTRING(-84.10 41.75, -84.10 42.05)"),
    ("rd_footway", "road", "footway", "paved", None, "LINESTRING(-84.34 41.955, -84.34 41.965)"),
    ("rd_private", "road", "service", None, "denied", "LINESTRING(-84.345 41.96, -84.335 41.96)"),
    # Not a road: filtered out in the extract SQL (I5).
    ("rd_rail", "rail", "standard_gauge", None, None, "LINESTRING(-84.39 41.76, -84.39 42.04)"),
]

ADDRESSES = [
    # id, number, street, postcode, locality, lon, lat
    ("ad_1", "101", "Main St", "49999", "Testville", -84.051, 42.001),
    ("ad_2", "7", "Lakeview Rd", "49998", "Hudson Township", -84.25, 41.86),
]

DIVISION_AREAS = [
    ("div_testville", "Testville", "locality", "US", "US-MI",
     "POLYGON((-84.08 41.98, -84.02 41.98, -84.02 42.02, -84.08 42.02, -84.08 41.98))"),
    # Not a searchable division subtype: filtered out in the extract SQL (I5).
    ("div_region", "Testregion", "region", "US", "US-MI",
     "POLYGON((-84.39 41.76, -84.01 41.76, -84.01 42.04, -84.39 42.04, -84.39 41.76))"),
]


def _q(s: str | None) -> str:
    return "NULL::VARCHAR" if s is None else "'" + s.replace("'", "''") + "'"


def _with_bbox(inner: str) -> str:
    return (
        "SELECT *, {'xmin': ST_XMin(geometry), 'xmax': ST_XMax(geometry), "
        "'ymin': ST_YMin(geometry), 'ymax': ST_YMax(geometry)} AS bbox FROM (" + inner + ")"
    )


def _write(con: duckdb.DuckDBPyConnection, root: Path, theme: str, type_: str, inner: str) -> None:
    d = root / RELEASE / f"theme={theme}" / f"type={type_}"
    d.mkdir(parents=True, exist_ok=True)
    out = (d / "part-0.parquet").as_posix()
    con.execute(f"COPY ({_with_bbox(inner)}) TO '{out}' (FORMAT parquet)")


def build_overture_fixture(root: Path) -> None:
    con = duckdb.connect()
    con.install_extension("spatial")
    con.load_extension("spatial")

    _write(con, root, "places", "place", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, {{'primary': '{c}'}} AS categories, "
        f"{conf}::DOUBLE AS confidence, ST_Point({lon}, {lat}) AS geometry"
        for i, n, c, conf, lon, lat in PLACES))

    _write(con, root, "base", "land_use", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, '{st}' AS subtype, '{cl}' AS class, "
        f"ST_GeomFromText('{wkt}') AS geometry"
        for i, n, st, cl, wkt in LAND_USE))

    _write(con, root, "base", "land_cover", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, wkt in LAND_COVER))

    _write(con, root, "base", "water", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, '{cl}' AS class, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, cl, wkt in WATER))

    def surface_sql(v: str | None) -> str:
        return f"[{{'value': '{v}'}}]::STRUCT(value VARCHAR)[]" if v else "NULL::STRUCT(value VARCHAR)[]"

    def access_sql(v: str | None) -> str:
        return (f"[{{'access_type': '{v}'}}]::STRUCT(access_type VARCHAR)[]" if v
                else "NULL::STRUCT(access_type VARCHAR)[]")

    _write(con, root, "transportation", "segment", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{st}' AS subtype, '{cl}' AS class, {surface_sql(sf)} AS road_surface, "
        f"{access_sql(ac)} AS access_restrictions, ST_GeomFromText('{wkt}') AS geometry"
        for i, st, cl, sf, ac, wkt in SEGMENTS))

    _write(con, root, "buildings", "building",
           "SELECT 'b_city_' || i AS id, "
           "ST_Point(-84.055 + (i % 25) * 0.0004, 41.995 + (i // 25) * 0.0005) AS geometry FROM range(500) r(i) "
           "UNION ALL "
           "SELECT 'b_rural_' || i AS id, ST_Point(-84.252 + i * 0.001, 41.835) AS geometry FROM range(5) r(i)")

    _write(con, root, "addresses", "address", " UNION ALL ".join(
        f"SELECT '{i}' AS id, '{num}' AS number, '{st}' AS street, '{pc}' AS postcode, "
        f"[{{'value': 'MI'}}, {{'value': '{loc}'}}]::STRUCT(value VARCHAR)[] AS address_levels, "
        f"ST_Point({lon}, {lat}) AS geometry"
        for i, num, st, pc, loc, lon, lat in ADDRESSES))

    _write(con, root, "divisions", "division_area", " UNION ALL ".join(
        f"SELECT '{i}' AS id, {{'primary': {_q(n)}}} AS names, '{st}' AS subtype, '{c}' AS country, "
        f"'{r}' AS region, ST_GeomFromText('{wkt}') AS geometry"
        for i, n, st, c, r, wkt in DIVISION_AREAS))
    con.close()
