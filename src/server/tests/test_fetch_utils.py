import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from fetch_utils import FetchTracker, retry_get, _is_waf_challenge


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


# ── retry_get must NOT retry a WAF challenge response (2026-08-27) ──────────────────
# trendlyne-midweek had an 83% failure rate with the 110-request cap_to_run_budget()
# already active: every WAF-blocked symbol still paid retry_get's full 3 attempts before
# FetchTracker's circuit breaker counted it as one failure, so 20 consecutive fails could
# burn up to 60 of the 110-request allowance on responses that were never going to succeed.

class _FakeResponse:
    def __init__(self, status_code, headers=None):
        self.status_code = status_code
        self.headers = headers or {}

    def raise_for_status(self):
        if self.status_code >= 400:
            import requests
            exc = requests.exceptions.HTTPError(f"HTTP {self.status_code}")
            exc.response = self
            raise exc


class _FakeSession:
    """Returns a fixed sequence of responses, one per .get() call, so tests can assert
    exactly how many attempts retry_get made."""
    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0

    def get(self, url, **kwargs):
        self.calls += 1
        return self._responses[self.calls - 1]


def test_is_waf_challenge_true_for_response_carrying_the_waf_header():
    exc = Exception("HTTP 405")
    exc.response = _FakeResponse(405, headers={"x-amzn-waf-action": "captcha"})
    assert _is_waf_challenge(exc) is True


def test_is_waf_challenge_false_for_an_ordinary_http_error():
    exc = Exception("HTTP 500")
    exc.response = _FakeResponse(500, headers={})
    assert _is_waf_challenge(exc) is False


def test_is_waf_challenge_false_when_exception_has_no_response_at_all():
    # e.g. a raw requests.exceptions.ConnectionError with no response object
    assert _is_waf_challenge(Exception("connection reset")) is False


def test_retry_get_does_not_retry_a_waf_challenge():
    session = _FakeSession([_FakeResponse(405, headers={"x-amzn-waf-action": "captcha"})])
    with pytest.raises(Exception):
        retry_get(session, "https://trendlyne.com/x", retries=3, backoff_base=0.01)
    assert session.calls == 1, (
        "a WAF-challenge response must fail fast on the first attempt -- retrying it only "
        "burns more of the run's request allowance for a response that will not self-clear"
    )


def test_retry_get_still_retries_an_ordinary_failure():
    # First two calls fail with a plain error, third succeeds -- normal transient-failure
    # retries (network blips, a genuine 500) must be unaffected by the WAF short-circuit.
    ok = _FakeResponse(200)
    session = _FakeSession([_FakeResponse(500), _FakeResponse(500), ok])
    resp = retry_get(session, "https://example.com/x", retries=3, backoff_base=0.01)
    assert resp is ok
    assert session.calls == 3
