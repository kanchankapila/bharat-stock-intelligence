import pandas as pd
import pytest
from unittest.mock import patch


def test_run_excludes_index_symbols(monkeypatch):
    """stock_ohlcv JOIN nse_stocks must filter out index symbols like NIFTY50."""
    queries_executed = []

    def fake_read_df(sql, params=None):
        queries_executed.append(sql)
        return pd.DataFrame(columns=['symbol', 'date', 'close'])

    monkeypatch.setattr('relative_strength.read_df', fake_read_df)
    from relative_strength import run
    run()

    assert queries_executed, "read_df should have been called"
    ohlcv_query = queries_executed[0]
    assert 'JOIN nse_stocks' in ohlcv_query or 'join nse_stocks' in ohlcv_query.lower(), \
        "OHLCV query must JOIN nse_stocks to exclude index symbols"
