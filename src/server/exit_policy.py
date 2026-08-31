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

import polars as pl
import argparse
import datetime
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import connect, read_df
from ml_ensemble import build_features, full_feature_train_sql
from as_of import as_of_join_sql
from model_promotion import (decide_promotion_with_nan_guard, rejections_since,
                              staleness_override_applies,
                              DEFAULT_STALENESS_MAX_DAYS, DEFAULT_STALENESS_MAX_REJECTIONS)

# Script-relative, not os.getcwd()-relative -- see ml_ensemble.py's MODELS_DIR comment.
MODELS_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml_models')
EXIT_MODEL_PATH = os.path.join(MODELS_DIR, 'exit_policy.pkl')
EXIT_CANDIDATE_PATH = EXIT_MODEL_PATH + '.candidate'
# Required MAE improvement (percentage points) over the active baseline to promote. Same
# modest-margin convention as cs_ranker.py/live_screener_ml_ranker.py's PROMOTION_MARGIN.
EXIT_PROMOTION_MARGIN = 0.1

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


# 2026-08-29: signal_excursions has no retention/window at all -- it grew to 393K qualifying
# rows in its first ~103 days of existence (2026-05-16..08-27) and GradientBoostingRegressor's
# per-tree cost scales with row count, fit 4x (2 targets x split-fit + refit-all, see
# train_from_df). This is the direct cause of exit-policy-train's weekly timeout, which had
# already been bumped once (20min->45min, 2026-08-24) "for dataset growth" and hit the new
# ceiling again just 5 days later -- bumping it a second time would only defer the same failure
# again as the table keeps growing, unbounded, forever. A recency cap keeps runtime roughly flat
# going forward instead of growing every week; MAX_TRAINING_ROWS is deliberately a ROW count, not
# a calendar window, because the table is currently younger than any reasonable calendar window
# would be (a "last 2 years" cap would not drop a single row today). The champion/challenger gate
# in _register_exit_model already refuses to promote a worse model, so a training-set change here
# cannot silently degrade the live model -- it can only fail to improve it, which is caught.
MAX_TRAINING_ROWS = 150_000


def load_exit_training_data() -> pd.DataFrame:
    """Excursion labels joined to the entry-time technical features + point-in-time
    fundamentals (same as-of discipline as ml_ensemble.load_training_data).

    Capped to the most recent MAX_TRAINING_ROWS by signal_date (see the comment above) --
    re-sorted ascending afterward since train_from_df's time-ordered split assumes that order."""
    # Full feature set (2026-08-30): this used to hand-select ~23 of build_features()'s 304
    # raw inputs -- everything else silently defaulted to a constant for every training row.
    # See measurement.md's cs_ranker/exit_policy feature-completeness finding and
    # full_feature_train_sql()'s docstring in ml_ensemble.py. Anchored on `se` (signal_excursions
    # has the same symbol/signal_date shape as signal_outcomes), so the LATERAL join inside
    # full_feature_train_sql already finds its own `ts` row -- the old hand-written
    # `JOIN technical_signals ts` above is now redundant and removed.
    select_cols, joins = full_feature_train_sql('se', 'signal_date')
    q = f"""
        WITH recent AS (
            SELECT se.symbol, se.signal_date, se.horizon_days,
                   se.mfe_pct, se.mae_pct,
                   ts.signal_score, ts.signals_json,
                   {select_cols}
            FROM signal_excursions se
            {joins}
            WHERE se.mfe_pct IS NOT NULL AND se.mae_pct IS NOT NULL
            ORDER BY se.signal_date DESC
            LIMIT {MAX_TRAINING_ROWS}
        )
        SELECT * FROM recent ORDER BY signal_date
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

    # Date-based split with an embargo sized to the TYPICAL excursion horizon in this dataset.
    # Live bug, 2026-08-09: this used to take max(horizon_days) across the WHOLE dataset --
    # signal_excursions mixes many horizons (1/3/5/7/14/15/30 days), and the 30-day bucket is
    # only ~0.8% of rows, yet its presence alone forced a 30-day embargo. Since train_end_date
    # (the 80th-percentile row) already sits near the data's own max date, adding 30 more days
    # pushed embargo_end_date past every remaining date -- test_mask was empty on EVERY run
    # with any horizon=30 rows present (confirmed: printed "Holdout MAE ... nan% nan%" with no
    # error, and the model was saved anyway). The median horizon is robust to this minority-
    # horizon distortion and still embargoes the bulk of the data correctly.
    dates = pd.to_datetime(df['signal_date'])
    horizon_days = int(pd.to_numeric(df['horizon_days'], errors='coerce').dropna().median()) or 1
    cut = max(min_samples // 2, int(len(df) * 0.8))
    train_end_date = dates.iloc[min(cut, len(df) - 1)]
    embargo_end_date = train_end_date + pd.Timedelta(days=horizon_days)
    train_mask = (dates <= train_end_date).values
    test_mask  = (dates > embargo_end_date).values

    models, metrics = {}, {}
    for name, y in (('mfe', y_mfe), ('mae', y_mae)):
        model = GradientBoostingRegressor(
            n_estimators=300, max_depth=3, learning_rate=0.03,
            subsample=0.8, random_state=42,
        )
        model.fit(Xv[train_mask], y[train_mask])
        if test_mask.any():
            mae = float(mean_absolute_error(y[test_mask], model.predict(Xv[test_mask])))
        else:
            mae = float('nan')
        model.fit(Xv, y)          # refit on all data for production use
        models[name] = model
        metrics[f'{name}_holdout_mae'] = mae

    print(f"[EXIT-POLICY] Trained on {len(df)} excursions (embargo={horizon_days}d, "
          f"holdout n={int(test_mask.sum())}). "
          f"Holdout MAE — MFE: {metrics['mfe_holdout_mae']:.2f}%  MAE: {metrics['mae_holdout_mae']:.2f}%")

    return {
        'mfe_model': models['mfe'],
        'mae_model': models['mae'],
        'feature_names': feature_names,
        'metrics': metrics,
        'n_samples': len(df),
        'trained_at': datetime.datetime.utcnow().isoformat(),
    }


def _active_exit_baseline(conn) -> dict | None:
    """{mfe_holdout_mae, mae_holdout_mae} of the currently active exit_policy model, or None.

    model_registry.cv_roc_auc/cv_accuracy are shared columns across every model_type this
    platform registers -- for exit_policy (a pair of GradientBoostingRegressors, no AUC
    concept at all) they instead hold mfe_holdout_mae/mae_holdout_mae respectively. Same
    column-reuse convention cs_ranker.py already documents for its own Spearman rho.
    """
    try:
        row = conn.execute(
            "SELECT id, cv_roc_auc, cv_accuracy, trained_at FROM model_registry "
            "WHERE model_name = 'exit_policy' AND is_active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row and row[1] is not None and row[2] is not None:
            return {'id': row[0], 'mfe_holdout_mae': float(row[1]), 'mae_holdout_mae': float(row[2]),
                    'trained_at': row[3]}
    except Exception:
        pass
    return None


def _register_exit_model(conn, payload: dict) -> int:
    """Champion/challenger promotion gate (2026-08-09 audit): this file had NONE at all,
    unlike every sibling training script in this codebase -- train_from_df() used to
    unconditionally overwrite the live pickle regardless of holdout quality, including the
    empty-holdout NaN case the embargo fix above addresses. Lower MAE is better, so both
    sub-metrics are negated before going through the same NaN-guarded comparison
    ml_ensemble.py/movement_predictor.py/breakout_classifier.py already share -- a NaN
    holdout MAE (from either regressor) is refused outright, matching that shared contract.
    Promotes only if BOTH mfe and mae holdout MAE improve (or there's no active baseline
    yet) -- they're one combined pickle file, so a partial improvement can't partially
    overwrite it.

    STALENESS OVERRIDE (ml-promotion-gate-review, 2026-08-14): this file had no equivalent to
    ml_ensemble.py/cs_ranker.py/confluence_ml_engine.py's safety valve against a baseline whose
    holdout MAE became permanently unbeatable (e.g. from a leak that's since been fixed) --
    without it, every future honest retrain would reject forever. Same mechanism, reused
    directly since this baseline lives in model_registry like those three.
    """
    metrics = payload['metrics']
    baseline = _active_exit_baseline(conn)
    base_mfe = baseline['mfe_holdout_mae'] if baseline else None
    base_mae = baseline['mae_holdout_mae'] if baseline else None

    promote_mfe, reason_mfe = decide_promotion_with_nan_guard(
        -metrics['mfe_holdout_mae'], -base_mfe if base_mfe is not None else None,
        EXIT_PROMOTION_MARGIN, metric_name="MFE MAE")
    promote_mae, reason_mae = decide_promotion_with_nan_guard(
        -metrics['mae_holdout_mae'], -base_mae if base_mae is not None else None,
        EXIT_PROMOTION_MARGIN, metric_name="MAE MAE")
    promote = promote_mfe and promote_mae

    staleness_override = False
    age_days = 0.0
    rejections = 0
    if baseline is not None and not promote:
        rejections = rejections_since(conn, 'exit_policy', baseline['id'])
        staleness_override, age_days = staleness_override_applies(
            baseline['trained_at'], rejections,
            DEFAULT_STALENESS_MAX_DAYS, DEFAULT_STALENESS_MAX_REJECTIONS)

    os.makedirs(MODELS_DIR, exist_ok=True)
    version = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    cur = conn.cursor()

    if not promote and not staleness_override:
        with open(EXIT_CANDIDATE_PATH, 'wb') as f:
            pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
        reason = reason_mfe or reason_mae or "did not clear the promotion bar"
        print(f"[EXIT-POLICY] Candidate REJECTED: {reason} Saved to {EXIT_CANDIDATE_PATH} "
              f"for inspection; active model unchanged. (baseline stale {age_days:.1f}d, "
              f"{rejections} rejections so far)")
        cur.execute("""
            INSERT INTO model_registry
                (model_name, model_version, model_type, trained_at, training_samples,
                 cv_roc_auc, cv_accuracy, feature_count, model_path, is_active, notes)
            VALUES ('exit_policy', ?, 'GradientBoosting Regressor Pair', ?, ?, ?, ?, ?, ?, 0, ?)
            RETURNING id
        """, (version, payload['trained_at'], payload['n_samples'],
              metrics['mfe_holdout_mae'], metrics['mae_holdout_mae'],
              len(payload['feature_names']), EXIT_CANDIDATE_PATH, f"REJECTED: {reason}"))
        model_id = cur.fetchone()[0]
        conn.commit()
        return model_id

    with open(EXIT_MODEL_PATH, 'wb') as f:
        pickle.dump(payload, f, protocol=pickle.HIGHEST_PROTOCOL)
    cur.execute("UPDATE model_registry SET is_active = 0 WHERE model_name = 'exit_policy' AND is_active = 1")
    note = (f"mfe_mae={metrics['mfe_holdout_mae']:.4f} mae_mae={metrics['mae_holdout_mae']:.4f}"
            + (" (bootstrap, no prior baseline)" if baseline is None else
               f" (STALENESS OVERRIDE: baseline unbeaten {age_days:.1f}d, {rejections} rejections)"
               if staleness_override and not promote else
               f" (beat baseline mfe={base_mfe:.4f} mae={base_mae:.4f})"))
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at, training_samples,
             cv_roc_auc, cv_accuracy, feature_count, model_path, is_active, notes)
        VALUES ('exit_policy', ?, 'GradientBoosting Regressor Pair', ?, ?, ?, ?, ?, ?, 1, ?)
        RETURNING id
    """, (version, payload['trained_at'], payload['n_samples'],
          metrics['mfe_holdout_mae'], metrics['mae_holdout_mae'],
          len(payload['feature_names']), EXIT_MODEL_PATH, note))
    model_id = cur.fetchone()[0]
    conn.commit()
    print(f"[EXIT-POLICY] Promoted: {note}")
    print(f"[EXIT-POLICY] Registered as model_id={model_id} version={version} (ACTIVE)")
    return model_id


def train(min_samples: int = 100) -> dict | None:
    payload = train_from_df(load_exit_training_data(), min_samples=min_samples)
    if payload is None:
        return None
    conn = connect()
    _register_exit_model(conn, payload)
    return payload


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
    q = f"""
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
               ts.fcf_yield_approx AS fcf_yield, ts.interest_coverage, ts.fcf_positive, ts.debt_coverage_risk,
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
               ON fs.symbol = ts.symbol AND fs.date = ts.date AND fs.timeframe = 'D'
        LEFT JOIN market_breadth mb ON mb.date = ts.date::text
        LEFT JOIN historical_fno_sentiment hfs
               ON hfs.symbol = ts.symbol AND hfs.date = ts.date::text
        {as_of_join_sql('analyst_estimates_history', 'aeh', 'ts', 'symbol', 'date', False)}
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score'
                    AND p2.date <= ts.date::text
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score'
                    AND p2.date <= ts.date::text
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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
