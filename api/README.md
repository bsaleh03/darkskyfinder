# Dark Sky Finder — API

FastAPI service: night verdict + ranked stargazing spots for a start point, start-point search, regions.

Deployment (Render Blueprint, tiles on R2) is covered in the [root README](../README.md#deploy).

## Setup
```bash
python -m venv .venv
.venv/Scripts/python -m pip install -e ".[dev]"     # macOS/Linux: .venv/bin/python
```

## Data
Pipeline outputs are copied (never tiles) into `data/<metro>/`:
```bash
.venv/Scripts/python -m darksky_api.sync_data --from ../pipeline/out --to data
```

## Run
```bash
.venv/Scripts/uvicorn darksky_api.app:build_default_app --factory --reload
```
Put your key in `api/.env` (copy `.env.example`); it is read from the working directory at startup and
real environment variables take precedence. Settings: `ORS_API_KEY`, `ALLOWED_ORIGINS`, `TRUSTED_PROXY_HOPS`, `DATA_DIR`.
Without `ORS_API_KEY`, drive times are straight-line estimates (`drive_status: "approx"`; per spot
`drive_is_estimate`). Behind N reverse proxies set `TRUSTED_PROXY_HOPS=N` (default 1) so rate limits
(spots 20/min, search 60/min per client) key on the real client IP. `DATA_DIR` defaults to `data`.
Docs at `http://localhost:8000/docs`.

## Endpoints
`GET /api/health`, `GET /api/regions`, `GET /api/search?q=&metro=&limit=`,
`GET /api/spots?lat=&lon=&night=YYYY-MM-DD&max_drive=90&access=all|likely|verified&sort=relevant|closest|best_view&limit=25&border=include|exclude`

Search hits carry `source: "overture" | "openrouteservice"`. A query starting with a house number
("1000 Woodward Ave Royal Oak") is matched against the Overture street/block index and interpolated; those
`address` hits come first. Only an explicit search (`geocode=true`, sent when the user presses Enter or the
search button; suggestions while typing never set it) may go further: if Overture has no address, the ORS geocoder is asked (same `ORS_API_KEY`, separate
budget of 500 calls/day, 1-day cache) and only address results inside a metro are kept; any failure just
means no address hits.

`night` defaults to the night in progress (yesterday's date until dawn) and may be up to 6 days ahead.
On that night, timeline hours that already ended carry `past: true` and are not scored.

## Tests
```bash
.venv/Scripts/python -m pytest
```
