import sys
import os
import pandas as pd
import pytest

sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', '..', '..'))
from src.server.insider_features import compute_insider_features, BUY_TYPES, SELL_TYPES, run


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


class TestRealVendorTransactionStrings:
    """AF-20260913-03: BUY_TYPES matched by exact set membership, and NSE's real strings are
    'ACQUISITION -  MARKET PURCHASE' / 'DISPOSAL -  MARKET SALE' (18.7k rows each), so only the
    1,545 Tickertape BUY/SELL rows ever counted. Everything else -- ESOP, pledge, gift -- fell
    through to buy=0, and 0 on this scale means 'maximum insider selling'."""

    def _run(self, monkeypatch, *rows):
        data = _trades(*rows)
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        res = compute_insider_features('2026-06-22')
        return dict(zip(res['symbol'], res['insider_buy_pct_90d']))

    def test_nse_market_purchase_counts_as_buy(self, monkeypatch):
        out = self._run(monkeypatch,
                        {'symbol': 'A', 'typeOfTransaction': 'Acquisition -  Market Purchase', 'quantity': 900},
                        {'symbol': 'A', 'typeOfTransaction': 'Disposal -  Market Sale', 'quantity': 100})
        assert out['A'] == pytest.approx(0.9)

    def test_non_market_activity_is_neutral_not_max_selling(self, monkeypatch):
        out = self._run(monkeypatch,
                        {'symbol': 'B', 'typeOfTransaction': 'Acquisition -  ESOP', 'quantity': 5000},
                        {'symbol': 'B', 'typeOfTransaction': 'Pledge -  Creation of Pledge', 'quantity': 5000})
        assert out['B'] == pytest.approx(0.5)

    def test_duplicated_vendor_rows_count_once(self, monkeypatch):
        trade = {'symbol': 'C', 'acquirerName': 'x', 'typeOfTransaction': 'Market Purchase',
                 'quantity': 100, 'date_iso': '2026-06-01'}
        sell = {'symbol': 'C', 'acquirerName': 'y', 'typeOfTransaction': 'Market Sale',
                'quantity': 100, 'date_iso': '2026-06-02'}
        out = self._run(monkeypatch, trade, dict(trade), dict(trade), sell)
        assert out['C'] == pytest.approx(0.5)


class TestInsiderHistory:
    """feature_store needs a point-in-time series per date, not just today's value."""

    def test_series_uses_disclosure_lag_window_and_neutral_default(self):
        from src.server.insider_features import insider_buy_pct_series, DISCLOSURE_LAG_DAYS
        trades = _trades(
            {'acquirerName': 'p', 'typeOfTransaction': 'Market Purchase', 'quantity': 300, 'date_iso': '2026-01-05'},
        )
        dates = pd.to_datetime(['2026-01-06', '2026-01-05'] + [
            str((pd.Timestamp('2026-01-05') + pd.Timedelta(days=DISCLOSURE_LAG_DAYS)).date()),
            '2026-03-01', '2026-06-01'])
        s = insider_buy_pct_series(trades, dates)
        assert s.iloc[0] == 0.5 and s.iloc[1] == 0.5, "a trade must not be visible before it is disclosed"
        assert s.iloc[2] == pytest.approx(1.0)
        assert s.iloc[3] == pytest.approx(1.0)
        assert s.iloc[4] == 0.5, "window is 90 days"

    def test_empty_trades_give_neutral(self):
        from src.server.insider_features import insider_buy_pct_series
        dates = pd.to_datetime(['2026-01-05', '2026-01-06'])
        s = insider_buy_pct_series(pd.DataFrame(), dates)
        assert list(s) == [0.5, 0.5]


class TestRunUsesLogicalTradingDate:
    """2026-08-01: run() targeted date.today() for its `UPDATE ... WHERE date = ?`, which
    silently wrote 0 rows whenever ml-daily-ops's step chain crossed midnight IST -- confirmed
    live: 2026-07-31's technical_signals row was still 4/2187 populated (the exact pre-fix
    symptom) because the run that should have written it executed at 2026-08-01 01:23 IST.
    run() must use logical_trading_date(), not a raw wall-clock date, as its write target."""

    def test_run_targets_logical_trading_date_not_raw_today(self, monkeypatch):
        data = _trades({'symbol': 'INFY', 'typeOfTransaction': 'BUY', 'quantity': 1000})
        monkeypatch.setattr('src.server.insider_features.read_df', lambda sql, params=(): data)
        monkeypatch.setattr('src.server.insider_features.connect', lambda: type(
            'C', (), {'close': lambda self: None})()
        )
        monkeypatch.setattr('src.server.insider_features.logical_trading_date', lambda: '2026-07-31')

        captured = {}

        def _fake_executemany(sql, rows):
            captured['sql'] = sql
            captured['rows'] = rows

        monkeypatch.setattr('src.server.insider_features.executemany', _fake_executemany)

        run()

        assert captured['rows'], "expected at least one row written"
        for _pct, _symbol, written_date in captured['rows']:
            assert written_date == '2026-07-31', (
                "run() must write against logical_trading_date()'s value, not date.today()"
            )

    def test_run_wires_logical_trading_date_into_compute(self, monkeypatch):
        """Proves the wiring specifically (as opposed to the helper's own correctness, already
        covered by test_as_of_logical_trading_date.py): whatever logical_trading_date()
        returns is exactly what reaches compute_insider_features -- not date.today()."""
        seen_dates = []

        def _fake_compute(cutoff_date):
            seen_dates.append(cutoff_date)
            return pd.DataFrame(columns=['symbol', 'insider_buy_pct_90d'])  # empty -> no write

        monkeypatch.setattr('src.server.insider_features.connect', lambda: type(
            'C', (), {'close': lambda self: None})()
        )
        monkeypatch.setattr('src.server.insider_features.logical_trading_date', lambda: '2099-01-01')
        monkeypatch.setattr('src.server.insider_features.compute_insider_features', _fake_compute)

        run()

        assert seen_dates == ['2099-01-01']
