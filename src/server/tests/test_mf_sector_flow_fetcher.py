import os
import sys

import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
import mf_sector_flow_fetcher as mf


class TestUpdateTechnicalSignalsScoped:
    """Regression test for Finding #43 (2026-07-28 full-stack audit): the previous
    implementation SELECTed every (symbol, date) row from technical_signals with no
    date bound at all, then wrote the CURRENT month's mf_sector_flow_pct value onto
    EVERY one of those historical rows -- smearing today's flow number across a
    stock's entire history the first time this fetcher completed a run. Live DB
    confirmed 0 non-null mf_sector_flow_pct rows before the fix (the fetcher had
    never run to completion against production), so this was a live landmine, not
    yet-manifested corruption. Fixed by bounding the SELECT (and therefore every
    write) to `ts.date >= floor`, where floor = MAX(date) FROM stock_ohlcv (the last
    completed trading session) -- historical rows are never read, and therefore
    never written to."""

    def test_read_df_is_bounded_by_trading_session_floor(self, monkeypatch):
        # logical_write_floor() (as_of.py) now owns the MAX(date) FROM stock_ohlcv query --
        # extracted into the shared helper 10+ fetchers were independently hand-rolling.
        monkeypatch.setattr(mf, "logical_write_floor", lambda *a, **k: "2026-07-29")

        captured = {}

        def fake_read_df(sql, params=()):
            captured["sql"] = sql
            captured["params"] = params
            return pd.DataFrame(columns=["symbol", "date", "sector"])

        monkeypatch.setattr(mf, "read_df", fake_read_df)

        flow = pd.DataFrame({"sector": ["Banks"], "flow_pct": [1.2]})
        result = mf._update_technical_signals(flow)

        assert result == 0
        assert "ts.date >= ?" in captured["sql"], \
            "the SELECT feeding the UPDATE must be bounded by a date floor, or every " \
            "historical row is read (and therefore overwritten) again"
        assert captured["params"] == ("2026-07-29",)

    def test_falls_back_to_today_when_stock_ohlcv_has_no_rows(self, monkeypatch):
        # logical_write_floor() itself returns the given fallback when stock_ohlcv is empty --
        # simulate that by honoring the fallback kwarg, same as the real implementation.
        monkeypatch.setattr(mf, "logical_write_floor", lambda *a, fallback=None, **k: fallback)

        captured = {}

        def fake_read_df(sql, params=()):
            captured["params"] = params
            return pd.DataFrame(columns=["symbol", "date", "sector"])

        monkeypatch.setattr(mf, "read_df", fake_read_df)

        flow = pd.DataFrame({"sector": ["Banks"], "flow_pct": [1.2]})
        mf._update_technical_signals(flow)
        assert captured["params"] == (mf.datetime.date.today().isoformat(),)

    def test_empty_flow_map_short_circuits_without_querying_db(self, monkeypatch):
        called = []
        monkeypatch.setattr(mf, "logical_write_floor", lambda *a, **k: called.append(True))
        result = mf._update_technical_signals(pd.DataFrame(columns=["sector", "flow_pct"]))
        assert result == 0
        assert called == []

    def test_only_matched_sector_rows_within_the_floor_get_written(self, monkeypatch):
        monkeypatch.setattr(mf, "logical_write_floor", lambda *a, **k: "2026-07-29")
        monkeypatch.setattr(mf, "read_df", lambda sql, params=(): pd.DataFrame({
            "symbol": ["TCS", "HDFCBANK", "RANDOMCO"],
            "date": ["2026-07-29", "2026-07-29", "2026-07-29"],
            "sector": ["Information Technology", "Banks", "Unmapped Sector"],
        }))

        written = []
        monkeypatch.setattr(mf, "executemany", lambda sql, params: written.extend(params) or len(params))

        flow = pd.DataFrame({"sector": ["Information Technology", "Banks"], "flow_pct": [0.8, -0.4]})
        n = mf._update_technical_signals(flow)

        assert n == 2, "RANDOMCO's unmapped sector must be dropped, not written with a NaN flow value"
        written_symbols = {p[1] for p in written}
        assert written_symbols == {"TCS", "HDFCBANK"}


class TestZeroHoldingsFailsLoudly:
    """Regression test found live 2026-08-03 by the data-quality coverage sweep:
    mf_sector_allocation had 0 rows in production despite this fetcher "completing
    successfully" on every scheduled run for weeks. AMFI's DownloadSchemeData_Po.aspx
    endpoint currently returns the scheme MASTER list (no Total AUM / market-value /
    %-to-NAV columns at all) instead of the portfolio-holdings disclosure this parser
    expects, so _parse_amfi() correctly finds zero matching rows every single time --
    but run() used to just print a message and `return`, exiting 0. Fixed to sys.exit(1)
    so a silently-empty run is no longer indistinguishable from a healthy one."""

    def test_run_exits_nonzero_when_current_month_holdings_parse_empty(self, monkeypatch):
        monkeypatch.setattr(mf, "ensure_schema", lambda: None)
        monkeypatch.setattr(mf, "_load_sector_map", lambda: pd.DataFrame(columns=["isin", "symbol", "sector"]))
        monkeypatch.setattr(mf, "_load_saved_allocation", lambda month_str: pd.DataFrame(columns=["sector", "aum_pct"]))
        monkeypatch.setattr(mf, "_fetch_raw", lambda month_str: "irrelevant raw text")
        # Real AMFI-format-changed symptom: the parser runs but finds nothing.
        monkeypatch.setattr(mf, "_parse_amfi", lambda raw: pd.DataFrame())
        monkeypatch.setattr(mf.time, "sleep", lambda *_: None)

        with pytest.raises(SystemExit) as exc_info:
            mf.run(month_str="2026-06")
        assert exc_info.value.code == 1

    def test_run_proceeds_normally_when_holdings_parse_successfully(self, monkeypatch):
        # Sanity check the fix didn't make the happy path exit too.
        monkeypatch.setattr(mf, "ensure_schema", lambda: None)
        monkeypatch.setattr(mf, "_load_sector_map", lambda: pd.DataFrame({
            "isin": ["INF209K01165"], "symbol": ["ABSLAMC"], "sector": ["Financial Services"],
        }))
        monkeypatch.setattr(mf, "_load_saved_allocation", lambda month_str: pd.DataFrame(columns=["sector", "aum_pct"]))
        monkeypatch.setattr(mf, "_fetch_raw", lambda month_str: "irrelevant raw text")
        monkeypatch.setattr(mf, "_parse_amfi", lambda raw: pd.DataFrame({
            "isin": ["INF209K01165"], "name": ["x"], "industry": ["Financial Services"],
            "mkt_val": [1000.0], "pct_nav": [5.0],
        }))
        monkeypatch.setattr(mf, "_save_sector_allocation", lambda month_str, df: None)
        monkeypatch.setattr(mf, "_update_macro_asset_prices", lambda flow, month_str: None)
        monkeypatch.setattr(mf, "_update_technical_signals", lambda flow: 0)
        monkeypatch.setattr(mf.time, "sleep", lambda *_: None)

        # Prior-month fetch fails harmlessly (already tolerated by the existing try/except).
        monkeypatch.setattr(mf, "_fetch_raw", lambda month_str: (_ for _ in ()).throw(RuntimeError("boom"))
                             if month_str == "2026-05" else "irrelevant raw text")

        mf.run(month_str="2026-06")  # must not raise SystemExit
