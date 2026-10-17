"""Hand-curated facts about spots, keyed by Overture GERS ID."""
from __future__ import annotations

from dataclasses import dataclass, field, fields
from pathlib import Path

import yaml


@dataclass(frozen=True)
class CuratedEntry:
    id: str
    label: str = ""
    verified: bool = False
    dark_sky_place: bool = False
    access_note: str | None = None
    unavailable: bool = False
    unavailable_reason: str | None = None
    hidden: bool = False
    recommended: bool = False
    sources: list[dict] = field(default_factory=list)


_ALLOWED = {f.name for f in fields(CuratedEntry)}
_BOOL_FIELDS = ("verified", "dark_sky_place", "unavailable", "hidden", "recommended")
_STR_FIELDS = ("label",)
_OPTIONAL_STR_FIELDS = ("access_note", "unavailable_reason")


def _check_types(path: Path, raw: dict) -> None:
    for key in _BOOL_FIELDS:
        if key in raw and not isinstance(raw[key], bool):
            raise ValueError(f"{path}: entry {raw['id']} field {key} must be true/false, got {raw[key]!r}")
    for key in _STR_FIELDS:
        if key in raw and not isinstance(raw[key], str):
            raise ValueError(f"{path}: entry {raw['id']} field {key} must be a string, got {raw[key]!r}")
    for key in _OPTIONAL_STR_FIELDS:
        if key in raw and raw[key] is not None and not isinstance(raw[key], str):
            raise ValueError(f"{path}: entry {raw['id']} field {key} must be a string or null, got {raw[key]!r}")


def _check_sources(path: Path, raw: dict) -> None:
    if "sources" not in raw:
        return
    where = f"{path}: entry {raw['id']} field sources"
    src = raw["sources"]
    if not isinstance(src, list):
        raise ValueError(f"{where} must be a list of {{name, url}}, got {src!r}")
    for item in src:
        if (not isinstance(item, dict) or set(item) != {"name", "url"}
                or not isinstance(item["name"], str) or not item["name"].strip()
                or not isinstance(item["url"], str) or not item["url"].startswith("http")):
            raise ValueError(f"{where} items must be {{name: non-empty string, url: http(s) URL}}, got {item!r}")


def load_curated(path: Path) -> dict[str, CuratedEntry]:
    path = Path(path)
    if not path.exists():
        return {}
    data = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    out: dict[str, CuratedEntry] = {}
    for i, raw in enumerate(data.get("spots") or []):
        if not isinstance(raw, dict) or not raw.get("id"):
            raise ValueError(f"{path}: entry {i} is missing an id")
        unknown = set(raw) - _ALLOWED
        if unknown:
            raise ValueError(f"{path}: entry {raw['id']} has unknown keys {sorted(unknown)}")
        _check_types(path, raw)
        _check_sources(path, raw)
        entry = CuratedEntry(**{**raw, "id": str(raw["id"])})
        if entry.id in out:
            raise ValueError(f"{path}: duplicate id {entry.id}")
        out[entry.id] = entry
    return out
