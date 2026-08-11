"""Live-datasource tests for the two remaining untested NiftyTrader OI fetchers.

`nt_change_oi_fetcher.py` and `nt_oi_snapshot_fetcher.py` were the last two of the four nt_*
fetchers flagged in the 2026-08-04 coverage session; the other two (nt_vix, nt_pcr_ts) were
covered then. Found again by scripts/check_recurring_bugs.py on its first-ever run (2026-08-11).

Both use the module-level-DB pattern — execute()/executemany() imported as bare functions from
db_compat with no `con` parameter — so they use the same _CaptureDB monkeypatch established in
test_live_datasource_nt_vix.py rather than an in-memory sqlite conn.

Neither endpoint needs the DB-stored rotating Bearer token that niftytraderService.ts uses;
confirmed by reading NT_HEADERS in both fetchers before writing this.

Skipped by default; opt in with RUN_LIVE_DATASOURCE_TESTS=1. Never runs in CI.
"""
import os
import sys

import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
sys.path.insert(0, os.path.dirname(__file__))

from live_datasource_helpers import assert_non_empty_response, assert_numeric_and_finite

# NIFTY50 is in both fetchers' _FALLBACK map, so resolution works even without a live
# index_provider_map table — but we still go through the fetcher's own resolver rather than
# hardcoding "nifty", per CLAUDE.md's "use the fetcher's own resolution helpers" rule.
REAL_INDEX = "NIFTY50"
SNAP_TIME = "15:20:00"


class _CaptureDB:
    """Records (sql, params) instead of touching a real DB. Mirrors the helper in
    test_live_datasource_nt_vix.py — kept local to each file rather than shared, so a change
    made for one fetcher can't silently alter another's test."""

    def __init__(self):
        self.calls = []

    def execute(self, sql, params=None):
        self.calls.append((sql, params))

    def executemany(self, sql, rows):
        for row in rows:
            self.calls.append((sql, row))


def _resolve(mod):
    """Resolve REAL_INDEX through the fetcher's own map; skip if it isn't there at all."""
    index_map = mod._get_nt_index_map()
    if REAL_INDEX not in index_map:
        pytest.skip(f"{REAL_INDEX} not in {mod.__name__}'s index map")
    return index_map[REAL_INDEX]


def _capture(mod, fn, *args):
    """Run `fn(*args)` with the module's bare execute/executemany swapped for a capture."""
    cap = _CaptureDB()
    orig_execute, orig_executemany = mod.execute, mod.executemany
    mod.execute, mod.executemany = cap.execute, cap.executemany
    try:
        fn(*args)
    finally:
        mod.execute, mod.executemany = orig_execute, orig_executemany
    return cap


@pytest.mark.live_datasource
class TestNtChangeOiLiveDataSource:
    def test_real_fetch_returns_ml_usable_rows(self):
        import nt_change_oi_fetcher as ncoi

        nt_symbol, exchange = _resolve(ncoi)
        data = ncoi.fetch_change_oi(nt_symbol, SNAP_TIME, exchange)
        if not data:
            # An empty resultData outside market hours / on a holiday is correct behaviour,
            # not a parse failure — the fetcher returns [] for both. Don't fail the build on it.
            pytest.skip(f"change-OI returned no rows for {nt_symbol} (likely a non-trading day)")
        assert_non_empty_response(data, f"fetch_change_oi({nt_symbol})")

        # Strike is the join key for everything downstream; a parse landing on the wrong JSON
        # field would still return dicts, so assert on the field the fetcher actually stores.
        strikes = [ncoi._sf(r.get("strike_price")) for r in data[:25]]
        real = [s for s in strikes if s is not None]
        assert real, f"no parseable strike_price in the first 25 rows: {data[0]!r}"
        for s in real:
            assert_numeric_and_finite(s, "strike_price")
            assert s > 0, f"non-positive strike {s}"

    def test_real_fetch_stores_ml_usable_rows(self):
        import nt_change_oi_fetcher as ncoi

        nt_symbol, exchange = _resolve(ncoi)
        data = ncoi.fetch_change_oi(nt_symbol, SNAP_TIME, exchange)
        if not data:
            pytest.skip(f"change-OI returned no rows for {nt_symbol} (likely a non-trading day)")

        cap = _capture(ncoi, ncoi.save_change_oi, REAL_INDEX, data, "2026-08-11")
        assert cap.calls, "save_change_oi() made no execute/executemany calls at all"

        writes = [(sql, p) for sql, p in cap.calls if "INSERT" in sql.upper() and p]
        assert writes, "save_change_oi() issued no INSERT with params"
        _, params = writes[0]
        # The index name must survive as a real identifier, not a URL or scrape artifact —
        # this is the exact shape the 2026-07-23 corruption took in a different fetcher.
        assert REAL_INDEX in [str(v) for v in params], \
            f"index name absent from stored params: {params!r}"
        numeric = [v for v in params if isinstance(v, (int, float))]
        assert numeric, f"no numeric values in a change-OI INSERT: {params!r}"
        for v in numeric:
            assert_numeric_and_finite(v, "change_oi param")


@pytest.mark.live_datasource
class TestNtOiSnapshotLiveDataSource:
    def test_real_fetch_returns_ml_usable_rows(self):
        import nt_oi_snapshot_fetcher as noi

        nt_symbol, exchange = _resolve(noi)
        data = noi.fetch_oi_snapshot(nt_symbol, SNAP_TIME, exchange)
        if not data:
            pytest.skip(f"OI snapshot returned no rows for {nt_symbol} (likely a non-trading day)")
        assert_non_empty_response(data, f"fetch_oi_snapshot({nt_symbol})")

        rows = [r for r in data if r.get("strike_price") is not None]
        assert rows, f"no rows carried a strike_price: {data[0]!r}"
        for r in rows[:25]:
            assert_numeric_and_finite(r["strike_price"], "strike_price")

    def test_max_pain_falls_inside_the_real_strike_range(self):
        """Regression guard for the finding-#51 class of bug: max-pain computed with call/put
        OI swapped still returns a plausible-looking number, so assert the result sits inside
        the strike ladder it was derived from rather than merely being non-null."""
        import nt_oi_snapshot_fetcher as noi

        nt_symbol, exchange = _resolve(noi)
        data = noi.fetch_oi_snapshot(nt_symbol, SNAP_TIME, exchange)
        if not data:
            pytest.skip(f"OI snapshot returned no rows for {nt_symbol} (likely a non-trading day)")

        mp = noi._compute_max_pain(data)
        strikes = [r["strike_price"] for r in data if r.get("strike_price") is not None]
        if mp is None:
            pytest.skip("max pain not computable from this snapshot")
        assert min(strikes) <= mp <= max(strikes), \
            f"max pain {mp} outside the real strike range {min(strikes)}-{max(strikes)}"

    def test_real_fetch_stores_ml_usable_rows(self):
        import nt_oi_snapshot_fetcher as noi

        nt_symbol, exchange = _resolve(noi)
        data = noi.fetch_oi_snapshot(nt_symbol, SNAP_TIME, exchange)
        if not data:
            pytest.skip(f"OI snapshot returned no rows for {nt_symbol} (likely a non-trading day)")

        cap = _capture(noi, noi.save_snapshot, REAL_INDEX, data, "2026-08-11")
        assert cap.calls, "save_snapshot() made no execute/executemany calls at all"

        writes = [(sql, p) for sql, p in cap.calls if "INSERT" in sql.upper() and p]
        assert writes, "save_snapshot() issued no INSERT with params"
        _, params = writes[0]
        assert REAL_INDEX in [str(v) for v in params], \
            f"index name absent from stored params: {params!r}"
        for v in params:
            if isinstance(v, float):
                assert_numeric_and_finite(v, "oi_snapshot param")
