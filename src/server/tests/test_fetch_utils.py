import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from fetch_utils import FetchTracker


# ── abort_after_consecutive_fails circuit breaker (2026-08-13) ──────────────────
# Added after trendlyne_price_analysis_fetcher.py spent ~52min/run grinding through ~2234
# stocks that were 100% WAF-blocked from item 1, every ~30-90min via the catch-up retry loop,
# until the outer runPython timeout SIGKILLed it. Default (unset) must stay a no-op so the
# ~15 other FetchTracker callers are unaffected.

def test_default_tracker_never_aborts_on_failures():
    tracker = FetchTracker("job")
    for i in range(100):
        tracker.record(f"item{i}", ok=False)
    assert tracker.total == 100
    assert len(tracker.failed) == 100


def test_breaker_fires_after_n_consecutive_fails():
    tracker = FetchTracker("job", abort_after_consecutive_fails=5)
    for i in range(4):
        tracker.record(f"item{i}", ok=False)
    with pytest.raises(SystemExit) as exc:
        tracker.record("item4", ok=False)
    assert exc.value.code == 1


def test_a_success_resets_the_consecutive_counter():
    tracker = FetchTracker("job", abort_after_consecutive_fails=5)
    for i in range(4):
        tracker.record(f"fail{i}", ok=False)
    tracker.record("ok", ok=True)  # resets the streak
    for i in range(4):
        tracker.record(f"fail{i}", ok=False)  # only 4 more in a row -- must not trip yet
    assert tracker.total == 9
