"""Post-assembly spot cleanup: merge true duplicates, add collision-only display names."""
from __future__ import annotations

import math
from collections import defaultdict

from . import config
from .spots import normalize_name

_BADGE_RANK = {"verified": 0, "likely": 1, "check_hours": 2}


def _is_curated(s: dict) -> bool:
    return (s.get("access", {}).get("badge") == "verified" or bool(s.get("dark_sky_place"))
            or bool(s.get("unavailable")) or bool(s.get("recommended")))


def _best_key(s: dict):
    return (-s["sqm"], _BADGE_RANK.get(s.get("access", {}).get("badge"), 3), s["id"])


def _dist_m(a: dict, b: dict) -> float:
    lat = math.radians((a["lat"] + b["lat"]) / 2)
    dx = math.radians(b["lon"] - a["lon"]) * math.cos(lat)
    dy = math.radians(b["lat"] - a["lat"])
    return 6_371_000 * math.hypot(dx, dy)


def merge_duplicates(spots: list[dict], radius_m: float = config.DUPLICATE_MERGE_M) -> tuple[list[dict], int]:
    """Collapse same-normalized-name spots whose viewing points chain within radius_m.

    Keeps the darkest (ties: better badge, lowest id); a curated (incl. recommended) spot always wins over uncurated.
    Returns (kept spots in input order, number removed).
    """
    by_name: dict[str, list[int]] = defaultdict(list)
    for i, s in enumerate(spots):
        n = normalize_name(s["name"])
        if n:
            by_name[n].append(i)
    dropped: set[int] = set()
    for members in by_name.values():
        if len(members) < 2:
            continue
        parent = {i: i for i in members}

        def find(i: int) -> int:
            while parent[i] != i:
                parent[i] = parent[parent[i]]
                i = parent[i]
            return i

        for x, a in enumerate(members):
            for b in members[x + 1:]:
                if _dist_m(spots[a], spots[b]) <= radius_m:
                    parent[find(a)] = find(b)
        groups: dict[int, list[int]] = defaultdict(list)
        for i in members:
            groups[find(i)].append(i)
        for g in groups.values():
            if len(g) < 2:
                continue
            pool = [i for i in g if _is_curated(spots[i])] or g
            keep = min(pool, key=lambda i: _best_key(spots[i]))
            dropped.update(i for i in g if i != keep)
    return [s for i, s in enumerate(spots) if i not in dropped], len(dropped)


def apply_display_names(spots: list[dict]) -> None:
    """Set spot['display_name'] in place: name, or 'name · area' when the name collides in the metro."""
    counts: dict[str, int] = defaultdict(int)
    area_counts: dict[tuple[str, str | None], int] = defaultdict(int)
    for s in spots:
        n = normalize_name(s["name"])
        counts[n] += 1
        area_counts[(n, s.get("area"))] += 1
    for s in spots:
        n = normalize_name(s["name"])
        area = s.get("area")
        collide = n and counts[n] > 1 and area and area_counts[(n, area)] == 1
        s["display_name"] = f"{s['name']} \u00b7 {area}" if collide else s["name"]
