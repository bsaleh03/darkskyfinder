"""FastAPI routes. Run: uvicorn darksky_api.app:build_default_app --factory"""
from __future__ import annotations

import logging
import os
from pathlib import Path
from datetime import date, datetime
from typing import Callable, Literal

import httpx
from dotenv import load_dotenv
from fastapi import FastAPI, Query, Request
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.middleware.gzip import GZipMiddleware
from fastapi.responses import JSONResponse
from starlette.types import ASGIApp, Message, Receive, Scope, Send

from . import config
from .config import Settings, load_settings
from .data import DataStore
from .forecast import ForecastClient
from .geocode import GeocodeClient
from .ratelimit import SlidingWindowLimiter
from .routing import RoutingClient
from .schemas import Health, Region, SearchHit, SpotsResponse
from .search import search
from .service import QueryError, SpotsQuery, find_spots

log = logging.getLogger("darksky_api")


def _client_ip(request: Request, hops: int) -> str:
    """Client address as seen by the outermost of `hops` trusted proxies."""
    fwd = request.headers.get("x-forwarded-for")
    if fwd:
        parts = [p.strip() for p in fwd.split(",")]
        if len(parts) >= hops and parts[-hops]:
            return parts[-hops]
    return request.client.host if request.client else "unknown"


class _CatchErrors:
    """Turn unhandled errors into the JSON 500 inside CORSMiddleware, so the
    browser can read it (Starlette's own 500 handler sits outside CORS)."""

    def __init__(self, app: ASGIApp) -> None:
        self.app = app

    async def __call__(self, scope: Scope, receive: Receive, send: Send) -> None:
        if scope["type"] != "http":
            await self.app(scope, receive, send)
            return
        started = False

        async def _send(message: Message) -> None:
            nonlocal started
            if message["type"] == "http.response.start":
                started = True
            await send(message)

        try:
            await self.app(scope, receive, _send)
        except Exception:
            log.exception("unhandled error")
            if started:
                raise
            await JSONResponse(status_code=500, content={"error": "internal"})(scope, receive, send)


def _rate_limited() -> JSONResponse:
    return JSONResponse(status_code=429, content={"error": "rate_limited"})


def create_app(store: DataStore, routing, forecast, settings: Settings,
               limiter: SlidingWindowLimiter | None = None,
               search_limiter: SlidingWindowLimiter | None = None,
               geocoder: GeocodeClient | None = None,
               today: Callable[[str], date] | None = None,
               now: Callable[[str], datetime] | None = None) -> FastAPI:
    app = FastAPI(title="Dark Sky Finder API", version="0.1.0")
    # Last added is outermost: GZip -> CORS -> error catcher -> routes.
    app.add_middleware(_CatchErrors)
    app.add_middleware(CORSMiddleware, allow_origins=list(settings.allowed_origins), allow_methods=["GET"],
                       allow_headers=["*"])
    app.add_middleware(GZipMiddleware, minimum_size=1000)
    limiter = limiter or SlidingWindowLimiter(config.RATE_LIMIT_PER_MIN)
    search_limiter = search_limiter or SlidingWindowLimiter(config.SEARCH_RATE_LIMIT_PER_MIN)
    hops = settings.trusted_proxy_hops

    @app.exception_handler(QueryError)
    async def _query_error(_: Request, exc: QueryError):
        return JSONResponse(status_code=422, content={"error": exc.code, **exc.detail})

    @app.exception_handler(RequestValidationError)
    async def _validation(_: Request, exc: RequestValidationError):
        return JSONResponse(status_code=422, content={"error": "invalid_request",
                                                      "detail": [e.get("loc") for e in exc.errors()]})

    @app.get("/api/health", response_model=Health)
    def health():
        return {"ok": True, "metros": sorted(store.metros), "release": store.release}

    @app.get("/api/regions", response_model=list[Region])
    def regions():
        return [{"key": m.info.key, "name": m.info.name, "bbox": list(m.info.bbox), "center": list(m.info.center),
                 "zoom": m.info.zoom, "timezone": m.info.timezone} for _, m in sorted(store.metros.items())]

    @app.get("/api/search", response_model=list[SearchHit])
    def search_route(request: Request, q: str = Query("", max_length=100), metro: str | None = None,
                     limit: int = Query(8, ge=1, le=20)):
        if not search_limiter.allow(_client_ip(request, hops)):
            return _rate_limited()
        return search(store, q, metro=metro, limit=limit, geocoder=geocoder)

    @app.get("/api/spots", response_model=SpotsResponse)
    def spots(request: Request,
              lat: float = Query(..., ge=-90, le=90), lon: float = Query(..., ge=-180, le=180),
              night: date | None = None,
              max_drive: int = Query(config.DEFAULT_MAX_DRIVE, ge=config.MIN_MAX_DRIVE, le=config.MAX_MAX_DRIVE),
              access: Literal["all", "likely", "verified"] = "all",
              sort: Literal["relevant", "closest", "best_view"] = "relevant",
              limit: int = Query(config.DEFAULT_LIMIT, ge=1, le=config.MAX_LIMIT),
              border: Literal["include", "exclude"] = "include",
              state_border: Literal["include", "exclude"] = "include"):
        if not limiter.allow(_client_ip(request, hops)):
            return _rate_limited()
        q = SpotsQuery(lat=lat, lon=lon, night=night, max_drive=max_drive, access=access, sort=sort, limit=limit,
                       border=border, state_border=state_border)
        return find_spots(store, routing, forecast, q, today=today, now=now)

    return app


def build_default_app() -> FastAPI:
    logging.basicConfig(level=logging.INFO)
    load_dotenv(Path.cwd() / ".env", override=False)  # real environment variables win
    settings = load_settings(os.environ)
    store = DataStore.load(settings.data_dir)
    http = httpx.Client()
    return create_app(store, RoutingClient(http, settings.ors_api_key), ForecastClient(http), settings,
                      geocoder=GeocodeClient(http, settings.ors_api_key))
