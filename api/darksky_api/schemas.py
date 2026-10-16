"""Response models (documented in /docs; validate the service output shape)."""
from __future__ import annotations

from pydantic import BaseModel, ConfigDict


class Region(BaseModel):
    key: str
    name: str
    bbox: list[float]
    center: list[float]
    zoom: float
    timezone: str


class SearchHit(BaseModel):
    name: str
    kind: str
    lat: float
    lon: float
    metro: str


class Health(BaseModel):
    ok: bool
    metros: list[str]
    release: str


class Window(BaseModel):
    start: str
    end: str


class Moon(BaseModel):
    illumination: float
    rise: str | None
    set: str | None


class Dark(BaseModel):
    start: str
    end: str
    kind: str


class Verdict(BaseModel):
    rating: str
    sentence: str
    best_window: Window | None
    moon: Moon
    dark: Dark


class Start(BaseModel):
    lat: float
    lon: float
    sqm: float | None
    sky_label: str | None


class Scores(BaseModel):
    site: int
    conditions: int
    best_view: int
    relevant: int


class TimelineHour(BaseModel):
    time: str
    quality: float
    cloud: float | None
    fog: bool
    moon_up: bool


class Spot(BaseModel):
    model_config = ConfigDict(extra="allow")
    id: str
    name: str
    display_name: str
    area: str | None
    lon: float
    lat: float
    sqm: float
    unavailable: bool
    drive_minutes: int
    drive_is_estimate: bool
    darker_than_home: str
    scores: Scores | None
    timeline: list[TimelineHour]
    best_window: Window | None


class SpotsResponse(BaseModel):
    metro: str
    night: str
    timezone: str
    start: Start
    verdict: Verdict
    forecast_status: str
    drive_status: str
    spots: list[Spot]
