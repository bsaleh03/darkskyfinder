"""Sanity checks over a finished spots document."""
from __future__ import annotations

import math
from collections import Counter
from dataclasses import dataclass

import numpy as np

from . import config
from .config import Metro
from .darkness import DarknessGrid
from .geo import Projector


@dataclass(frozen=True)
class CheckResult:
    name: str
    ok: bool
    detail: str


class PipelineCheckError(RuntimeError):
    pass


def _finite(v) -> bool:
    return isinstance(v, (int, float)) and math.isfinite(v)


def run_checks(doc: dict, grid: DarknessGrid, metro: Metro, projector: Projector,
               count_range: tuple[int, int]) -> list[CheckResult]:
    spots = doc["spots"]
    out: list[CheckResult] = []

    lo, hi = count_range
    out.append(CheckResult("spot_count", lo <= len(spots) <= hi, f"{len(spots)} spots (expected {lo}-{hi})"))

    w, s, e, n = metro.bbox
    outside = [sp["id"] for sp in spots if not (w <= sp["lon"] <= e and s <= sp["lat"] <= n)]
    out.append(CheckResult("within_region", not outside, f"outside region: {outside[:5]}"))

    dups = sorted(i for i, c in Counter(sp["id"] for sp in spots).items() if c > 1)
    out.append(CheckResult("unique_ids", not dups, f"duplicate ids: {dups[:5]}"))

    bad = [sp["id"] for sp in spots if not _finite(sp["sqm"])]
    out.append(CheckResult("finite_sqm", not bad, f"non-finite sqm: {bad[:5]}"))

    darkest = sorted((sp["sqm"] for sp in spots if _finite(sp["sqm"])), reverse=True)[:10]
    med = float(np.median(darkest)) if darkest else math.nan
    out.append(CheckResult("top_spots_dark", bool(darkest) and med >= config.TOP_SPOTS_MIN_MEDIAN_SQM,
                           f"median sqm of darkest {len(darkest)}: {med:.2f}"))

    home = float(grid.sample(*projector.to_xy(*metro.reference_home))[0])
    verified = [sp for sp in spots if sp["access"]["badge"] == "verified"]
    too_bright = [sp["id"] for sp in verified
                  if not (_finite(sp["sqm"]) and sp["sqm"] > home + config.VERIFIED_MIN_GAIN_MAG)]
    detail = f"home {metro.reference_home_label} sqm {home:.2f}; {len(verified)} verified"
    if too_bright:
        detail += f"; not darker than home: {too_bright[:5]}"
    out.append(CheckResult("verified_darker_than_home", math.isfinite(home) and not too_bright, detail))
    return out


def assert_checks(results: list[CheckResult]) -> None:
    failed = [r for r in results if not r.ok]
    if failed:
        raise PipelineCheckError("; ".join(f"{r.name}: {r.detail}" for r in failed))
