from datetime import date, datetime, timedelta

from darksky_api.forecast import HourWeather
from darksky_api.routing import estimate_minutes, haversine_km


class FakeRouting:
    def __init__(self, minutes=None, estimate=False):
        self.minutes = minutes
        self.estimate = estimate
        self.calls = []

    def drive_minutes(self, start, dests):
        self.calls.append((start, [d[0] for d in dests]))
        if self.minutes is None:
            return {i: estimate_minutes(haversine_km(start[0], start[1], lon, lat)) for i, lon, lat in dests}, self.estimate
        return {i: self.minutes[i] for i, _, _ in dests if i in self.minutes}, self.estimate


class FakeForecast:
    def __init__(self, cloud=10.0, low=0.0, vis=24000.0, fail=False, fail_cells=()):
        self.cloud, self.low, self.vis, self.fail, self.fail_cells = cloud, low, vis, fail, set(fail_cells)

    def get(self, cells, tz):
        if self.fail:
            return {}
        hours = {}
        t = datetime(2026, 10, 10, 0, 0)
        while t < datetime(2026, 10, 25, 0, 0):
            hours[t.strftime("%Y-%m-%dT%H:00")] = HourWeather(self.cloud, self.low, self.vis)
            t += timedelta(hours=1)
        return {c: hours for c in cells if c not in self.fail_cells}


def fixed_today(_tz):
    return date(2026, 10, 16)
