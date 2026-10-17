"""Copy pipeline outputs (never tiles) into the API data dir.

python -m darksky_api.sync_data --from ../pipeline/out --to data
"""
from __future__ import annotations

import argparse
import json
import shutil
from pathlib import Path

from .config import METROS, SCHEMA_VERSION

MAX_FILE_BYTES = 95 * 1024 * 1024  # stay under GitHub's 100 MB per-file limit


def sync(src: Path, dst: Path, metros: list[str]) -> list[tuple[Path, int]]:
    copied: list[tuple[Path, int]] = []
    for key in metros:
        names = [f"spots_{key}.json", f"darkness_{key}.npz", f"search_{key}.sqlite"]
        files = [Path(src) / key / n for n in names]
        for f in files:
            if not f.exists():
                raise SystemExit(f"missing {f}")
            if f.stat().st_size >= MAX_FILE_BYTES:
                raise SystemExit(f"{f.name} is too large ({f.stat().st_size} bytes) for git")
        doc = json.loads(files[0].read_text(encoding="utf-8"))
        if doc.get("schema_version") != SCHEMA_VERSION:
            raise SystemExit(f"{files[0].name}: schema_version {doc.get('schema_version')} != {SCHEMA_VERSION}")
        out = Path(dst) / key
        out.mkdir(parents=True, exist_ok=True)
        for f in files:
            target = out / f.name
            shutil.copy2(f, target)
            copied.append((target, target.stat().st_size))
    return copied


def main(argv: list[str] | None = None) -> None:
    ap = argparse.ArgumentParser(prog="darksky_api.sync_data")
    ap.add_argument("--from", dest="src", default="../pipeline/out")
    ap.add_argument("--to", dest="dst", default="data")
    ap.add_argument("--metros", nargs="*", default=sorted(METROS))
    args = ap.parse_args(argv)
    for path, size in sync(Path(args.src), Path(args.dst), args.metros):
        print(f"{size / 1e6:8.1f} MB  {path}")


if __name__ == "__main__":
    main()
