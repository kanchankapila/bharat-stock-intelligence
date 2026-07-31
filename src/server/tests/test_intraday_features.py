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
        bars = pd.DataFrame([
            _bar('SYM', 9, 15, 100, 105, 95, 100, 10_000, 100.0),
            _bar('SYM', 9, 30, 100, 105, 95, 110, 10_000, 100.0),
        ])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): bars)
        result = compute_intraday_features(_DATE)
        dev = result[result['symbol'] == 'SYM']['vwap_deviation_pct'].iloc[0]
        assert dev > 0.0

    def test_close_below_vwap_is_negative(self, monkeypatch):
        bars = pd.DataFrame([
            _bar('SYM2', 9, 15, 100, 105, 95, 100, 10_000, 100.0),
            _bar('SYM2', 9, 30, 100, 105, 95, 90, 10_000, 100.0),
        ])
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
        df = pd.DataFrame([
            _bar('A', 9, 15, 100, 105, 95, 100, 1000, 100.0),
            _bar('A', 9, 30, 100, 105, 95, 100, 1000, 100.0),
        ])
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): df)
        result = compute_intraday_features(_DATE)
        for col in ['symbol', 'opening_range_break', 'vwap_deviation_pct', 'first_hour_vol_share']:
            assert col in result.columns


def _snapshot_bar(sym, hour, minute, second, price):
    """The synthetic 'last price' quote both vendors append to the history array, stamped at
    request time instead of on the bar grid: zero volume, open==high==low==close."""
    dt = datetime.datetime(2026, 6, 22, hour, minute, second, tzinfo=_IST).isoformat()
    return {'symbol': sym, 'datetime': dt, 'open': price, 'high': price, 'low': price,
            'close': price, 'volume': 0, 'vwap': None, 'interval': '15m'}


class TestOffGridBarsDoNotShiftWindows:
    """Regression for the 2026-07-31 audit finding: windows were taken POSITIONALLY
    (grp.iloc[:2] / grp.iloc[:4]), so interleaved off-grid snapshot rows shortened the
    'first 30 minutes' / 'first hour' windows -- measured live, the stored
    first_hour_vol_share correlated only 0.642 with the correct value (5.9% exact match).
    intraday_fetcher.py now drops these at write time, but ~2M already exist in the
    compressed hypertable and are not being backfilled out, so the read side must defend."""

    def _polluted(self, sym):
        bars = _session(sym, or_high=105.0, or_low=95.0, last_close=100.0)
        # one snapshot row after each of the first four real bars -- positional selection
        # would consume the window with these and cover 30 min instead of 60
        return bars + [
            _snapshot_bar(sym, 9, 15, 20, 100.0),
            _snapshot_bar(sym, 9, 30, 18, 100.0),
            _snapshot_bar(sym, 9, 45, 21, 100.0),
            _snapshot_bar(sym, 10, 0, 17, 100.0),
        ]

    def test_first_hour_share_matches_clean_session(self, monkeypatch):
        clean = pd.DataFrame(_session('INFY'))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): clean)
        expected = compute_intraday_features(_DATE)['first_hour_vol_share'].iloc[0]

        polluted = pd.DataFrame(self._polluted('INFY'))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): polluted)
        got = compute_intraday_features(_DATE)['first_hour_vol_share'].iloc[0]
        assert got == pytest.approx(expected)

    def test_opening_range_matches_clean_session(self, monkeypatch):
        """An opening range widened by a flat snapshot row would mask a real breakout."""
        clean = pd.DataFrame(_session('TCS', or_high=105.0, or_low=95.0, last_close=107.0))
        monkeypatch.setattr('src.server.intraday_features.read_df', lambda sql, params=(): clean)
        expected = compute_intraday_features(_DATE)['opening_range_break'].iloc[0]

        # snapshot printed at 108 -- above both the real opening-range high (105) and the
        # closing price (107). If it is allowed into the opening range it lifts or_high to 108
        # and the genuine breakout silently reads as "inside range".
        bars = _session('TCS', or_high=105.0, or_low=95.0, last_close=107.0)
        bars += [_snapshot_bar('TCS', 9, 15, 20, 108.0), _snapshot_bar('TCS', 9, 30, 18, 108.0)]
        monkeypatch.setattr('src.server.intraday_features.read_df',
                            lambda sql, params=(): pd.DataFrame(bars))
        got = compute_intraday_features(_DATE)['opening_range_break'].iloc[0]
        assert got == expected == 1.0


class TestVwapFallbackWhenColumnNull:
    """intraday_ohlcv.vwap was a literal NULL on every row until 2026-07-31. The old code
    fell straight through to vwap_dev = 0.0, so the feature was a constant zero for every
    symbol on every session while passing any non-null coverage check."""

    def test_null_vwap_column_still_yields_a_real_deviation(self, monkeypatch):
        bars = _session('INFY', last_close=110.0)
        for b in bars:
            b['vwap'] = None          # exactly the historical state of the column
        monkeypatch.setattr('src.server.intraday_features.read_df',
                            lambda sql, params=(): pd.DataFrame(bars))
        dev = compute_intraday_features(_DATE)['vwap_deviation_pct'].iloc[0]
        assert dev != 0.0, "must fall back to VWAP derived from the bars themselves"
        assert dev > 0, "last close 110 is above the ~100 session VWAP"

    def test_stored_vwap_is_preferred_when_present(self, monkeypatch):
        bars = _session('INFY', last_close=110.0)
        for b in bars:
            b['vwap'] = 100.0
        monkeypatch.setattr('src.server.intraday_features.read_df',
                            lambda sql, params=(): pd.DataFrame(bars))
        dev = compute_intraday_features(_DATE)['vwap_deviation_pct'].iloc[0]
        assert dev == pytest.approx(10.0)   # (110 - 100) / 100 * 100
