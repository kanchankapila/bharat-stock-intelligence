"""Regression coverage for the weekly extra-endpoint fetcher's bounded concurrency."""

import threading
import time

import extra_endpoints_fetcher as fetcher


def test_iter_fetched_tasks_bounds_worker_concurrency():
    lock = threading.Lock()
    active = 0
    peak_active = 0

    def fake_fetch(url):
        nonlocal active, peak_active
        with lock:
            active += 1
            peak_active = max(peak_active, active)
        try:
            time.sleep(0.005)
            return {"url": url, "payload": "x" * 10_000}
        finally:
            with lock:
                active -= 1

    tasks = [(f"S{i}", "endpoint", f"https://example.test/{i}") for i in range(100)]
    rows = list(fetcher.iter_fetched_tasks(
        tasks, fetch_fn=fake_fetch, max_workers=3, max_in_flight=7
    ))

    assert len(rows) == 100
    assert peak_active <= 3
    assert all(error is None and data["url"].startswith("https://")
               for _, _, data, error in rows)


def test_iter_fetched_tasks_does_not_submit_the_full_universe_up_front():
    lock = threading.Lock()
    started = 0

    def fake_fetch(_url):
        nonlocal started
        with lock:
            started += 1
        return "ok"

    tasks = [(f"S{i}", "endpoint", str(i)) for i in range(100)]
    rows = fetcher.iter_fetched_tasks(
        tasks, fetch_fn=fake_fetch, max_workers=2, max_in_flight=5
    )
    next(rows)
    time.sleep(0.02)

    # The old implementation had submitted (and retained Futures for) all 100 here.
    assert started <= 5
    rows.close()


def test_iter_fetched_tasks_isolates_one_request_failure():
    def fake_fetch(url):
        if url.endswith("/bad"):
            raise RuntimeError("provider rejected request")
        return {"ok": True}

    rows = list(fetcher.iter_fetched_tasks(
        [("GOOD", "one", "https://example.test/good"),
         ("BAD", "two", "https://example.test/bad")],
        fetch_fn=fake_fetch,
        max_workers=1,
        max_in_flight=1,
    ))

    by_symbol = {symbol: (data, error) for symbol, _, data, error in rows}
    assert by_symbol["GOOD"] == ({"ok": True}, None)
    assert by_symbol["BAD"][0] is None
    assert "provider rejected request" in str(by_symbol["BAD"][1])


def test_iter_fetched_tasks_rejects_an_invalid_window():
    try:
        list(fetcher.iter_fetched_tasks([], max_workers=4, max_in_flight=3))
    except ValueError as exc:
        assert "max_in_flight" in str(exc)
    else:
        raise AssertionError("invalid concurrency window was accepted")
