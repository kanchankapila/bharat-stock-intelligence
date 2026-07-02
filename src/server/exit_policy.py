"""
Exit-Policy Head
================
The ensemble answers "will this entry win?". It says nothing about HOW to exit. This head
learns the exit side from the path labels in signal_excursions (written by exit_labeler.py):
two regressors that predict, from the same entry-time features the ensemble uses,

  expected MFE %  — how far the trade is likely to run in our favour  → where to set the target
  expected MAE %  — how far it is likely to draw down against us       → where to set the stop

`suggest_levels()` turns those predictions into concrete target/stop prices: we capture a
fraction of the expected favourable excursion (you rarely sell the exact high) and give the
stop a buffer beyond the expected adverse excursion (so normal noise doesn't knock us out).

Reuses ml_ensemble.build_features so entry features stay identical to the win-probability
model. Persists ml_models/exit_policy.pkl. Gracefully no-ops until enough excursions exist.

Run:  python exit_policy.py --train
      python exit_policy.py --train --min-samples 200
"""

import argparse
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import read_df
from ml_ensemble import build_features

MODELS_DIR = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
EXIT_MODEL_PATH = os.path.join(MODELS_DIR, 'exit_policy.pkl')

# Defaults for translating predicted excursions into levels.
MFE_CAPTURE = 0.6   # bank 60% of the expected favourable run (you don't sell the exact high)
MAE_BUFFER  = 1.15  # set the stop 15% wider than the expected adverse excursion (noise room)


def suggest_levels(entry: float, pred_mfe_pct: float, pred_mae_pct: float,
                   mfe_capture: float = MFE_CAPTURE, mae_buffer: float = MAE_BUFFER) -> tuple:
    """Convert predicted MFE/MAE (%) into (target_price, stop_price).

    target = entry × (1 + MFE × capture/100); stop = entry × (1 + MAE × buffer/100). MAE is
    negative for a long, so the stop sits below entry. Capture<1 books before the high;
    buffer>1 keeps the stop outside expected noise. Returns prices rounded to 2dp."""
    target = entry * (1 + (pred_mfe_pct * mfe_capture) / 100.0)
    stop   = entry * (1 + (pred_mae_pct * mae_buffer) / 100.0)
    return round(target, 2), round(stop, 2)


def load_exit_training_data() -> pd.DataFrame:
    """Excursion labels joined to the entry-time technical features + point-in-time
    fundamentals (same as-of discipline as ml_ensemble.load_training_data)."""
    q = """
        SELECT se.symbol, se.signal_date, se.horizon_days,
               se.mfe_pct, se.mae_pct,
               ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew, ts.rs_rank_21d, ts.rs_rank_63d,
               COALESCE(fh.fifty_two_week_high, sf.fifty_two_week_high) AS fifty_two_week_high,
               COALESCE(fh.piotroski_f_score, sf.piotroski_f_score)     AS piotroski_f_score,
               COALESCE(fh.debt_to_equity, sf.debt_to_equity)           AS debt_to_equity,
               COALESCE(fh.operating_margins, sf.operating_margins)     AS operating_margins,
               COALESCE(fh.return_on_equity, sf.return_on_equity)       AS return_on_equity,
               COALESCE(fh.revenue_growth, sf.revenue_growth)           AS revenue_growth,
               COALESCE(fh.earnings_growth, sf.earnings_growth)         AS earnings_growth,
               COALESCE(fh.earnings_yield, sf.earnings_yield)           AS earnings_yield,
               COALESCE(fh.price_to_book, sf.price_to_book)             AS price_to_book,
               COALESCE(fh.market_cap, sf.market_cap)                   AS market_cap
        FROM signal_excursions se
        JOIN technical_signals ts ON ts.symbol = se.symbol AND ts.date = se.signal_date
        LEFT JOIN fundamentals_history fh
               ON fh.symbol = se.symbol
              AND fh.as_of_date = (
                  SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2
                  WHERE fh2.symbol = se.symbol AND fh2.as_of_date <= se.signal_date
              )
        LEFT JOIN stock_fundamentals sf ON sf.symbol = se.symbol
        WHERE se.mfe_pct IS NOT NULL AND se.mae_pct IS NOT NULL
        ORDER BY se.signal_date
    """
    return read_df(q)


def train_from_df(df: pd.DataFrame, min_samples: int = 100) -> dict | None:
    """Fit MFE and MAE regressors on a prepared excursion frame. Time-ordered split (the rows
    arrive sorted by signal_date) keeps evaluation honest. Returns the persisted model dict
    or None when there is not enough data yet."""
    if len(df) < min_samples:
        print(f"[EXIT-POLICY] Only {len(df)} excursions (<{min_samples}); skipping train.")
        return None

    from sklearn.ensemble import GradientBoostingRegressor
    from sklearn.metrics import mean_absolute_error

    X = build_features(df)
    feature_names = list(X.columns)
    Xv = X.values.astype(np.float32)
    y_mfe = pd.to_numeric(df['mfe_pct'], errors='coerce').fillna(0.0).values
    y_mae = pd.to_numeric(df['mae_pct'], errors='coerce').fillna(0.0).values

    cut = max(min_samples // 2, int(len(df) * 0.8))
    models, metrics = {}, {}
    for name, y in (('mfe', y_mfe), ('mae', y_mae)):
        model = GradientBoostingRegressor(
            n_estimators=300, max_depth=3, learning_rate=0.03,
            subsample=0.8, random_state=42,
        )
        model.fit(Xv[:cut], y[:cut])
        if cut < len(df):
            mae = float(mean_absolute_error(y[cut:], model.predict(Xv[cut:])))
        else:
            mae = float('nan')
        model.fit(Xv, y)          # refit on all data for production use
        models[name] = model
        metrics[f'{name}_holdout_mae'] = mae

    payload = {
        'mfe_model': models['mfe'],
        'mae_model': models['mae'],
        'feature_names': feature_names,
        'metrics': metrics,
        'n_samples': len(df),
    }
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(EXIT_MODEL_PATH, 'wb') as f:
        pickle.dump(payload, f)
    print(f"[EXIT-POLICY] Trained on {len(df)} excursions. "
          f"Holdout MAE — MFE: {metrics['mfe_holdout_mae']:.2f}%  MAE: {metrics['mae_holdout_mae']:.2f}%")
    return payload


def train(min_samples: int = 100) -> dict | None:
    return train_from_df(load_exit_training_data(), min_samples=min_samples)


def predict_levels(df_row: pd.DataFrame, entry: float, model: dict | None = None) -> tuple:
    """Predict (target_price, stop_price) for one entry-feature row."""
    if model is None:
        with open(EXIT_MODEL_PATH, 'rb') as f:
            model = pickle.load(f)
    X = build_features(df_row)
    for col in model['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    Xv = X[model['feature_names']].values.astype(np.float32)
    pred_mfe = float(model['mfe_model'].predict(Xv)[0])
    pred_mae = float(model['mae_model'].predict(Xv)[0])
    return suggest_levels(entry, pred_mfe, pred_mae)


def load_latest_features_for_symbol(symbol: str) -> pd.DataFrame:
    """Query database for the latest technical signals and other features for a single stock."""
    q = """
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net,
               ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.sector_global_corr_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               ts.avwap_deviation_pct,
               ts.oi_net_change_pct,
               ts.eps_beat_last_q,
               ts.eps_beat_streak_4q,
               ts.eps_miss_streak_4q,
               ts.eps_surprise_last_yr,
               ts.eps_estimate_dispersion,
               fs.ret_12m_ex1m,
               mb.pct_above_200dma, mb.adv_decline_ratio, mb.net_highs_lows,
               hfs.max_pain,
               ts.mf_holding_pct, ts.mf_fund_count, ts.mf_chg_vs_prev,
               ts.rollover_pct, ts.cost_of_carry_ann,
               ts.block_deal_net_qty, ts.block_deal_value_cr,
               ts.eps_ttm, ts.eps_growth_yoy, ts.eps_growth_qoq, ts.eps_acceleration,
               ts.pe_ttm, ts.dvm_durability, ts.dvm_valuation, ts.dvm_momentum,
               ts.pe_pct_rank_252d, ts.pe_vs_median_1yr, ts.pb_pct_rank_252d, ts.div_yield_ttm,
               ts.ma_bull_frac, ts.osc_bull_frac, ts.adx_tl, ts.atr_pct_tl, ts.mfi_tl,
               ts.pivot_dist_pct_tl, ts.delivery_avg_1m_tl, ts.beta_1y_tl,
               ts.ret_1m_tl, ts.ret_3m_tl, ts.ret_6m_tl, ts.ret_1y_tl,
               ts.analyst_upside_pct, ts.analyst_count, ts.analyst_buy_pct,
               ts.roe_annual, ts.roce_annual, ts.ebitda_margin, ts.np_margin,
               ts.promoter_pct, ts.fii_pct, ts.pledge_pct,
               ts.rev_growth_yoy_q, ts.np_growth_yoy_q,
               ts.days_since_dividend, ts.last_dividend_amt,
               ts.days_to_ex_div, ts.days_to_board_meeting, ts.upcoming_div_pct,
               ts.mc_52w_high_dist_pct, ts.mc_52w_low_dist_pct, ts.mc_days_from_52wh,
               ts.mc_cagr_3y, ts.mc_cagr_5y, ts.mc_cagr_10y, ts.mc_ind_pe, ts.mc_pe_vs_ind,
               ts.mc_consensus_pe, ts.mc_consensus_pb,
               ts.mc_ma30_dist_pct, ts.mc_ma50_dist_pct, ts.mc_ma150_dist_pct, ts.mc_ma200_dist_pct,
               ts.mc_del_pct_3d, ts.mc_del_pct_5d, ts.mc_del_pct_20d, ts.mc_del_acceleration,
               ts.mc_vol_ratio, ts.mc_circuit_dist_pct, ts.mc_fno_eligible,
               ts.mc_3d_return, ts.mc_ytd_return,
               ts.mc_price_cash, ts.mc_consensus_eps, ts.mc_eps_vs_cons, ts.mc_pe_fwd_discount,
               ts.mc_cp_bull_count, ts.mc_cp_bear_count, ts.mc_cp_net_score, ts.mc_cp_avg_target_pct,
               ts.tl_vs_nifty_1m, ts.tl_vs_nifty_3m, ts.tl_vs_nifty_6m,
               ts.tl_vs_ind_1m, ts.tl_vs_ind_3m,
               ts.tl_seasonal_month_5y, ts.tl_dist_3m_high_pct, ts.tl_dist_3m_low_pct,
               ts.nt_max_pain_dist_pct, ts.nt_oi_direction, ts.nt_pcr, ts.nt_option_volume_log,
               ts.hv_10d, ts.hv_20d, ts.hv_30d, ts.hv_60d, ts.iv_hv_ratio,
               ts.pead_score, ts.event_signal_score,
               ts.eps_revision_3m_pct, ts.target_revision_3m_pct, ts.analyst_count_chg,
               ts.rs_vs_sector_21d, ts.rs_vs_sector_63d,
               ts.asm_flag, ts.gsm_stage,
               ts.crude_corr_90d, ts.gold_corr_90d, ts.dxy_corr_90d, ts.sp500_corr_90d,
               ts.mc_broker_buy_7d, ts.mc_broker_sell_7d, ts.mc_broker_upside,
               ts.days_to_next_results, ts.earnings_category_yoy, ts.earnings_category_qoq,
               ts.earnings_np_growth_yoy, ts.earnings_np_growth_qoq,
               ts.mc_eps_vs_cons, ts.positive_turnaround, ts.negative_turnaround,
               ts.earnings_shocker_flag, ts.earnings_shocker_gain,
               ts.is_nifty50, ts.is_nifty100, ts.nifty_tier,
               ts.pledge_chg_90d,
               ts.iep_gap_pct, ts.preopen_imbalance,
               ts.expected_move_pct, ts.stock_gex_proxy,
               ts.eps_surprise_q1, ts.eps_surprise_q2, ts.eps_beat_streak,
               ts.eps_miss_streak_4q, ts.eps_miss_after_streak, ts.rev_surprise_q1,
               ts.fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
               ts.delivery_trend_30d, ts.block_deal_flag, ts.block_deal_direction,
               ts.short_interest_proxy,
               ts.promoter_buy_90d_cr, ts.promoter_sell_90d_cr, ts.promoter_net_90d,
               ts.insider_buy_flag, ts.insider_sell_flag,
               ts.rating_upgrade_180d, ts.rating_downgrade_180d, ts.days_since_upgrade,
               ts.mf_sector_flow_pct,
               ts.receivables_days_ttm, ts.ccc_ttm, ts.ccc_trend,
               ts.wc_deteriorating, ts.wc_improving,
               ts.screener_bull_count, ts.screener_bear_count, ts.screener_cat_breadth,
               ts.screener_tier1_count, ts.screener_momentum_score, ts.screener_streak_days,
               ts.screener_name_signal, ts.screener_alpha_score,
               macro_snap.gift_nifty_pct, macro_snap.nifty_gex,
               macro_snap.india_10y, macro_snap.india_us_spread,
               macro_snap.high_impact_3d, macro_snap.asia_sentiment, macro_snap.global_risk,
               macro_snap.market_np_yoy, macro_snap.earnings_breadth_mkt,
               macro_snap.fii_net_today,
               macro_snap.usdinr_chg_pct, macro_snap.nifty_basis_pct, macro_snap.nifty_contango,
               macro_snap.india_vix,
               macro_snap.adrs_bullish_pct, macro_snap.usdinr_ret_1d,
               macro_snap.nikkei_ret_1d, macro_snap.hangseng_ret_1d,
               mse.np_growth_yoy AS sector_np_growth_yoy, mse.np_growth_qoq AS sector_np_growth_qoq,
               mse.rev_growth_yoy AS sector_rev_growth_yoy,
               sf.fifty_two_week_high,
               sf.piotroski_f_score, sf.debt_to_equity, sf.operating_margins,
               sf.return_on_equity, sf.revenue_growth, sf.earnings_growth,
               sf.earnings_yield, sf.price_to_book, sf.market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        LEFT JOIN feature_store fs
               ON fs.symbol = ts.symbol AND fs.date::text = ts.date AND fs.timeframe = 'D'
        LEFT JOIN market_breadth mb ON mb.date = ts.date
        LEFT JOIN historical_fno_sentiment hfs
               ON hfs.symbol = ts.symbol AND hfs.date = ts.date
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = ts.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = ts.symbol AND aeh2.as_of_date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= ts.date
              )
        LEFT JOIN (
            SELECT
                MAX(CASE WHEN symbol='GIFT_NIFTY_CHG_PCT'   THEN close END) AS gift_nifty_pct,
                MAX(CASE WHEN symbol='NIFTY_GEX'             THEN close END) AS nifty_gex,
                MAX(CASE WHEN symbol='INDIA_10Y'             THEN close END) AS india_10y,
                MAX(CASE WHEN symbol='INDIA_US_SPREAD'       THEN close END) AS india_us_spread,
                MAX(CASE WHEN symbol='HIGH_IMPACT_EVENTS_3D' THEN close END) AS high_impact_3d,
                MAX(CASE WHEN symbol='ASIA_SENTIMENT'        THEN close END) AS asia_sentiment,
                MAX(CASE WHEN symbol='GLOBAL_RISK_SCORE'     THEN close END) AS global_risk,
                MAX(CASE WHEN symbol='ADRS_BULLISH_PCT'      THEN close END) AS adrs_bullish_pct,
                MAX(CASE WHEN symbol='USDINR'                THEN ret_1d  END) AS usdinr_ret_1d,
                MAX(CASE WHEN symbol='NIKKEI'                THEN ret_1d  END) AS nikkei_ret_1d,
                MAX(CASE WHEN symbol='HANGSENG'              THEN ret_1d  END) AS hangseng_ret_1d,
                MAX(CASE WHEN symbol='MARKET_NP_GROWTH_YOY'  THEN close END) AS market_np_yoy,
                MAX(CASE WHEN symbol='EARNINGS_BREADTH'       THEN close END) AS earnings_breadth_mkt,
                MAX(CASE WHEN symbol='FII_NET_TODAY'           THEN close END) AS fii_net_today,
                MAX(CASE WHEN symbol='INDIA_VIX'              THEN close END) AS india_vix,
                MAX(CASE WHEN symbol='USDINR_CHG_PCT'          THEN close END) AS usdinr_chg_pct,
                MAX(CASE WHEN symbol='NIFTY_BASIS_PCT'          THEN close END) AS nifty_basis_pct,
                MAX(CASE WHEN symbol='NIFTY_CONTANGO'           THEN close END) AS nifty_contango
            FROM macro_asset_prices
            WHERE date::text = (SELECT MAX(date)::text FROM macro_asset_prices)
        ) macro_snap ON 1=1
        LEFT JOIN mc_sector_earnings mse ON mse.sector_name = (
            SELECT ns.sector FROM nse_stocks ns WHERE ns.symbol = ts.symbol LIMIT 1
        )
        WHERE ts.symbol = ?
          AND ts.date = (SELECT MAX(date) FROM technical_signals WHERE symbol = ?)
    """
    df = read_df(q, (symbol, symbol))
    if not df.empty:
        df['horizon_days'] = 15
    return df


def predict_levels_for_symbol(symbol: str, entry: float) -> tuple:
    """Predict dynamic target and stop prices using exit policy model for a symbol."""
    if not os.path.exists(EXIT_MODEL_PATH):
        return None, None
    df = load_latest_features_for_symbol(symbol)
    if df.empty:
        return None, None
    return predict_levels(df, entry)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Exit-policy head (MFE/MAE regressors)")
    parser.add_argument("--train", action="store_true")
    parser.add_argument("--min-samples", type=int, default=100)
    args = parser.parse_args()
    if args.train:
        train(min_samples=args.min_samples)
