import sys
import os
import datetime
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.intraday_features import compute_intraday_features

_IST  = datetime.timezone(datetime.timedelta(hours=5, minutes=30))
_DATE = '2026-06-22'
_COLS = ['symbol', 'datetime', 'open', 'high', 'low', 'close', 'volume', 'vwap', 'interval']


def _bar(sym, hour, minute, open_, high, low, close, vol, vwap):
    dt = datetime.datetime(2026, 6, 22, hour, minute, tzinfo=_IST).isoformat()
    return {'symbol': sym, 'datetime': dt, 'open': open_,
            'high': high, 'low': low, 'close': close,
            'volume': vol, 'vwap': vwap, 'interval': '15m'}


def _session(sym, *, or_high=105.0, or_low=95.0, last_close=100.0):
    """25 bars covering a full NSE session (9:15–15:30 IST). First 2 bars set the
    opening range. Last bar has the given last_close."""
    times = [
        (9,15),(9,30),(9,45),(10,0),(10,15),(10,30),(10,45),
        (11,0),(11,15),(11,30),(11,45),(12,0),(12,15),(12,30),
        (12,45),(13,0),(13,15),(13,30),(13,45),(14,0),(14,15),
        (14,30),(14,45),(15,0),(15,15),
    ]
    bars = []
    for i, (h, m) in enumerate(times):
        close = last_close if i == len(times) - 1 else 100.0
        hi = or_high if i < 2 else 102.0
        lo = or_low  if i < 2 else 98.0
        bars.append(_bar(sym, h, m, 100.0, hi, lo, close, 10_000 if i < 4 else 5_000, 100.0))
    return bars


class TestOpeningRangeBreak:
    def test_breakout_above_gives_plus_one(self, monkeypatch):
        bars = pd.DataFrame(_session('INFY', or_high=105.0, or_low=95.0, last_close=107.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'INFY']['opening_range_break'].iloc[0]
        assert orb == 1.0

    def test_breakout_below_gives_minus_one(self, monkeypatch):
        bars = pd.DataFrame(_session('TCS', or_high=105.0, or_low=95.0, last_close=93.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'TCS']['opening_range_break'].iloc[0]
        assert orb == -1.0

    def test_inside_day_gives_zero(self, monkeypatch):
        bars = pd.DataFrame(_session('HDFC', or_high=105.0, or_low=95.0, last_close=100.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        orb = result[result['symbol'] == 'HDFC']['opening_range_break'].iloc[0]
        assert orb == 0.0


class TestVwapDeviation:
    def test_close_above_vwap_is_positive(self, monkeypatch):
        bars = pd.DataFrame([_bar('SYM', 9, 15, 100, 105, 95, 110, 10_000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        dev = result[result['symbol'] == 'SYM']['vwap_deviation_pct'].iloc[0]
        assert dev > 0.0

    def test_close_below_vwap_is_negative(self, monkeypatch):
        bars = pd.DataFrame([_bar('SYM2', 9, 15, 100, 105, 95, 90, 10_000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        dev = result[result['symbol'] == 'SYM2']['vwap_deviation_pct'].iloc[0]
        assert dev < 0.0


class TestFirstHourVolShare:
    def test_front_loaded_volume_gives_high_share(self, monkeypatch):
        df = pd.DataFrame(_session('VOLSYM'))
        df['volume'] = [100_000] * 4 + [1] * 21
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        share = result[result['symbol'] == 'VOLSYM']['first_hour_vol_share'].iloc[0]
        assert share > 0.9

    def test_uniform_volume_gives_four_twenty_fifths(self, monkeypatch):
        df = pd.DataFrame(_session('UNIFORM'))
        df['volume'] = 1.0
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        share = result[result['symbol'] == 'UNIFORM']['first_hour_vol_share'].iloc[0]
        assert abs(share - 4 / 25) < 0.05

    def test_empty_data_returns_empty(self, monkeypatch):
        monkeypatch.setattr(
            'src.server.intraday_features.read_df',
            lambda sql, params=(): pd.DataFrame(columns=_COLS),
        )
        result = compute_intraday_features(_DATE)
        assert result.empty

    def test_output_columns(self, monkeypatch):
        df = pd.DataFrame([_bar('A', 9, 15, 100, 105, 95, 100, 1000, 100.0)])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        for col in ['symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share']:
            assert col in result.columns
