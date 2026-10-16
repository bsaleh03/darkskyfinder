# Dark Sky Finder — API

FastAPI service: night verdict + ranked stargazing spots for a start point, start-point search, regions.

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
ORS_API_KEY=... ALLOWED_ORIGINS=https://your.app .venv/Scripts/uvicorn darksky_api.app:build_default_app --factory --reload
```
Without `ORS_API_KEY`, drive times are straight-line estimates (`drive_status: "approx"`).
Docs at `http://localhost:8000/docs`.

## Endpoints
`GET /api/health`, `GET /api/regions`, `GET /api/search?q=&metro=&limit=`,
`GET /api/spots?lat=&lon=&night=YYYY-MM-DD&max_drive=90&access=all|likely|verified&sort=relevant|closest|best_view&limit=25`

## Tests
```bash
.venv/Scripts/python -m pytest
```
