# Dark Sky Finder — data pipeline

Turns a pinned Overture release + a VIIRS night-lights GeoTIFF into per-metro data files.

## Setup

```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev,tiles]"   # macOS/Linux: .venv/bin/python
```

Also install the `pmtiles` CLI (https://github.com/protomaps/go-pmtiles/releases) and put it on PATH.

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
`lightpollution_<metro>.pmtiles`, `basemap_<metro>_<theme>.pmtiles`.
Use `--skip-tiles` for fast iterations and `--no-strict` to see failing checks without aborting.

## Tools

- `python -m darksky_pipeline.probe categories --metro se_mi --release <R>` — place categories present
- `python -m darksky_pipeline.probe find --metro se_mi --release <R> --name "Lake Hudson"` — GERS IDs for curation
- `python -m darksky_pipeline.probe sky --npz out/se_mi/darkness_se_mi.npz --point "Royal Oak,-83.1446,42.4895"`

## Curation

`curated/<metro>.yaml` — keyed by GERS ID: `verified`, `dark_sky_place`, `access_note`,
`unavailable` + `unavailable_reason`. Unknown IDs are reported after each build.

## Tests

```bash
.venv/Scripts/python -m pytest
```
