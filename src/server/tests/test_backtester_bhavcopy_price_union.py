"""
Regression coverage for Backtester.load_ohlcv / load_bhavcopy_adjusted -- the survivorship
price-union fix (see backtester.py's own docstrings on load_ohlcv/load_bhavcopy_adjusted).

Written 2026-08-05 while investigating a pipeline-review finding that claimed this was still
open ("survivorship bias closed in universe selection, not yet in prices") -- the finding was
stale: the union is already implemented and wired into load_ohlcv(). This locks the two things
that would be easy to silently break: (1) a bar strictly BEFORE a split's ex_date is scaled by
the factor so it lands on the same basis as stock_ohlcv's split-adjusted prices, while the
ex_date bar itself and everything after it are left untouched; (2) load_ohlcv only reaches for
the bhavcopy fallback for symbols genuinely missing from stock_ohlcv, never for ones already
present there (a name with SOME stock_ohlcv history must never get its real prices silently
swapped for a raw bhavcopy series).
"""
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import pandas as pd
import pytest

import backtester as bt


def _fake_read_df(nse_universe_rows=None, adjustment_rows=None, stock_ohlcv_rows=None):
    """Builds a read_df() stand-in that dispatches on which table the SQL string names --
    backtester.py always calls read_df(f"...") with the table baked into the query text, never
    with bound params, so keying on substring is the same shape the real callers use."""
    nse_universe_rows = nse_universe_rows if nse_universe_rows is not None else []
    adjustment_rows = adjustment_rows if adjustment_rows is not None else []
    stock_ohlcv_rows = stock_ohlcv_rows if stock_ohlcv_rows is not None else []

    def fake(query, *args, **kwargs):
        if 'FROM ohlcv_adjustment_factors' in query:
            cols = ['symbol', 'ex_date', 'factor']
            return pd.DataFrame(adjustment_rows, columns=cols)
        if 'FROM nse_universe_history' in query:
            cols = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume']
            return pd.DataFrame(nse_universe_rows, columns=cols)
        if 'FROM stock_ohlcv' in query:
            cols = ['symbol', 'date', 'open', 'high', 'low', 'close', 'volume']
            return pd.DataFrame(stock_ohlcv_rows, columns=cols)
        raise AssertionError(f"unexpected query in fake read_df: {query[:120]}")

    return fake


class TestLoadBhavcopyAdjusted:
    def test_scales_bars_strictly_before_ex_date(self, monkeypatch):
        # Prices as floats -- matching what read_df actually returns for a real NUMERIC/REAL
        # Postgres column (via SQLAlchemy, typically object/Decimal -> pd.to_numeric -> float64).
        # An all-integer literal list here would make pandas infer int64 for the column, which
        # is not the dtype this code path sees with real DB-sourced data.
        rows = [
            ('DELISTED1', '2023-05-01', 200.0, 205.0, 195.0, 200.0, 10000),
            ('DELISTED1', '2023-06-01', 104.0, 106.0, 103.0, 105.0, 12000),   # the ex-date bar itself
            ('DELISTED1', '2023-07-01', 108.0, 112.0, 107.0, 110.0, 9000),
        ]
        fac = [('DELISTED1', '2023-06-01', 0.5)]  # e.g. a 2:1 split
        monkeypatch.setattr(bt, 'read_df', _fake_read_df(nse_universe_rows=rows, adjustment_rows=fac))

        b = bt.Backtester.__new__(bt.Backtester)  # skip __init__ -- no DB connection needed
        out = b.load_bhavcopy_adjusted(['DELISTED1'], '2023-01-01', '2023-12-31')

        by_date = out.set_index(out['date'].dt.strftime('%Y-%m-%d'))
        assert by_date.loc['2023-05-01', 'close'] == pytest.approx(100.0)   # 200 * 0.5
        assert by_date.loc['2023-06-01', 'close'] == pytest.approx(105.0)   # ex-date bar untouched
        assert by_date.loc['2023-07-01', 'close'] == pytest.approx(110.0)   # post-split untouched

    def test_applies_cumulative_factor_across_two_splits(self, monkeypatch):
        rows = [
            ('DELISTED1', '2023-01-01', 400.0, 405.0, 395.0, 400.0, 10000),  # before BOTH splits
            ('DELISTED1', '2023-06-01', 195.0, 205.0, 190.0, 200.0, 12000),  # between the two splits
            ('DELISTED1', '2023-09-01', 108.0, 112.0, 107.0, 110.0, 9000),   # after both
        ]
        fac = [
            ('DELISTED1', '2023-03-01', 0.5),
            ('DELISTED1', '2023-08-01', 0.5),
        ]
        monkeypatch.setattr(bt, 'read_df', _fake_read_df(nse_universe_rows=rows, adjustment_rows=fac))

        b = bt.Backtester.__new__(bt.Backtester)
        out = b.load_bhavcopy_adjusted(['DELISTED1'], '2023-01-01', '2023-12-31')

        by_date = out.set_index(out['date'].dt.strftime('%Y-%m-%d'))
        # Before both splits: hit by both factors -> 400 * 0.5 * 0.5 = 100
        assert by_date.loc['2023-01-01', 'close'] == pytest.approx(100.0)
        # Between the two splits: only the second (later) split applies -> 200 * 0.5 = 100
        assert by_date.loc['2023-06-01', 'close'] == pytest.approx(100.0)
        # After both: untouched
        assert by_date.loc['2023-09-01', 'close'] == pytest.approx(110.0)

    def test_no_symbols_short_circuits(self, monkeypatch):
        called = {'n': 0}

        def boom(*a, **k):
            called['n'] += 1
            raise AssertionError('read_df should not be called for an empty symbol list')

        monkeypatch.setattr(bt, 'read_df', boom)
        b = bt.Backtester.__new__(bt.Backtester)
        out = b.load_bhavcopy_adjusted([], '2023-01-01', '2023-12-31')
        assert out.empty
        assert called['n'] == 0

    def test_missing_adjustment_table_degrades_to_empty_not_a_crash(self, monkeypatch):
        def boom(query, *a, **k):
            raise Exception('relation "ohlcv_adjustment_factors" does not exist')

        monkeypatch.setattr(bt, 'read_df', boom)
        b = bt.Backtester.__new__(bt.Backtester)
        out = b.load_bhavcopy_adjusted(['DELISTED1'], '2023-01-01', '2023-12-31')
        assert out.empty


class TestLoadOhlcvSurvivorshipFallback:
    def test_fills_only_symbols_missing_from_stock_ohlcv(self, monkeypatch):
        live_rows = [
            ('LIVE1', '2023-05-01', 100.0, 105.0, 95.0, 102.0, 5000),
        ]
        delisted_rows = [
            ('DELISTED1', '2023-05-01', 200.0, 205.0, 195.0, 200.0, 10000),
        ]
        fac = []  # no splits -- keep the math trivial, this test is about the merge, not scaling
        monkeypatch.setattr(
            bt, 'read_df',
            _fake_read_df(nse_universe_rows=delisted_rows, adjustment_rows=fac, stock_ohlcv_rows=live_rows),
        )

        b = bt.Backtester.__new__(bt.Backtester)
        out = b.load_ohlcv(['LIVE1', 'DELISTED1'], '2023-01-01', '2023-12-31')

        assert set(out['symbol'].unique()) == {'LIVE1', 'DELISTED1'}
        live_close = out[out['symbol'] == 'LIVE1']['close'].iloc[0]
        delisted_close = out[out['symbol'] == 'DELISTED1']['close'].iloc[0]
        assert live_close == pytest.approx(102.0)      # untouched, came from stock_ohlcv
        assert delisted_close == pytest.approx(200.0)  # filled from the bhavcopy fallback

    def test_never_overrides_a_symbol_already_in_stock_ohlcv(self, monkeypatch):
        """A symbol present in stock_ohlcv (even with sparse history) must never have its real
        prices silently swapped for the raw bhavcopy series -- the fallback is a gap-filler for
        symbols ENTIRELY absent, not a second opinion on ones already covered."""
        live_rows = [('BOTH', '2023-05-01', 50.0, 55.0, 45.0, 52.0, 1000)]
        bhavcopy_rows = [('BOTH', '2023-05-01', 999.0, 999.0, 999.0, 999.0, 1)]  # deliberately wrong value
        monkeypatch.setattr(
            bt, 'read_df',
            _fake_read_df(nse_universe_rows=bhavcopy_rows, adjustment_rows=[], stock_ohlcv_rows=live_rows),
        )

        b = bt.Backtester.__new__(bt.Backtester)
        out = b.load_ohlcv(['BOTH'], '2023-01-01', '2023-12-31')

        assert len(out) == 1
        assert out['close'].iloc[0] == pytest.approx(52.0)  # stock_ohlcv's value, not bhavcopy's
