import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pytest

from fetch_utils import FetchTracker, retry_get, _is_waf_challenge, filter_stale_symbols
from pg_test_support import pg_memory_conn


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


# ── filter_stale_symbols (2026-09-04): four fetchers gate their per-symbol network loop on
# this, but the helper itself had no test at all -- added while wiring it into
# working_capital_fetcher.py / financial_ratios_fetcher.py / trendlyne_fundamentals_fetcher.py.

def _seed_freshness_table(conn, rows):
    conn.execute("CREATE TABLE t (symbol TEXT, fetched_at TEXT)")
    for sym, dt in rows:
        conn.execute("INSERT INTO t (symbol, fetched_at) VALUES (?, ?)", (sym, dt))
    conn.commit()


def test_filter_stale_symbols_skips_only_symbols_fresh_at_or_after_the_cutoff():
    conn = pg_memory_conn()
    _seed_freshness_table(conn, [("RELIANCE", "2026-09-01"), ("TCS", "2026-08-01")])
    result = filter_stale_symbols(
        conn, ["RELIANCE", "TCS", "INFY"], "t", date_col="fetched_at", as_of_date="2026-08-25",
    )
    # RELIANCE fresh (09-01 >= cutoff) -> skipped. TCS stale (08-01 < cutoff) -> kept.
    # INFY has no row at all -> kept (missing counts as stale, never silently dropped).
    assert result == ["TCS", "INFY"]


def test_filter_stale_symbols_accepts_tuple_rows_and_filters_on_the_first_element():
    conn = pg_memory_conn()
    _seed_freshness_table(conn, [("RELIANCE", "2026-09-01")])
    result = filter_stale_symbols(
        conn, [("RELIANCE", "RI"), ("TCS", "TC")], "t", date_col="fetched_at", as_of_date="2026-08-25",
    )
    assert result == [("TCS", "TC")]


def test_filter_stale_symbols_is_case_insensitive_on_symbol_matching():
    conn = pg_memory_conn()
    _seed_freshness_table(conn, [("reliance", "2026-09-01")])
    result = filter_stale_symbols(
        conn, ["RELIANCE", "TCS"], "t", date_col="fetched_at", as_of_date="2026-08-25",
    )
    assert result == ["TCS"]


def test_filter_stale_symbols_degrades_to_processing_everyone_on_a_query_error():
    class _BrokenConn:
        def cursor(self):
            raise RuntimeError("table does not exist")
    # A freshness-check failure must never silently drop symbols from the run -- fail open,
    # not closed, per this file's own except-branch comment ("processing all symbols").
    result = filter_stale_symbols(_BrokenConn(), ["RELIANCE", "TCS"], "t")
    assert result == ["RELIANCE", "TCS"]


def test_filter_stale_symbols_returns_empty_for_an_empty_input_without_querying():
    class _MustNotBeCalled:
        def cursor(self):
            raise AssertionError("filter_stale_symbols must not query the DB for an empty list")
    assert filter_stale_symbols(_MustNotBeCalled(), [], "t") == []


# ── allowance-exhausted vs failure (2026-09-05) ────────────────────────────────
# trendlyne-midweek had a 48/58 lifetime failure rate and was the platform's noisiest job.
# Measured live: the run WORKS -- it wrote 6,325 rows and its own log says "Resuming: 106 of
# 2234 already fetched, 2128 remaining" -- and then exits non-zero because FetchTracker counts
# the WAF-blocked tail as failures and trips its 15% threshold.
#
# That is a misclassification, not a bug in the fetcher. Trendlyne enforces a cumulative
# REQUEST ALLOWANCE (see resume_order() in so_option_chain_fetcher.py for the same vendor
# behaviour measured from the other side): when it ends, the vendor is saying "no more this
# run", which is the slice finishing -- not 2,128 individual fetch failures. The fetchers
# already resume from the DB, so a blocked tail converges over successive runs. The repo's own
# cap_to_run_budget comment already says "a partial run here is normal, not a failure"; the
# tracker simply never learned that.
#
# The guard that keeps this honest: a run that achieved NOTHING still exits non-zero. Progress
# plus an allowance ending is convergence; zero progress is a real outage worth alerting on.

def test_allowance_exhausted_items_are_not_counted_as_failures():
    tracker = FetchTracker("tl")
    for i in range(20):
        tracker.record(f"ok{i}", ok=True)
    for i in range(80):
        tracker.record_allowance_exhausted(f"blocked{i}")
    assert tracker.fail_rate == 0.0, "a blocked tail is the allowance ending, not 80 failures"
    assert tracker.total == 20


def test_real_failures_still_count_alongside_allowance_blocks():
    tracker = FetchTracker("tl")
    for i in range(8):
        tracker.record(f"ok{i}", ok=True)
    tracker.record("genuinely-broken", ok=False)
    tracker.record_allowance_exhausted("blocked")
    assert tracker.total == 9
    assert tracker.fail_rate == pytest.approx(1 / 9)


def test_progress_plus_allowance_block_exits_zero(capsys):
    """The live trendlyne-midweek shape: real rows written, then the vendor cut us off."""
    tracker = FetchTracker("tl")
    for i in range(21):
        tracker.record(f"ok{i}", ok=True)
    for i in range(89):
        tracker.record_allowance_exhausted(f"blocked{i}")
    tracker.finish()  # must NOT raise SystemExit
    err = capsys.readouterr().err
    assert "allowance" in err.lower(), "the degradation must be reported on stderr"


def test_zero_progress_under_an_allowance_block_reports_loudly_but_does_not_fail(capsys):
    """DELIBERATE REVERSAL of the first version of this rule, recorded so it is not re-flipped.

    The first implementation exited non-zero when an allowance-blocked run achieved nothing, on
    the reasoning that zero progress is an outage rather than convergence. That is wrong here,
    for a reason that only shows up once you know the surrounding system: Trendlyne's allowance
    is CUMULATIVE AND SHARED across every Trendlyne fetcher on the platform. A run that starts
    after a sibling has already spent the budget legitimately gets zero items -- so the gate
    would fire on a benign, expected case, which is the always-fires defect this codebase keeps
    re-learning (ml-model-bugs.md's drift_detector; so_chain_source.has_chain makes the
    identical argument for the identical reason).

    A single run cannot distinguish "the budget was already spent" from "the vendor is gone".
    Only elapsed time can, and that instrument already exists: `trendlyne-adv-tech-daily-
    freshness` and `trendlyne-price-analysis-freshness` in dataQualityChecks.ts (warn 10d /
    fail 16d) watch whether rows actually land. That measures the outcome, over the right
    timescale, instead of one process's exit code.

    So: report it loudly on stderr, exit 0, and let sustained silence be caught by the check
    built to catch sustained silence.
    """
    tracker = FetchTracker("tl")
    for i in range(50):
        tracker.record_allowance_exhausted(f"blocked{i}")
    tracker.finish()  # must NOT raise
    err = capsys.readouterr().err
    assert "ZERO" in err, "a run that achieved nothing must still say so, loudly"
    assert "freshness" in err.lower(), "the message must name the monitor that does gate this"


def test_allowance_blocks_do_not_trip_the_consecutive_fail_breaker():
    """abort_after_consecutive_fails exists for a total upstream outage. An allowance ending
    mid-run is the expected end of a slice and must not be mistaken for one."""
    tracker = FetchTracker("tl", abort_after_consecutive_fails=5)
    tracker.record("ok", ok=True)
    for i in range(20):
        tracker.record_allowance_exhausted(f"blocked{i}")   # must not sys.exit
    assert tracker.total == 1


def test_a_normal_high_failure_run_still_exits_nonzero():
    """Negative control: the threshold must still fire for ordinary failures, so this change
    cannot be used to silence a genuinely broken fetcher."""
    tracker = FetchTracker("tl")
    for i in range(10):
        tracker.record(f"ok{i}", ok=True)
    for i in range(40):
        tracker.record(f"bad{i}", ok=False)
    with pytest.raises(SystemExit):
        tracker.finish()


def test_rate_threshold_is_not_applied_to_an_allowance_truncated_slice(capsys):
    """The second half of the trendlyne-midweek fix, and the subtler half.

    Live 2026-09-05, after allowance-blocks stopped being counted as failures, the run STILL
    exited non-zero: 10/14 succeeded, 4 failed = 28.6% against a 15% threshold.

    That threshold is calibrated for a full ~2,234-stock pass, and applying it to a 14-item
    slice is not just underpowered -- the slice is SYSTEMATICALLY BIASED. These fetchers resume
    from the DB, so the remainder they work through is exactly the set of symbols NOT yet
    fetched today, which is enriched for the ones that already failed. The fail rate on a
    resumed slice is therefore always higher than the universe rate and cannot be compared
    against a threshold derived from it.

    So an allowance-truncated run that made progress is judged on "did anything land", not on a
    rate computed over a biased fragment. The failed items are still printed -- the information
    is kept, only the exit-code gate is dropped.
    """
    tracker = FetchTracker("tl")
    for i in range(10):
        tracker.record(f"ok{i}", ok=True)
    for i in range(4):
        tracker.record(f"genuinely-missing{i}", ok=False)
    for i in range(96):
        tracker.record_allowance_exhausted(f"blocked{i}")
    assert tracker.fail_rate > tracker.fail_threshold, "precondition: rate would otherwise trip"
    tracker.finish()  # must not raise
    out = capsys.readouterr()
    assert "genuinely-missing0" in out.out, "failed items must still be reported, not hidden"


def test_a_full_run_with_no_allowance_block_is_still_gated_on_rate():
    """Negative control for the above: without an allowance block the threshold must still fire,
    so a fetcher that is simply broken cannot hide behind this branch."""
    tracker = FetchTracker("tl")
    for i in range(10):
        tracker.record(f"ok{i}", ok=True)
    for i in range(4):
        tracker.record(f"bad{i}", ok=False)
    with pytest.raises(SystemExit):
        tracker.finish()
