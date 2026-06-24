"""
Tests for ml_ensemble.py
"""
import pytest


def test_load_training_data_includes_stop_loss(monkeypatch):
    """STOP_LOSS outcomes must be mapped to 0 (LOSS), not dropped."""
    import pandas as pd
    from ml_ensemble import load_training_data

    fake_rows = [
        {'symbol': 'A', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'WIN',       'signal_score': 70, 'signals_json': '{}', 'return_pct': 3.0,
         'rsi': 55, 'adx': 22, 'nifty_regime': 'BULL', 'cmp': 100, 'sma200': 95,
         'volume_ratio': 1.2, 'fii_3d_net': 100, 'above_sma200': 1, 'pcr_oi': 1.1,
         'pcr_vol': 1.0, 'fii_10d_net': 200, 'dii_3d_net': 50, 'delivery_pct': 60,
         'sector_ret_5d': 0.5, 'sector_ret_21d': 1.2, 'iv_rank': 0.4, 'iv_skew': 0.1,
         'rs_rank_21d': 0.7, 'rs_rank_63d': 0.6, 'insider_buy_pct_90d': 0.2,
         'opening_range_break': 1, 'vwap_deviation_pct': 0.3, 'first_hour_vol_share': 0.25,
         'fifty_two_week_high': 120, 'piotroski_f_score': 7, 'debt_to_equity': 0.3,
         'operating_margins': 0.18, 'return_on_equity': 0.22, 'revenue_growth': 0.12,
         'earnings_growth': 0.15, 'earnings_yield': 0.05, 'price_to_book': 3.0,
         'market_cap': 1e10, 'n_analysts': 5, 'buy_count': 3, 'target_mean': 115,
         'altman_z': 2.5, 'ohlson_o': -2.0},
        {'symbol': 'B', 'signal_date': '2025-01-10', 'horizon_days': 5,
         'outcome': 'STOP_LOSS', 'signal_score': 65, 'signals_json': '{}', 'return_pct': -4.5,
         'rsi': 40, 'adx': 18, 'nifty_regime': 'BEAR', 'cmp': 200, 'sma200': 210,
         'volume_ratio': 0.8, 'fii_3d_net': -50, 'above_sma200': 0, 'pcr_oi': 0.9,
         'pcr_vol': 0.85, 'fii_10d_net': -100, 'dii_3d_net': 20, 'delivery_pct': 45,
         'sector_ret_5d': -1.0, 'sector_ret_21d': -2.5, 'iv_rank': 0.7, 'iv_skew': -0.2,
         'rs_rank_21d': 0.3, 'rs_rank_63d': 0.25, 'insider_buy_pct_90d': 0.0,
         'opening_range_break': 0, 'vwap_deviation_pct': -0.5, 'first_hour_vol_share': 0.15,
         'fifty_two_week_high': 250, 'piotroski_f_score': 4, 'debt_to_equity': 1.2,
         'operating_margins': 0.08, 'return_on_equity': 0.10, 'revenue_growth': -0.05,
         'earnings_growth': -0.10, 'earnings_yield': 0.03, 'price_to_book': 1.5,
         'market_cap': 5e9, 'n_analysts': 3, 'buy_count': 1, 'target_mean': 220,
         'altman_z': 1.8, 'ohlson_o': -0.5},
    ]

    monkeypatch.setattr('ml_ensemble.read_df', lambda q, p=None: pd.DataFrame(fake_rows))
    df = load_training_data()

    assert len(df) == 2, f"Expected 2 rows, got {len(df)}: STOP_LOSS row should not be dropped"
    stop_row = df[df.index == 1] if 1 in df.index else df.iloc[1:2]
    # STOP_LOSS must be mapped to 0, not NaN
    assert df['outcome'].notna().all(), "STOP_LOSS must be mapped to 0, not NaN/dropped"
    assert df['outcome'].iloc[1] == 0, "STOP_LOSS must map to 0 (LOSS)"
