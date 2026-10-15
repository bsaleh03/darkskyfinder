"""Extract Overture themes clipped to a bbox, via DuckDB, with a local parquet cache."""
from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

import duckdb
import pandas as pd

from .config import OVERTURE_S3_ROOT, BBox


@dataclass(frozen=True)
class ThemeSpec:
    theme: str
    type: str
    columns: str
    geometry: str  # "wkb" -> wkb column; "point" -> lon/lat of centroid


THEMES: dict[str, ThemeSpec] = {
    "places": ThemeSpec("places", "place",
                        "id, names.primary AS name, categories.primary AS category, confidence", "point"),
    "land_use": ThemeSpec("base", "land_use", "id, names.primary AS name, subtype, class", "wkb"),
    "land_cover": ThemeSpec("base", "land_cover", "id, subtype", "wkb"),
    "water": ThemeSpec("base", "water", "id, subtype, class", "wkb"),
    "buildings": ThemeSpec("buildings", "building", "id", "point"),
    "segments": ThemeSpec("transportation", "segment",
                          "id, subtype, class, road_surface, access_restrictions", "wkb"),
    "addresses": ThemeSpec("addresses", "address", "id, number, street, postcode, address_levels", "point"),
    "division_areas": ThemeSpec("divisions", "division_area",
                                "id, names.primary AS name, subtype, country, region", "wkb"),
}


def connect() -> duckdb.DuckDBPyConnection:
    con = duckdb.connect()
    for ext in ("spatial", "httpfs"):
        con.install_extension(ext)
        con.load_extension(ext)
    con.execute("SET s3_region='us-west-2'")
    return con


def theme_glob(source_root: str, release: str, spec: ThemeSpec) -> str:
    return f"{source_root.rstrip('/')}/{release}/theme={spec.theme}/type={spec.type}/*"


def build_query(glob: str, spec: ThemeSpec, bbox: BBox) -> str:
    w, s, e, n = (float(v) for v in bbox)
    geom = ("ST_AsWKB(geometry) AS wkb" if spec.geometry == "wkb"
            else "ST_X(ST_Centroid(geometry)) AS lon, ST_Y(ST_Centroid(geometry)) AS lat")
    return (
        f"SELECT {spec.columns}, {geom} "
        f"FROM read_parquet('{glob}', hive_partitioning=false) "
        f"WHERE bbox.xmax >= {w} AND bbox.xmin <= {e} AND bbox.ymax >= {s} AND bbox.ymin <= {n}"
    )


def extract_theme(con: duckdb.DuckDBPyConnection, key: str, bbox: BBox, release: str,
                  source_root: str = OVERTURE_S3_ROOT, cache_dir: Path | None = None) -> pd.DataFrame:
    spec = THEMES[key]
    cache = Path(cache_dir) / f"{key}.parquet" if cache_dir is not None else None
    if cache is not None and cache.exists():
        return pd.read_parquet(cache)
    df = con.execute(build_query(theme_glob(source_root, release, spec), spec, bbox)).df()
    if cache is not None:
        cache.parent.mkdir(parents=True, exist_ok=True)
        df.to_parquet(cache, index=False)
    return df
