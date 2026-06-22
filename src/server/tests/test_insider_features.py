import sys
import os
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.insider_features import compute_insider_features, BUY_TYPES, SELL_TYPES


def _trades(*rows):
    return pd.DataFrame(rows)


class TestComputeInsiderFeatures:
    def test_empty_returns_empty_df(self, monkeypatch):
        monkeypatch.setattr(
            'src.server.insider_features.read_df',
            lambda sql, params=(): pd.DataFrame(columns=['symbol', 'typeOfTransaction', 'quantity']),
        )
        result = compute_insider_features('2026-06-22')
        assert result.empty

    def test_pure_buy_gives_near_one(self, monkeypatch):
        data = _trades(
            {'symbol': 'INFY', 'typeOfTransaction': 'BUY', 'quantity': 1000},
            {'symbol': 'INFY', 'typeOfTransaction': 'BUY', 'quantity': 500},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'INFY']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.9

    def test_pure_sell_gives_near_zero(self, monkeypatch):
        data = _trades({'symbol': 'TCS', 'typeOfTransaction': 'SELL', 'quantity': 2000})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'TCS']['insider_buy_pct_90d'].iloc[0]
        assert val < 0.1

    def test_mixed_trades_between_zero_and_one(self, monkeypatch):
        data = _trades(
            {'symbol': 'HDFC', 'typeOfTransaction': 'BUY',  'quantity': 1000},
            {'symbol': 'HDFC', 'typeOfTransaction': 'SELL', 'quantity': 1000},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'HDFC']['insider_buy_pct_90d'].iloc[0]
        assert 0.0 < val < 1.0

    def test_output_bounded_zero_to_one(self, monkeypatch):
        data = _trades({'symbol': 'SYM', 'typeOfTransaction': 'BUY', 'quantity': 999_999})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result['insider_buy_pct_90d'].iloc[0]
        assert 0.0 <= val <= 1.0

    def test_case_insensitive_transaction_type(self, monkeypatch):
        data = _trades(
            {'symbol': 'WIPRO', 'typeOfTransaction': 'buy',  'quantity': 500},
            {'symbol': 'WIPRO', 'typeOfTransaction': 'Sell', 'quantity': 100},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'WIPRO']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.5  # net buying

    def test_unknown_transaction_type_ignored(self, monkeypatch):
        """Rows with unrecognised typeOfTransaction should not count as buy or sell."""
        data = _trades(
            {'symbol': 'AXISBANK', 'typeOfTransaction': 'TRANSMISSION', 'quantity': 9999},
            {'symbol': 'AXISBANK', 'typeOfTransaction': 'BUY',          'quantity': 100},
        )
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        val = result[result['symbol'] == 'AXISBANK']['insider_buy_pct_90d'].iloc[0]
        assert val > 0.9  # only BUY counted — TRANSMISSION is ignored

    def test_result_columns(self, monkeypatch):
        data = _trades({'symbol': 'X', 'typeOfTransaction': 'BUY', 'quantity': 1})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        result = compute_insider_features('2026-06-22')
        assert list(result.columns) == ['symbol', 'insider_buy_pct_90d']
