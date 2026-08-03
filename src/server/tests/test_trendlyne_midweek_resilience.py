"""
Regression coverage for the 2026-08-03 fix: trendlyne_price_analysis_fetcher.py silently wrote
zero rows for all 1822/1822 stocks on 2026-07-28 (confirmed live in that day's app log --
"execution completed" with every single stock logging "no data") while its sibling
trendlyne_adv_tech_fetcher.py, run immediately before it in the same trendlyne-midweek batch,
succeeded. Neither fetcher had retry/backoff or a failure-rate guard, so a transient block/
rate-limit at Trendlyne looked identical to a fully healthy run in every job-monitoring signal.

Both fetchers now route through fetch_utils.retry_get (resilience against a transient failure)
and fetch_utils.FetchTracker (loud sys.exit(1) once the failure rate crosses threshold, instead
of a silent zero-row "success").
"""
import inspect
import sys
from pathlib import Path
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

import trendlyne_price_analysis_fetcher as tlpa  # noqa: E402
import trendlyne_adv_tech_fetcher as tladv  # noqa: E402


class _StubResp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class TestPriceAnalysisFetchUsesRetryGet:
    def test_success_path_parses_body(self):
        with patch.object(tlpa, "retry_get",
                           return_value=_StubResp({"head": {"status": "0"}, "body": {"x": 1}})):
            assert tlpa._fetch("1127", session=object()) == {"x": 1}

    def test_non_success_head_status_returns_none(self):
        with patch.object(tlpa, "retry_get",
                           return_value=_StubResp({"head": {"status": "1"}, "body": {}})):
            assert tlpa._fetch("1127", session=object()) is None

    def test_retry_get_exhausting_retries_is_caught_not_raised(self):
        def _boom(*a, **k):
            raise RuntimeError("blocked")
        with patch.object(tlpa, "retry_get", side_effect=_boom):
            assert tlpa._fetch("1127", session=object()) is None


class TestAdvTechFetchUsesRetryGet:
    def test_success_path_parses_params(self):
        with patch.object(tladv, "retry_get",
                           return_value=_StubResp({"body": {"parameters": {"ma_bull": 3}}})):
            assert tladv.fetch_adv_tech("1127", session=object()) == {"ma_bull": 3}

    def test_retry_get_exhausting_retries_is_caught_not_raised(self):
        def _boom(*a, **k):
            raise RuntimeError("blocked")
        with patch.object(tladv, "retry_get", side_effect=_boom):
            assert tladv.fetch_adv_tech("1127", session=object()) is None


class TestFailureRateIsSurfacedLoudly:
    """Source-inspection wiring checks (mirrors the dl_trainer promotion-gate wiring test
    pattern): main() must construct a FetchTracker and call .finish() so a run where nearly
    every stock comes back "no data" exits non-zero instead of looking like a healthy pass."""

    def test_price_analysis_main_wires_fetch_tracker(self):
        src = inspect.getsource(tlpa.main)
        assert "FetchTracker(" in src
        assert "tracker.finish()" in src
        assert "tracker.record(" in src

    def test_adv_tech_main_wires_fetch_tracker(self):
        src = inspect.getsource(tladv.main)
        assert "FetchTracker(" in src
        assert "tracker.finish()" in src
        assert "tracker.record(" in src
