import os, sys
SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)
from url_explorer.normalizer import EndpointTemplate, ParamSpec
from url_explorer.fetcher import fetch_all

def _ep(urls):
    return EndpointTemplate("t", "h", "/p/", ["x"], "GET",
                            [ParamSpec("x", "query", "int_id", True, len(urls), [])], urls)

def test_fetches_every_url_via_injected_fn():
    seen = []
    def fn(url):
        seen.append(url)
        return 200, '{"ok":1}', "application/json"
    results = fetch_all([_ep(["a", "b", "c"])], fetch_fn=fn, delay=0)
    assert seen == ["a", "b", "c"]
    assert all(r.ok for r in results)

def test_max_per_endpoint_caps_fetches():
    def fn(url):
        return 200, "{}", "application/json"
    results = fetch_all([_ep(["a", "b", "c", "d"])], fetch_fn=fn, max_per_endpoint=2, delay=0)
    assert len(results) == 2

def test_failure_is_isolated_and_marked():
    def fn(url):
        if url == "b":
            raise RuntimeError("boom")
        return 200, "{}", "application/json"
    results = fetch_all([_ep(["a", "b", "c"])], fetch_fn=fn, delay=0)
    by_url = {r.url: r for r in results}
    assert by_url["a"].ok and by_url["c"].ok
    assert by_url["b"].ok is False and "boom" in by_url["b"].error

def test_circuit_breaker_stops_endpoint_after_consecutive_failures():
    calls = []
    def fn(url):
        calls.append(url)
        return 405, None, "text/html"
    results = fetch_all([_ep([str(i) for i in range(20)])],
                        fetch_fn=fn, delay=0, max_consec_fail=5)
    assert len(calls) == 5  # tripped, stopped early
    assert all(not r.ok for r in results)
