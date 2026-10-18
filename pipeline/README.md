# Dark Sky Finder — data pipeline

Turns a pinned Overture release + a VIIRS night-lights GeoTIFF into per-metro data files.

## Setup

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"   # macOS/Linux: .venv/bin/python
```

Also install the `pmtiles` CLI (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH.
A build without `--skip-tiles` checks for `pmtiles` before doing any work and stops with an error if it is missing.

## Inputs

- **Overture release** — list available releases:
  `python -m darksky_pipeline.probe releases`
- **VIIRS** — annual VIIRS Nighttime Lights (VNL v2, "average-masked" GeoTIFF, EPSG:4326) from
  https://eogdata.mines.edu/products/vnl/ (free account required; download manually).
  Place it at `data/viirs/vnl_annual.tif`. The pipeline reads only a window around each metro.

## Run

```bash
python -m darksky_pipeline.build --metro se_mi --release <R> --viirs data/viirs/vnl_annual.tif
python -m darksky_pipeline.build --metro bay_area --release <R> --viirs data/viirs/vnl_annual.tif
```

Outputs land in `out/<metro>/`: `spots_<metro>.json`, `darkness_<metro>.npz`, `search_<metro>.sqlite`,
`basemap_<metro>_<theme>.pmtiles`.
Use `--skip-tiles` for fast iterations and `--no-strict` to see failing checks without aborting.
Sanity checks run before the tile step, so a failing strict build stops before the slow tile extraction.

## Tools

- `python -m darksky_pipeline.probe categories --metro se_mi --release <R>` — place categories present
- `python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "Lake Hudson"` — GERS IDs for curation
  (land use is extracted for park subtypes only, so only park-like polygons are searched)
- `python -m darksky_pipeline.probe sky --npz out/se_mi/darkness_se_mi.npz --point "Royal Oak,-83.1446,42.4895"`

## Curation

`curated/<metro>.yaml` — keyed by GERS ID: `verified`, `dark_sky_place`, `access_note`,
`unavailable` + `unavailable_reason`, `hidden` (drops bad/misplaced Overture records entirely),
`recommended` + `sources`. Three distinct tiers, do not conflate them:
`recommended` = editorial rankings (best-of lists); set it only with `sources: [{name, url}]` citing them (adds a "Recommended" chip);
`verified` = documented night/after-dark access (drives the access badge);
`dark_sky_place` = an official designation (e.g. IDA). Unknown IDs are reported after each build; wrong field types are an error.
An explicit `--curated <file>` that does not exist is an error; a missing default `curated/<metro>.yaml`
only logs a warning.

## Tests

```bash
.venv/Scripts/python -m pytest
```
