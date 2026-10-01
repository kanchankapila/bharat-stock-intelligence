"""technical_analysis_engine must not publish a signal it cannot price (AF-20261001-12).

Live 2026-10-01: 63 of 251 'technical' Neutral rows carried entry/target/stop = 0 -- every one
from HOCL/IL/TANFACIND, whose stock_ohlcv closes are all 0.0 and whose last bar is 2026-09-11/15,
yet they were re-published daily through 2026-09-29 dated with the market's latest session.
"""
import os
import sys

import pandas as pd

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..'))

import technical_analysis_engine as tae  # noqa: E402


def _engine_with(df):
    eng = tae.TechnicalAnalysisEngine.__new__(tae.TechnicalAnalysisEngine)  # no DB connection
    eng.load_ohlcv = lambda symbol: df
    return eng


def _bars(close, n=60, last='2026-09-29'):
    dates = pd.bdate_range(end=last, periods=n)
    return pd.DataFrame({
        'date': [d.date() for d in dates],
        'open': [close] * n, 'high': [close * 1.01] * n, 'low': [close * 0.99] * n,
        'close': [close] * n, 'volume': [1000] * n,
    })


def test_all_zero_closes_publish_nothing():
    assert _engine_with(_bars(0.0)).analyze_stock('HOCL') is None


def test_priced_symbol_still_analyzed():
    row = _engine_with(_bars(100.0)).analyze_stock('OK')
    assert row is not None and row['entry_price'] > 0


def test_stale_symbol_not_published_under_todays_date():
    fresh = _engine_with(_bars(100.0, last='2026-09-29')).analyze_stock('FRESH')
    stale = _engine_with(_bars(100.0, last='2026-09-15')).analyze_stock('STALE')
    kept = tae.drop_stale([fresh, stale], '2026-09-29')
    assert [r['symbol'] for r in kept] == ['FRESH']
