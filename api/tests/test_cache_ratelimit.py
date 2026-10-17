from darksky_api.cache import TTLCache
from darksky_api.ratelimit import SlidingWindowLimiter


class Clock:
    def __init__(self):
        self.t = 0.0

    def __call__(self):
        return self.t


def test_ttl_cache_expires():
    clock = Clock()
    c = TTLCache(10, clock=clock)
    c.set("a", 1)
    assert c.get("a") == 1
    clock.t = 10.5
    assert c.get("a") is None


def test_ttl_cache_evicts_oldest_when_full():
    c = TTLCache(100, maxsize=2, clock=Clock())
    c.set("a", 1)
    c.set("b", 2)
    c.set("c", 3)
    assert c.get("a") is None and c.get("b") == 2 and c.get("c") == 3
    assert len(c) == 2


def test_limiter_allows_then_blocks_then_recovers():
    clock = Clock()
    lim = SlidingWindowLimiter(2, window_s=60, clock=clock)
    assert lim.allow("ip") and lim.allow("ip")
    assert not lim.allow("ip")
    assert lim.allow("other")
    clock.t = 61
    assert lim.allow("ip")


def test_limiter_bounds_tracked_keys_and_drops_empty():
    lim = SlidingWindowLimiter(2, max_keys=5, clock=Clock())
    for i in range(100):
        lim.allow(f"ip{i}")
        assert len(lim._hits) <= 5
    zero = SlidingWindowLimiter(0, clock=Clock())
    assert not zero.allow("x") and len(zero._hits) == 0


def test_limiter_thread_safe():
    import threading
    lim = SlidingWindowLimiter(10)
    results = []
    barrier = threading.Barrier(50)

    def work():
        barrier.wait()
        results.append(lim.allow("k"))

    ts = [threading.Thread(target=work) for _ in range(50)]
    [t.start() for t in ts]
    [t.join() for t in ts]
    assert results.count(True) == 10
