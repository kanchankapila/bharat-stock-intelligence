import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import eps_surprise_fetcher as esf


class _FakeResp:
    def __init__(self, status_code=200, payload=None, raise_on_json=False):
        self.status_code = status_code
        self._payload = payload
        self._raise = raise_on_json

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")

    def json(self):
        if self._raise:
            raise ValueError("Expecting value: line 1 column 1 (char 0)")
        return self._payload


class _FakeCffi:
    def __init__(self, resp):
        self._resp = resp

    def get(self, *a, **kw):
        return self._resp


class TestFetchBulkDegradesGracefully:
    """Regression test for the fix: an uncaught JSON-decode error when MC's bulk
    actual-estimate endpoint returns empty/malformed used to kill the whole script.
    It now degrades to '0 stocks resolved' and continues."""

    def test_decode_failure_returns_empty_without_raising(self, monkeypatch):
        # status_code=200 (a "successful" response) with a malformed body — exercises the
        # JSON-decode-failure path specifically, distinct from an HTTP-error status (which
        # retry_get's own raise_for_status now intercepts before .json() is ever called).
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(status_code=200, raise_on_json=True)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert features == {}
        assert history == []

    def test_http_error_status_returns_empty_without_raising(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(status_code=502)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert features == {}
        assert history == []


_GOOD_PAYLOAD = {"data": {"list": [
    ["SCID1", None, None, None, None, "May 30, 2026", None, None, 12.5,
     [["Revenue", "1000", "900"], ["Net Profit", "150", "120"], ["EPS", "5", "4"]]],
]}}


class TestFetchBulkHappyPath:
    def test_resolves_known_scid_and_computes_features(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(payload=_GOOD_PAYLOAD)))
        features, history = esf.fetch_bulk({"SCID1": "RELIANCE"})
        assert "RELIANCE" in features
        assert features["RELIANCE"]["eps_surprise_q1"] == 12.5
        assert len(history) == 1
        assert history[0][0] == "SCID1" and history[0][1] == "RELIANCE"

    def test_unresolvable_scid_is_skipped(self, monkeypatch):
        monkeypatch.setattr(esf, "cffi_req", _FakeCffi(_FakeResp(payload=_GOOD_PAYLOAD)))
        features, history = esf.fetch_bulk({})
        assert features == {}
        assert history == []


class TestSafeFloat:
    def test_valid_numeric_string(self):
        assert esf._safe_float("1,234.5") == 1234.5

    def test_dash_sentinel_returns_none(self):
        assert esf._safe_float("--") is None

    def test_none_returns_none(self):
        assert esf._safe_float(None) is None

    def test_garbage_returns_none_not_raise(self):
        assert esf._safe_float("not-a-number") is None


# ── Regression: Pass 2 no longer hits a non-existent per-stock endpoint (2026-07-31) ──
#
# MC's actual-estimate endpoint is list-only. Live-probed 2026-07-31: `?scId=RI&type=Q&subType=yoy`
# -> HTTP 422 {"success":0,"data":"\"scId\" is not allowed"}, and scId/sc_id/scid/id/symbol are
# ALL rejected. Every one of the ~500 per-stock calls 422'd (132 error lines/run in pm2-err.log),
# each retried by retry_get, burning the 600s job budget until the timeout killed the job. q2 and
# beat-streak are now derived from eps_surprise_history, which the bulk pass already accumulates.

class TestNoPerStockEndpoint:
    def test_module_defines_no_per_stock_url(self):
        """Guards against the dead endpoint being reintroduced."""
        src = open(esf.__file__, encoding="utf-8").read()
        assert "STOCK_URL" not in src.replace("# ", ""), \
            "per-stock actual-estimate URL is a 422 for every parameter shape — do not restore it"
        assert not hasattr(esf, "STOCK_URL")

    def test_enrich_pass_makes_no_network_calls(self):
        assert not hasattr(esf, "_fetch_per_stock")
        assert hasattr(esf, "enrich_from_history")


class TestQuarterSortKey:
    def test_orders_by_real_date_not_text(self):
        """`quarter` is a results DATE ('May 30, 2026'), so text sort is wrong:
        text-ascending would put 'May' before 'Jul' (M < J is False -> 'Jul' < 'May'),
        silently making q1/q2 the wrong quarters."""
        quarters = ["Jul 29, 2026", "May 30, 2026", "Jan 15, 2026"]
        assert sorted(quarters, key=esf._quarter_sort_key, reverse=True) == [
            "Jul 29, 2026", "May 30, 2026", "Jan 15, 2026",
        ]
        # plain text sort disagrees -> proves the key is doing real work
        assert sorted(quarters, reverse=True) != sorted(
            quarters, key=esf._quarter_sort_key, reverse=True)

    def test_unparseable_sorts_oldest_and_never_raises(self):
        assert esf._quarter_sort_key("") == (0, 0, 0)
        assert esf._quarter_sort_key("garbage") == (0, 0, 0)
        assert esf._quarter_sort_key(None) == (0, 0, 0)


class TestComputeFeaturesFromHistory:
    def test_streak_counts_consecutive_beats_newest_first(self):
        rows = [{"quarter": "Jul 29, 2026", "np_surprise": 5.0, "rev_surprise": 1.0},
                {"quarter": "Apr 29, 2026", "np_surprise": 3.0, "rev_surprise": 1.0},
                {"quarter": "Jan 29, 2026", "np_surprise": -2.0, "rev_surprise": 1.0}]
        f = esf._compute_features(rows)
        assert f["eps_surprise_q1"] == 5.0
        assert f["eps_surprise_q2"] == 3.0
        assert f["eps_beat_streak"] == 2      # stops at the miss
