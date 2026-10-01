"""AF-20261001-23/-24: recommendation_log geometry from scoring_engine._log_recommendations.

- ATR came from confluence_signals.atr, which was `cmp * bb_width / 100` (~0.13% of price,
  ~30x too small), so 97% of rows sat on the 2% stop / 3% target floor whatever the stock's
  volatility. ATR now comes from stock_ohlcv directly.
- entry_price was NULL for symbols with no technical_signals row (376 of 27,156 rows,
  2026-09) although stock_ohlcv had a current close for them.
- horizon_days was 15 for every row, so an 'intraday' rec was graded over 15 sessions.
"""
import datetime
import math
import os
import sys

from sqlalchemy import text

sys.path.insert(0, os.path.dirname(__file__))
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from scoring_engine import AlphaQuantScoringEngine  # noqa: E402
from test_scoring_engine_log_recommendations import _FakeSelf, _make_engine  # noqa: E402


def _seed_ohlcv(engine, symbol, close=100.0, rng=4.0, n=30):
    today = datetime.date.today()
    with engine.begin() as conn:
        conn.execute(text(
            "CREATE TABLE IF NOT EXISTS stock_ohlcv (symbol TEXT, date TEXT, high REAL, low REAL,"
            " close REAL, is_suspect INTEGER)"))
        for i in range(n):
            d = (today - datetime.timedelta(days=n - i)).isoformat()
            conn.execute(text("INSERT INTO stock_ohlcv VALUES (:s, :d, :h, :l, :c, 0)"),
                         {"s": symbol, "d": d, "h": close + rng / 2, "l": close - rng / 2, "c": close})


def _rows(engine):
    with engine.begin() as conn:
        return {r[0]: r[1:] for r in conn.execute(text(
            "SELECT timeframe, entry_price, stop_loss, target_1, horizon_days FROM recommendation_log"))}


def _log(engine, symbol, timeframe):
    AlphaQuantScoringEngine._log_recommendations(_FakeSelf(engine), [{
        "symbol": symbol, "classification": "Buy", "timeframe": timeframe,
        "confidence": 70.0, "score": 70.0, "reasons": "x"}])


def test_entry_price_falls_back_to_stock_ohlcv_close():
    engine = _make_engine()
    _seed_ohlcv(engine, "NOTECH", close=250.0, rng=5.0)   # no technical_signals row at all
    _log(engine, "NOTECH", "long_term")
    entry = _rows(engine)["long_term"][0]
    assert entry == 250.0


def test_barriers_use_true_atr_and_scale_with_horizon():
    engine = _make_engine()
    _seed_ohlcv(engine, "ABC", close=100.0, rng=4.0)        # true range 4 => ATR 4 (4%)
    _log(engine, "ABC", "intraday")
    _log(engine, "ABC", "long_term")
    rows = _rows(engine)
    i_entry, i_stop, i_t1, i_h = rows["intraday"]
    l_entry, l_stop, l_t1, l_h = rows["long_term"]
    assert i_h == 1 and l_h == 15
    # 1.5 ATR at 5 sessions, scaled by sqrt(h/5); clamped by compute_atr_barriers' 2-8% band
    assert math.isclose(i_entry - i_stop, max(2.0, 1.5 * 4 * math.sqrt(1 / 5)), abs_tol=0.02)
    assert math.isclose(l_entry - l_stop, min(8.0, 1.5 * 4 * math.sqrt(15 / 5)), abs_tol=0.02)
    assert (l_t1 - l_entry) > (i_t1 - i_entry)
