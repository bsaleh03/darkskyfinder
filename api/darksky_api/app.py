"""FastAPI routes. Run: uvicorn darksky_api.app:build_default_app --factory"""
from __future__ import annotations

import logging
import os
from datetime import date
from typing import Callable, Literal

import httpx
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from . import config
from .config import Settings, load_settings
from .data import DataStore
from .forecast import ForecastClient
from .ratelimit import SlidingWindowLimiter
from .routing import RoutingClient
from .schemas import Health, Region, SearchHit, SpotsResponse
from .search import search
from .service import QueryError, SpotsQuery, find_spots

log = logging.getLogger("darksky_api")


def _client_ip(request: Request) -> str:
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        parts = [p.strip() for p in fwd.split(",")]
        if len(parts) >= config.TRUSTED_PROXY_HOPS and parts[-config.TRUSTED_PROXY_HOPS]:
            return parts[-config.TRUSTED_PROXY_HOPS]
    return request.client.host if request.client else "unknown"


def create_app(store: DataStore, routing, forecast, settings: Settings,
               limiter: SlidingWindowLimiter | None = None,
               today: Callable[[str], date] | None = None) -> FastAPI:
    app = FastAPI(title="Dark Sky Finder API", version="0.1.0")
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_methods=["GET"],
                       allow_headers=["*"])
    limiter = limiter or SlidingWindowLimiter(config.RATE_LIMIT_PER_MIN)

    @app.exception_handler(QueryError)
    async def _query_error(_: Request, exc: QueryError):
        return JSONResponse(status_code=422, content={"error": exc.code, **exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"error": "invalid_request",
                                                      "detail": [e.get("loc") for e in exc.errors()]})

    @app.exception_handler(Exception)
    async def _internal(_: Request, exc: Exception):
        log.exception("unhandled error")
        return JSONResponse(status_code=500, content={"error": "internal"})

    @app.get("/api/health", response_model=Health)
    def health():
        return {"ok": True, "metros": sorted(store.metros), "release": store.release}

    @app.get("/api/regions", response_model=list[Region])
    def regions():
        return [{"key": m.info.key, "name": m.info.name, "bbox": list(m.info.bbox), "center": list(m.info.center),
                 "zoom": m.info.zoom, "timezone": m.info.timezone} for _, m in sorted(store.metros.items())]

    @app.get("/api/search", response_model=list[SearchHit])
    def search_route(q: str = Query("", max_length=100), metro: str | None = None,
                     limit: int = Query(8, ge=1, le=20)):
        return search(store, q, metro=metro, limit=limit)

    @app.get("/api/spots", response_model=SpotsResponse)
    def spots(request: Request,
              lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
              night: date | None = None,
              max_drive: int = Query(config.DEFAULT_MAX_DRIVE, ge=config.MIN_MAX_DRIVE, le=config.MAX_MAX_DRIVE),
              access: Literal["all", "likely", "verified"] = "all",
              sort: Literal["relevant", "closest", "best_view"] = "relevant",
              limit: int = Query(config.DEFAULT_LIMIT, ge=1, le=config.MAX_LIMIT)):
        if not limiter.allow(_client_ip(request)):
            return JSONResponse(status_code=429, content={"error": "rate_limited"})
        q = SpotsQuery(lat=lat, lon=lon, night=night, max_drive=max_drive, access=access, sort=sort, limit=limit)
        return find_spots(store, routing, forecast, q, today=today)

    return app


def build_default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    settings = load_settings(os.environ)
    store = DataStore.load(settings.data_dir)
    http = httpx.Client()
    return create_app(store, RoutingClient(http, settings.ors_api_key), ForecastClient(http), settings)
