"""Load pipeline outputs per metro at startup."""
from __future__ import annotations

import json
from dataclasses import dataclass
from pathlib import Path

from .config import METROS, SCHEMA_VERSION, MetroInfo
from .grid import DarknessGrid


class DataError(RuntimeError):
    pass


@dataclass
class MetroData:
    info: MetroInfo
    release: str
    spots: list[dict]
    grid: DarknessGrid
    search_path: Path


class DataStore:
    def __init__(self, metros: dict[str, MetroData]) -> None:
        self.metros = metros

    @property
    def release(self) -> str:
        releases = sorted({m.release for m in self.metros.values()})
        return ",".join(releases)

    def metro_for(self, lon: float, lat: float) -> MetroData | None:
        for key in sorted(self.metros):
            w, s, e, n = self.metros[key].info.bbox
            if w <= lon <= e and s <= lat <= n:
                return self.metros[key]
        return None

    @classmethod
    def load(cls, data_dir: Path, metros: dict[str, MetroInfo] = METROS) -> "DataStore":
        loaded: dict[str, MetroData] = {}
        for key, info in metros.items():
            d = Path(data_dir) / key
            files = {k: d / f"{k}_{key}.{ext}" for k, ext in
                     (("spots", "json"), ("darkness", "npz"), ("search", "sqlite"))}
            missing = [str(p) for p in files.values() if not p.exists()]
            if missing:
                raise DataError(f"metro {key}: missing data files {missing}")
            doc = json.loads(files["spots"].read_text(encoding="utf-8"))
            if doc.get("schema_version") != SCHEMA_VERSION:
                raise DataError(f"metro {key}: spots schema_version {doc.get('schema_version')} != {SCHEMA_VERSION}")
            loaded[key] = MetroData(info=info, release=str(doc.get("release", "")), spots=list(doc["spots"]),
                                    grid=DarknessGrid.load(files["darkness"]), search_path=files["search"])
        return cls(loaded)
