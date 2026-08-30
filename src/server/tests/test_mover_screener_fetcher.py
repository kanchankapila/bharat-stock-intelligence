"""
Tests for mover_screener_fetcher.py.

Pure-function tests (payload row-extraction, computed class definitions) need no DB.
Persistence tests run against a throwaway Postgres schema via pg_memory_conn().
Network tests inject a fake session -- no real HTTP happens here.
"""

import os
import sys

import pytest

SERVER_DIR = os.path.join(os.path.dirname(__file__), "..")
sys.path.insert(0, SERVER_DIR)

import mover_screener_fetcher as msf  # noqa: E402
from pg_test_support import pg_memory_conn  # noqa: E402


# ── Fixtures / helpers ────────────────────────────────────────────────────────

@pytest.fixture()
def sqlite_con(pg_memory_conn):
    """Throwaway-schema connection, kept under its historical name.

    Was a temp-file SQLite fixture (DATABASE_URL injection + USE_POSTGRES=false), but
    sql_translate.use_postgres() went Postgres-only in the SQLite decommission (Phase 3,
    2026-08): connect() ignored both env vars and answered from PRODUCTION, which this
    fixture's own canary caught (non-empty mover_snapshots -> refusal). Same conversion
    as every other Phase-2 file: a per-test schema where ensure_schema's CREATE TABLE IF
    NOT EXISTS builds an empty mover_snapshots and nothing outside it is reachable.
    """
    con = pg_memory_conn
    msf.ensure_schema(con)
    # Isolation canary, kept from the SQLite era with updated wording: if this table is
    # not empty the search path leaked out of the throwaway schema -- fail loudly instead
    # of polluting the shared/dev DB.
    n = con.execute("SELECT COUNT(*) FROM mover_snapshots").fetchone()[0]
    assert int(n) == 0, (
        "test fixture is not isolated: mover_snapshots is non-empty; "
        "refusing to run so the shared/dev DB is not polluted")
    yield con


def _fetchall(con, sql):
    cur = con.cursor()
    cur.execute(sql)
    return [dict(r) for r in cur.fetchall()]


def _frame(days, symbol="TEST"):
    """Build an OHLCV DataFrame from a list of per-day dicts."""
    import pandas as pd
    idx = pd.bdate_range("2026-06-01", periods=len(days))
    rows = [dict(symbol=symbol, date=d.strftime("%Y-%m-%d"), **day)
            for d, day in zip(idx, days)]
    return pd.DataFrame(rows).sort_values(["symbol", "date"]).reset_index(drop=True)


QUIET = dict(open=100.0, high=101.0, low=99.0, close=100.0, volume=1_000_000)

# ── Payload row extraction ────────────────────────────────────────────────────

class TestRowExtraction:
    def test_ci_get_case_insensitive(self):
        assert msf._ci_get({"PercentChange": 2.5}, "percentchange") == 2.5
        assert msf._ci_get({"a": 1}, "b") is None

    def test_to_float_handles_commas_and_percent(self):
        assert msf._to_float("1,234.5%") == pytest.approx(1234.5)
        assert msf._to_float(None) is None
        assert msf._to_float("n/a") is None

    def test_find_rows_walks_nested_payloads(self):
        payload = {"response": {"metadata": {}, "data": [
            {"NSE_SYMBOL": "RELIANCE", "percentChange": "2.5"}]}}
        rows = msf._find_rows(payload)
        flat = [r for g in rows for r in g]
        assert len(flat) == 1
        assert msf._ci_get(flat[0], *msf.SYMBOL_KEYS) == "RELIANCE"

    def test_find_rows_empty_on_garbage(self):
        assert msf._find_rows({"error": "not found"}) == []
        assert msf._find_rows([1, 2, 3]) == []

    def test_find_rows_collects_sector_bucketed_payloads(self):
        # MarketsMojo groups gainers into {index, stocks:[...]} buckets; every bucket
        # must be collected, not just the first one.
        payload = {"data": [
            {"index": "Auto", "stocks": [{"symbol": "TATAMOTORS", "pctchange": 3.1},
                                         {"symbol": "M&M", "pctchange": 2.7}]},
            {"index": "Bank", "stocks": [{"symbol": "SBIN", "pctchange": 2.2}]},
        ]}
        rows = msf._rows_from_response(_FakeResp(payload), "mojo_test")
        syms = [r[0] for r in rows] if rows and isinstance(rows[0], tuple) else \
            [str(msf._ci_get(r, *msf.SYMBOL_KEYS)) for r in rows]
        assert set(syms) == {"TATAMOTORS", "M&M", "SBIN"}
        assert len(rows) == 3

    def test_normalize_row_uppercases_and_ranks(self):
        sym, rank, pct, metric, _json = msf.normalize_row(
            {"symbol": " reLIANCE ", "percentchange": "3.1", "volume_ratio": "4.2"}, 7)
        assert sym == "RELIANCE"
        assert rank == 7
        assert pct == pytest.approx(3.1)
        assert metric == pytest.approx(4.2)

    def test_normalize_row_rejects_bad_symbols(self):
        assert msf.normalize_row({"symbol": "M&M LTD"}, 1) is None
        assert msf.normalize_row({"symbol": "X" * 30}, 1) is None
        assert msf.normalize_row({}, 1) is None


# ── Computed classes (the reverse-engineering event definitions) ──────────────

class TestComputedClasses:
    def _flags(self, days):
        return msf.compute_classes_frame(_frame(days)).iloc[-1]

    def test_gap_up_flagged_at_2pct(self):
        row = self._flags([QUIET] * 12 +
                          [dict(open=103, high=104, low=102, close=103.5, volume=1_000_000)])
        assert bool(row["gap_up"]) is True
        assert row["gap_pct"] == pytest.approx(3.0, abs=1e-6)

    def test_gap_down_flagged(self):
        row = self._flags([QUIET] * 12 +
                          [dict(open=97, high=98, low=96, close=96.5, volume=1_000_000)])
        assert bool(row["gap_down"]) is True
        assert bool(row["gap_up"]) is False

    def test_open_eq_low_bullish_hold(self):
        # opened on the exact low, travelled 2.5%, closed above open
        row = self._flags([QUIET] * 12 +
                          [dict(open=100, high=102.5, low=100, close=102, volume=1_000_000)])
        assert bool(row["open_eq_low"]) is True

    def test_open_eq_high_bearish_hold(self):
        row = self._flags([QUIET] * 12 +
                          [dict(open=100, high=100, low=97.5, close=98, volume=1_000_000)])
        assert bool(row["open_eq_high"]) is True

    def test_volume_shocker_needs_5x_median(self):
        row = self._flags([QUIET] * 22 +
                          [dict(open=100, high=101, low=99, close=100.8, volume=6_000_000)])
        assert bool(row["volume_shocker"]) is True

    def test_breakout_over_prior_20d_high_with_strong_close(self):
        row = self._flags([QUIET] * 25 +
                          [dict(open=100, high=105, low=99.9, close=104.5, volume=1_000_000)])
        assert bool(row["intraday_breakout"]) is True

    def test_quiet_day_flags_nothing(self):
        row = self._flags([QUIET] * 13)
        for flag in ("gap_down", "open_eq_low", "open_eq_high", "volume_shocker"):
            assert bool(row[flag]) is False, flag

    def test_compute_rows_emits_only_requested_dates(self):
        days = [QUIET] * 12 + [dict(open=103, high=104, low=102, close=103.5,
                                    volume=1_000_000)]
        df = _frame(days)
        last_date = str(df["date"].iloc[-1])
        rows = msf.compute_rows_for_dates(df, {last_date})
        srcs = {r[0] for r in rows}
        # a +3% gap day that holds its range is BOTH a gap-up and (high > prior 20d
        # high, strong close) a breakout -- classes intentionally overlap.
        assert "calc_gap_up" in srcs and "calc_intraday_breakout" in srcs
        assert not any(s in srcs for s in ("calc_gap_down", "calc_open_eq_high",
                                           "calc_volume_shocker"))
        row = next(r for r in rows if r[0] == "calc_gap_up")
        _, td, sym, rk, mv, pct, _pj = row
        assert (td, sym, rk) == (last_date, "TEST", None)
        assert mv == pytest.approx(3.0, abs=1e-4)
        assert pct is None or abs(pct) < 10


# ── Persistence (both tuple layouts, PK upsert semantics) ─────────────────────

class TestPersist:
    def test_roundtrip_both_layouts(self, pg_db_conn):
        msf.ensure_schema(pg_db_conn)   # IF NOT EXISTS no-op if prod DDL already made it
        live = ("et_gainers_1d", "RELIANCE", 1, 3.2, None, "{}", "2026-08-21")
        calc = ("calc_gap_up", "2026-08-21", "TATASTEEL", None, 2.1, 4.0, "{}")
        assert msf.persist(pg_db_conn, [live, calc], "2026-08-21T10:00:00") == 2
        rows = _fetchall(pg_db_conn,
                         "SELECT source, trade_date, symbol, rank, pct_change, "
                         "metric_value FROM mover_snapshots ORDER BY source")
        assert len(rows) == 2
        assert rows[0]["source"] == "calc_gap_up"
        assert rows[0]["pct_change"] == pytest.approx(4.0)
        assert rows[0]["metric_value"] == pytest.approx(2.1)
        assert rows[1]["symbol"] == "RELIANCE"
        assert rows[1]["rank"] == 1
        assert rows[1]["metric_value"] is None

    def test_pk_conflict_updates_not_duplicates(self, pg_db_conn):
        msf.ensure_schema(pg_db_conn)
        msf.persist(pg_db_conn,
                    [("et_gainers_1d", "RELIANCE", 1, 3.2, None, "{}", "2026-08-21")], None)
        msf.persist(pg_db_conn,
                    [("et_gainers_1d", "RELIANCE", 2, 3.5, None, "{}", "2026-08-21")], None)
        rows = _fetchall(pg_db_conn,
                         "SELECT rank FROM mover_snapshots WHERE symbol='RELIANCE'")
        assert len(rows) == 1
        assert rows[0]["rank"] == 2


# ── Live-source plumbing (fake session, no network) ───────────────────────────

class _FakeResp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")

    def json(self):
        return self._payload


class _FakeSession:
    def __init__(self, routes):
        self._routes = routes          # url-substring -> payload

    def get(self, url, **kw):
        for frag, payload in self._routes.items():
            if frag in url:
                return _FakeResp(payload)
        return _FakeResp({})

    def post(self, url, **kw):
        return self.get(url, **kw)     # screener POSTs route on the same substrings


class TestLiveSources:
    def test_fetch_et_labels_and_order_asc_for_losers(self):
        sess = _FakeSession({"ET_Stats/gainers": {"data": [
            {"NSE_SYMBOL": "RELIANCE", "percentChange": "2.5"},
            {"NSE_SYMBOL": "HDFCBANK", "percentChange": "1.9"}]}})
        rows = msf.fetch_et(sess, "losers_1d", "1%20day", order="asc")
        assert [r[0] for r in rows] == ["et_losers_1d", "et_losers_1d"]
        assert [r[1] for r in rows] == ["RELIANCE", "HDFCBANK"]
        assert [r[2] for r in rows] == [1, 2]

    def test_fetch_et_failure_returns_empty_not_raise(self):
        class BoomSession:
            def get(self, url, **kw):
                raise ConnectionError("boom")
        assert msf.fetch_et(BoomSession(), "gainers_1d", "1%20day") == []

    def test_fetch_mc_shockers_normalizes(self):
        sess = _FakeSession({"price-shockers": {
            "priceShockerData": [{"symbolCode": "TATAMOTORS", "percentChange": "-4.4"}]}})
        rows = msf.fetch_mc_shockers(sess)
        assert len(rows) == 1
        assert rows[0][0] == "mc_price_shockers"
        assert rows[0][1] == "TATAMOTORS"
        assert rows[0][3] == pytest.approx(-4.4)

    def test_fetch_mc_shockers_columnar_maps_scid_and_skips_unknown(self):
        sess = _FakeSession({"price-shockers": {"success": 1, "data": {
            "header": [{"name": "scID"}, {"name": "Name"}, {"name": "LTP"},
                       {"name": "Chg%"}, {"name": "%Gain/Loss Since Result Date"},
                       {"name": "Result Date"}],
            "list": [["SSM05", "Siyaram Silk", "566.40", "-3.75", "1,773.51", "30/07/26"],
                     ["ZZZ99", "Unmapped Co", "10.00", "2.00", "", ""]],
        }}})
        rows = msf.fetch_mc_shockers(sess, symbol_map={"SSM05": "SIYARAM"})
        assert len(rows) == 1                      # unmapped scID skipped entirely
        assert rows[0][1] == "SIYARAM"             # real NSE symbol, not the MC code
        assert rows[0][3] == pytest.approx(-3.75)  # Chg%
        assert rows[0][4] == pytest.approx(1773.51)
        assert "Result Date" in rows[0][5]

    def test_fetch_mojo_sid_rows_mapped_deduped(self, monkeypatch):
        monkeypatch.setattr(msf, "_mojo_sid_map",
                            lambda: {"632923": "FACT", "914349": "HINDCOPPER"})
        sess = _FakeSession({"market_Gainersloser": {"code": 200, "message": "success", "data": {
            "gainers": [
                {"index": "NIFTY500", "stocks": [
                    {"name": "F A C T", "cmp": "883.40", "chgp": "12.62", "sid": 632923},
                    {"name": "Hind Copper", "cmp": "531", "chgp": "-7.2", "sid": 914349}]},
                {"index": "NIFTY", "stocks": [
                    {"name": "F A C T dup", "cmp": "883.40", "chgp": "12.62", "sid": 632923},
                    {"name": "Unknown Ltd", "cmp": "10", "chgp": "1.0", "sid": 999999999}]},
            ]}}})
        rows = msf.fetch_mojo(sess)
        gainers = [r for r in rows if r[0] == "mojo_gainers"]
        assert [r[1] for r in gainers] == ["FACT", "HINDCOPPER"]  # mapped, deduped, unknown skipped
        assert gainers[0][3] == pytest.approx(12.62)              # chgp
        assert gainers[0][4] == pytest.approx(883.40)             # cmp as metric
        assert "sid" in gainers[0][5] and "is_blur" not in gainers[0][5]

    def test_et_screens_map_companyid_and_skip_stale_batch(self, monkeypatch):
        import json as _json
        monkeypatch.setattr(msf, "_et_company_map", lambda: {"66288": "ADANIPORTS"})
        sess = _FakeSession({"LONG_WHITE_CANDLE": {
            "filterDto": {"predefinedFilterName": "LONG_WHITE_CANDLE",
                          "screenerType": "BULLISH",
                          "resultDate": "21 Aug, 2026, 05.30 PM IST"},
            "page": [{"companyId": "66288", "companyName": "Adani Ports",
                      "openPrice": 100.0, "closePrice": 105.0},
                     {"companyId": "424242", "companyName": "Unmapped Co"}]}})
        rows = msf.fetch_et_screens(sess, trade_date="2026-08-25")
        assert rows == []                          # stale resultDate -> whole batch skipped

        sess = _FakeSession({"LONG_WHITE_CANDLE": {
            "filterDto": {"predefinedFilterName": "LONG_WHITE_CANDLE",
                          "screenerType": "BULLISH",
                          "resultDate": "25 Aug, 2026, 05.30 PM IST"},
            "page": [{"companyId": "66288", "companyName": "Adani Ports",
                      "openPrice": 100.0, "closePrice": 105.0},
                     {"companyId": "424242", "companyName": "Unmapped Co"}]}})
        rows = msf.fetch_et_screens(sess, trade_date="2026-08-25")
        assert len(rows) == 1                      # unmapped companyId skipped
        assert rows[0][0] == "et_screen_long_white_candle"
        assert rows[0][1] == "ADANIPORTS"
        payload = _json.loads(rows[0][5])
        assert payload["screenerType"] == "BULLISH"
        assert payload["closePrice"] == pytest.approx(105.0)


    def test_nt_top_gainers_parses_webapi_shape(self, monkeypatch):
        # live shape (verified 2026-08-24): webapi.niftytrader.in returns
        # resultData.topGainers rows keyed symbol_name/change_percent
        #
        # _nt_bearer_token() hits app_settings via db_compat -- unmocked, this test's
        # outcome silently depended on ambient DB state instead of the _FakeSession below.
        # In CI's python-tests job (POSTGRES_* deliberately unset -- see db_compat.py) that
        # lookup fails, fetch_niftytrader() early-returns [] before ever touching the mock,
        # and the assertion fails with no indication the mock was never reached. Same
        # monkeypatch pattern as _mojo_sid_map/_et_company_map above.
        monkeypatch.setattr(msf, "_nt_bearer_token", lambda: "fake-token")
        sess = _FakeSession({"top-gainers-data": {"result": 1, "resultData": {
            "topGainers": [
                {"symbol_name": "MARATHON", "change_percent": 19.99, "today_close": 422.8},
                {"symbol_name": "SBIN", "change_percent": 3.2, "today_close": 810.0}]}}})
        rows = msf.fetch_niftytrader(sess)
        assert [r[1] for r in rows] == ["MARATHON", "SBIN"]
        assert [r[0] for r in rows] == ["nt_top_gainers", "nt_top_gainers"]
        assert [r[2] for r in rows] == [1, 2]
        assert rows[0][3] == pytest.approx(19.99)

    def test_fetch_mojo_collects_all_sector_buckets(self):
        sess = _FakeSession({"market_Gainersloser": {"data": [
            {"index": "Auto", "stocks": [{"symbol": "TATAMOTORS", "pctchange": 3.1}]},
            {"index": "Bank", "stocks": [{"symbol": "SBIN", "pctchange": 2.2},
                                         {"symbol": "HDFCBANK", "pctchange": 1.8}]}]}})
        rows = msf.fetch_mojo(sess)
        gainers = [r for r in rows if r[0] == "mojo_gainers"]
        assert {r[1] for r in gainers} == {"TATAMOTORS", "SBIN", "HDFCBANK"}


class TestNiftyTraderScreens:
    """The /webapi/Screener/* family onboarded 2026-08-25 (routes recovered from
    NT's own Next.js chunks; filter semantics verified live before wiring)."""

    EOD_PAYLOAD = {"result": 1, "resultMessage": "Success", "resultData": [
        {"symbol": "AARTIDRUGS", "t0_close": 512.3, "t0_open": 498.0, "t0_high": 515.0,
         "t0_low": 497.1, "t0_volume": 1234567, "t0_deliveryPercentage": 58.4,
         "t0_20avgVolume": 900000.0, "priceChange": 14.3, "priceChangePercentage": 2.87,
         "t0_rsi": 61.2, "t0_date": "2026-08-24T00:00:00"},
        # live-style row: proves the alternate key names parse too
        {"symbol_name": "SBIN", "last_trade_price": 810.0, "change_per": 1.9},
    ]}

    def test_all_cataloged_screens_captured_with_rank_pct_metric(self):
        import json as _json
        sess = _FakeSession({"advance-eod-screener-filter": self.EOD_PAYLOAD})
        rows = msf.fetch_nt_screens(sess)
        assert {r[0] for r in rows} == {s for s, _ in msf.NT_EOD_SCREENS}
        gap = [r for r in rows if r[0] == "nteod_gap_up"]
        assert [r[1] for r in gap] == ["AARTIDRUGS", "SBIN"]   # upper-cased, ranked
        assert gap[0][2] == 1
        assert gap[0][3] == pytest.approx(2.87)                # priceChangePercentage
        assert gap[0][4] == pytest.approx(58.4)                # delivery% as metric
        assert _json.loads(gap[0][5])["t0_date"].startswith("2026-08-24")
        assert gap[1][3] == pytest.approx(1.9)                 # change_per fallback
        assert gap[1][4] is None                               # no delivery field -> NULL

    def test_sources_filter_narrows_catalog(self):
        sess = _FakeSession({"advance-eod-screener-filter": self.EOD_PAYLOAD})
        rows = msf.fetch_nt_screens(sess, {"nteod_gain5"})
        assert {r[0] for r in rows} == {"nteod_gain5"}

    def test_live_screener_skips_without_token_and_on_401(self):
        sess = _FakeSession({"live-market-filter-data": self.EOD_PAYLOAD})
        assert msf.fetch_nt_live_screener(sess, bearer=None) == []
        class _Sess401:
            def post(self, url, **kw):
                return _FakeResp({}, status=401)
        assert msf.fetch_nt_live_screener(_Sess401(), bearer="tok") == []

    def test_live_screener_emits_slot_stamped_market_and_screens(self):
        sess = _FakeSession({"live-market-filter-data": {
            "result": 1, "resultData": [
                {"symbol_name": "TATAMOTORS", "change_per": 3.3,
                 "last_trade_price": 955.5, "high": 956.0,
                 "gap_up_down": "Gap up"},
                {"symbol_name": "SBIN", "change_per": -6.1,
                 "last_trade_price": 810.0, "low": 809.0,
                 "gap_up_down": "Gap down"}]}})
        # default hhmm -> "eod" (EOD-run compatibility)
        rows = msf.fetch_nt_live_screener(sess, bearer="tok")
        sources = {r[0] for r in rows}
        assert "ntlive_eod_market" in sources
        assert "ntlive_eod_gap_up" in sources          # gap_up_down == 'Gap up'
        assert "ntlive_eod_gap_down" in sources
        assert "ntlive_eod_loss5" in sources           # change_per <= -5
        assert "ntlive_eod_near_high" in sources       # 955.5 >= 0.995*956
        mkt = [r for r in rows if r[0] == "ntlive_eod_market"]
        assert len(mkt) == 2                           # full cross-section kept once

    def test_live_screen_tuples_slot_stamps_each_cohort(self):
        data = [{"symbol_name": "XYZ", "change_per": 6.0,
                 "last_trade_price": 100.0, "high": 100.4, "low": 90.0}]
        rows = msf._live_screen_tuples(data, "1130")
        sources = {r[0] for r in rows}
        # no gap_up_down field -> neither gap screen fires; gain5 + near_high do
        assert sources == {f"ntlive_1130_{s}" for s in ("market", "gain5", "near_high")}
        gain = [r for r in rows if r[0] == "ntlive_1130_gain5"][0]
        assert (gain[1], gain[2], gain[3]) == ("XYZ", 1, pytest.approx(6.0))

    def test_screen_rows_persist_through_live_layout(self, pg_db_conn):
        msf.ensure_schema(pg_db_conn)
        sess = _FakeSession({"advance-eod-screener-filter": self.EOD_PAYLOAD})
        rows = [r + ("2026-08-24",) for r in msf.fetch_nt_screens(sess)]
        assert msf.persist(pg_db_conn, rows, "2026-08-25T16:20:00") == len(rows)
        got = _fetchall(pg_db_conn, "SELECT COUNT(*) AS n FROM mover_snapshots "
                                    "WHERE source LIKE 'nteod_%'")
        assert got[0]["n"] == len(msf.NT_EOD_SCREENS) * 2


if __name__ == "__main__":
    pytest.main([__file__, "-v"])




