"""Exploration CLI: list releases, inspect categories, look up GERS IDs by name.

Usage:
  python -m darksky_pipeline.probe releases
  python -m darksky_pipeline.probe categories --metro se_mi --release <R> [--keywords park camp beach]
  python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "Lake Hudson"
"""
from __future__ import annotations

import argparse
from pathlib import Path
from typing import Iterable

import duckdb
import pandas as pd

from .config import METROS, OVERTURE_S3_ROOT
from .extract import connect, extract_theme
from .util import wkb_to_geoms

DEFAULT_KEYWORDS = ("park", "camp", "beach", "observ", "nature", "view", "boat", "parking",
                    "toilet", "restroom", "gas", "restaurant", "cafe", "coffee", "diner")


def place_categories(places: pd.DataFrame, keywords: Iterable[str]) -> pd.DataFrame:
    kws = [k.lower() for k in keywords]
    cats = places["category"].dropna()
    cats = cats[cats.map(lambda c: any(k in c.lower() for k in kws))]
    counts = cats.value_counts()
    return pd.DataFrame({"category": counts.index, "count": counts.to_numpy()})


def find_by_name(places: pd.DataFrame, land_use: pd.DataFrame, text: str) -> pd.DataFrame:
    needle = text.lower()
    p = places[places["name"].fillna("").str.lower().str.contains(needle, regex=False)]
    rows = [{"id": r.id, "name": r.name, "kind": "place", "category": r.category, "lon": r.lon, "lat": r.lat}
            for r in p.itertuples(index=False)]
    lu = land_use[land_use["name"].fillna("").str.lower().str.contains(needle, regex=False)]
    if len(lu):
        for (i, name, subtype), g in zip(lu[["id", "name", "subtype"]].itertuples(index=False),
                                          wkb_to_geoms(lu["wkb"])):
            rp = g.representative_point()
            rows.append({"id": i, "name": name, "kind": "land_use", "category": subtype, "lon": rp.x, "lat": rp.y})
    return pd.DataFrame(rows, columns=["id", "name", "kind", "category", "lon", "lat"])


def list_releases(con: duckdb.DuckDBPyConnection, root: str = OVERTURE_S3_ROOT) -> list[str]:
    root_norm = root.replace("\\", "/").rstrip("/") + "/"
    files = con.execute(f"SELECT file FROM glob('{root_norm}*/theme=divisions/type=division_area/*')").fetchall()
    releases = set()
    for (f,) in files:
        rel = f.replace("\\", "/").split(root_norm, 1)[-1]
        releases.add(rel.split("/", 1)[0])
    return sorted(releases)


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_pipeline.probe")
    sub = ap.add_subparsers(dest="cmd", required=True)
    sub.add_parser("releases")
    for name in ("categories", "find"):
        sp = sub.add_parser(name)
        sp.add_argument("--metro", choices=sorted(METROS), required=True)
        sp.add_argument("--release", required=True)
        sp.add_argument("--cache", default="data/raw")
        if name == "categories":
            sp.add_argument("--keywords", nargs="*", default=list(DEFAULT_KEYWORDS))
        else:
            sp.add_argument("--name", required=True)
    args = ap.parse_args(argv)
    con = connect()
    if args.cmd == "releases":
        print("\n".join(list_releases(con)))
        return
    metro = METROS[args.metro]
    cache = Path(args.cache) / metro.key / args.release
    places = extract_theme(con, "places", metro.bbox, args.release, cache_dir=cache)
    with pd.option_context("display.max_rows", 500, "display.width", 200):
        if args.cmd == "categories":
            print(place_categories(places, args.keywords).to_string(index=False))
        else:
            land_use = extract_theme(con, "land_use", metro.bbox, args.release, cache_dir=cache)
            print(find_by_name(places, land_use, args.name).to_string(index=False))


if __name__ == "__main__":
    main()
