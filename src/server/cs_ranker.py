"""
cs_ranker.py — Cross-sectional alpha ranker.

Trains a LightGBM regressor to predict each signal's alpha percentile (rank
among all signals on the same date by excess return vs Nifty 50). Produces
cs_score (0–100) on technical_signals for use by unified_ranker.py.

Run:
    python cs_ranker.py --train
    python cs_ranker.py --score
"""

import os
import sys
import pickle
import datetime
import argparse
import warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd
from scipy.stats import spearmanr

from db_compat import connect, read_df, ConnWrapper
from model_promotion import clears_promotion_bar
from as_of import as_of_join_sql

# Import feature engineering from the binary ensemble — same pipeline, different label.
sys.path.insert(0, os.path.dirname(__file__))
from ml_ensemble import build_features

MODELS_DIR    = os.path.join(os.path.dirname(__file__), 'ml_models')
CS_MODEL_PATH = os.path.join(MODELS_DIR, 'cs_ranker.pkl')
CS_CANDIDATE_PATH = CS_MODEL_PATH + '.candidate'
# New held-out Spearman rho must beat the active model's by at least this much to be
# promoted. Same value as live_screener_ml_ranker.py's PROMOTION_MARGIN.
CS_PROMOTION_MARGIN = 0.01
MIN_DATE_SIGNALS = 5   # minimum signals per date to include in training


# ── Label Construction ────────────────────────────────────────────────────────

def _get_nifty_returns() -> pd.DataFrame:
    """5-day forward returns for NIFTY50 from stock_ohlcv, indexed by date string."""
    q = """
        SELECT date, close
        FROM stock_ohlcv
        WHERE symbol = 'NIFTY50'
        ORDER BY date
    """
    df = read_df(q)
    if df.empty:
        return pd.DataFrame(columns=['date', 'nifty_ret_5d'])
    df['date'] = df['date'].astype(str).str[:10]
    df = df.sort_values('date').reset_index(drop=True)
    # Forward-5d return: (close[t+5] - close[t]) / close[t]
    df['nifty_ret_5d'] = (df['close'].shift(-5) - df['close']) / df['close'].replace(0, np.nan) * 100
    return df[['date', 'nifty_ret_5d']].dropna()


def load_cs_training_data() -> pd.DataFrame:
    """
    Returns a DataFrame of resolved signal rows with a `cs_percentile` column
    (0–100 rank of alpha within each signal_date group).

    Alpha = return_pct - nifty_5d_return. Dates with fewer than MIN_DATE_SIGNALS
    signals are excluded (too sparse to rank meaningfully).
    """
    nifty = _get_nifty_returns()
    if nifty.empty:
        print("[CSRanker] WARNING: No NIFTY50 data in stock_ohlcv — using raw return_pct as target")
        nifty = None

    q = f"""
        SELECT so.symbol, so.signal_date, so.return_pct,
               so.signal_score, so.signals_json, so.horizon_days,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               COALESCE(fh.fifty_two_week_high, sf.fifty_two_week_high) AS fifty_two_week_high,
               COALESCE(fh.piotroski_f_score, sf.piotroski_f_score)     AS piotroski_f_score,
               COALESCE(fh.debt_to_equity, sf.debt_to_equity)           AS debt_to_equity,
               COALESCE(fh.operating_margins, sf.operating_margins)     AS operating_margins,
               COALESCE(fh.return_on_equity, sf.return_on_equity)       AS return_on_equity,
               COALESCE(fh.revenue_growth, sf.revenue_growth)           AS revenue_growth,
               COALESCE(fh.earnings_growth, sf.earnings_growth)         AS earnings_growth,
               COALESCE(fh.earnings_yield, sf.earnings_yield)           AS earnings_yield,
               COALESCE(fh.price_to_book, sf.price_to_book)             AS price_to_book,
               COALESCE(fh.market_cap, sf.market_cap)                   AS market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        {as_of_join_sql('fundamentals_history', 'fh', 'so', 'symbol', 'signal_date')}
        LEFT JOIN stock_fundamentals sf ON sf.symbol = so.symbol
        {as_of_join_sql('analyst_estimates_history', 'aeh', 'so', 'symbol', 'signal_date')}
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = so.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score' AND p2.date <= so.signal_date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = so.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = so.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score' AND p2.date <= so.signal_date
              )
        WHERE so.outcome IN ('WIN', 'LOSS', 'STOP_LOSS')
          AND so.return_pct IS NOT NULL
          AND so.horizon_days = 5
          AND so.signal_source = 'technical'
    """
    df = read_df(q)
    if df.empty:
        print("[CSRanker] No resolved 5d outcomes found.")
        return df

    df['signal_date'] = df['signal_date'].astype(str).str[:10]
    df['return_pct']  = pd.to_numeric(df['return_pct'], errors='coerce')

    # Compute alpha: excess return vs Nifty
    if nifty is not None:
        df = df.merge(nifty, left_on='signal_date', right_on='date', how='left')
        df['alpha'] = df['return_pct'] - df['nifty_ret_5d'].fillna(0)
    else:
        df['alpha'] = df['return_pct']

    # Drop sparse dates
    date_counts = df.groupby('signal_date')['symbol'].count()
    valid_dates = date_counts[date_counts >= MIN_DATE_SIGNALS].index
    df = df[df['signal_date'].isin(valid_dates)].copy()
    if df.empty:
        print(f"[CSRanker] No dates with >= {MIN_DATE_SIGNALS} signals.")
        return df

    # Rank alpha within each date → percentile 0-100
    df['cs_percentile'] = df.groupby('signal_date')['alpha'].transform(
        lambda x: (x.rank(method='average') - 1) / max(1, len(x) - 1) * 100
    )
    df = df.sort_values('signal_date').reset_index(drop=True)

    print(f"[CSRanker] Training data: {len(df)} rows across {df['signal_date'].nunique()} dates "
          f"(win_rate_above50pct={( df['cs_percentile'] > 50 ).mean():.1%})")
    return df


# ── Model Training ────────────────────────────────────────────────────────────

HORIZON_DAYS_LABEL = 5  # cs_percentile is a 5-day-forward outcome (so.horizon_days=5 filter
                         # in load_cs_training_data's SQL) — kept as a module constant so the
                         # embargo below and the SQL filter can't silently drift apart.


def _compute_date_split(dates_sorted: list, test_frac: float = 0.20,
                         horizon_days_label: int = HORIZON_DAYS_LABEL) -> tuple[set, set]:
    """Finding #20 (2026-07-28 audit): a plain positional last-20%-of-dates split has zero
    gap, so training rows near the boundary have forward-looking labels that mechanically
    overlap the test window's own dates. Embargo the horizon_days_label trading dates
    immediately before the test window, mirroring ml_ensemble.py's date-based embargo
    (adapted here to trading-date count since this split is date-based, not row-positional).
    Returns (train_dates, test_dates) as sets of date strings.
    """
    n_test_dates = max(1, int(len(dates_sorted) * test_frac))
    test_start_idx = len(dates_sorted) - n_test_dates
    test_dates = set(dates_sorted[test_start_idx:])
    embargo_start_idx = max(0, test_start_idx - horizon_days_label)
    train_dates = set(dates_sorted[:embargo_start_idx])
    return train_dates, test_dates


def train_cs_ranker(df: pd.DataFrame, min_samples: int = 50) -> dict:
    """
    Train LightGBM regressor on cs_percentile. Returns a model dict with keys:
        model, feature_names, spearman_rho, n_samples, trained_at
    """
    from lightgbm import LGBMRegressor

    if len(df) < min_samples:
        raise ValueError(f"[CSRanker] Only {len(df)} samples — need {min_samples} to train.")

    X = build_features(df)
    y = df['cs_percentile'].values

    # Held-out test: last 20% of dates (chronological, no shuffling), embargoed per Finding #20.
    dates_sorted = sorted(df['signal_date'].unique())
    train_dates, test_dates = _compute_date_split(dates_sorted)
    train_mask = df['signal_date'].isin(train_dates)
    test_mask  = df['signal_date'].isin(test_dates)

    X_tr, y_tr = X[train_mask], y[train_mask]
    X_te, y_te = X[test_mask],  y[test_mask]

    model = LGBMRegressor(
        objective='regression_l2',
        n_estimators=400,
        learning_rate=0.05,
        num_leaves=63,
        min_child_samples=20,
        subsample=0.8,
        colsample_bytree=0.8,
        random_state=42,
        verbose=-1,
    )
    model.fit(X_tr, y_tr)

    preds_te = model.predict(X_te)
    rho, pval = spearmanr(y_te, preds_te)
    print(f"[CSRanker] Held-out Spearman rho={rho:.4f}  (p={pval:.3g}, n={len(y_te)})")
    if rho < 0.10:
        print(f"[CSRanker] WARNING: rho={rho:.4f} below acceptance threshold 0.10 — model saved anyway")

    # Retrain on full data
    model.fit(X, y)

    return {
        'model':         model,
        'feature_names': list(X.columns),
        'spearman_rho':  float(rho),
        'n_samples':     len(df),
        'trained_at':    datetime.datetime.utcnow().isoformat(),
    }


def save_cs_model(m: dict, path: str = CS_MODEL_PATH):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(path, 'wb') as f:
        pickle.dump(m, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[CSRanker] Saved to {path}")


def load_cs_model() -> dict | None:
    if not os.path.exists(CS_MODEL_PATH):
        return None
    with open(CS_MODEL_PATH, 'rb') as f:
        return pickle.load(f)


def _active_cs_baseline(conn: ConnWrapper) -> float | None:
    """Held-out Spearman rho of the currently active cs_ranker model, or None."""
    try:
        row = conn.execute(
            "SELECT cv_roc_auc FROM model_registry "
            "WHERE model_name = 'cs_ranker' AND is_active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row and row[0] is not None:
            return float(row[0])
    except Exception:
        pass
    return None


def _register_cs_model(conn: ConnWrapper, m: dict) -> int:
    """Registers the trained model in model_registry AND decides whether it becomes the
    active model (writes CS_MODEL_PATH) or is saved as a rejected candidate for inspection
    (CS_CANDIDATE_PATH, model_registry row kept with is_active=0).

    Promotion gate (Finding #17, 2026-07-28 full-stack audit): this used to unconditionally
    deactivate the previous model and activate the new one -- the code even logged "rho
    below threshold... model saved anyway" and proceeded to activate it regardless. A single
    noisy or adverse-regime retrain could silently degrade the live cs_score for every
    downstream consumer with no safety net. Now matches the champion/challenger gate
    ml_ensemble.py/live_screener_ml_ranker.py already use: only activate if the new held-out
    rho beats the active model's by >= CS_PROMOTION_MARGIN, or there is no active model yet.

    NOTE on `cv_roc_auc` (2026-08-05, found via a live production review that misread this
    row as a broken/bypassed-gate AUC value): `model_registry.cv_roc_auc` is a column shared
    across every model_type this platform registers -- for classifiers (Stacking Ensemble,
    OnlineSGD, deep_learning) it genuinely holds an AUC. cs_ranker is a LightGBM *regressor*
    (model_type='LightGBM Regressor') with no AUC concept at all -- this column instead holds
    its held-out cross-sectional Spearman rho (same value `_active_cs_baseline` reads). A
    "cv_roc_auc≈0.107" active row is NOT a broken/inverted classifier bar clearing an AUC
    floor it shouldn't; it's a normal rho for this model (historical range across retrains has
    been ~0.05-0.24) that correctly beat every later retrain attempt's rho (0.078-0.094, all
    4 logged REJECTED in this same table) under the gate above. Don't re-flag this as a
    promotion-gate bypass without checking model_type first.
    """
    import json
    version  = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    feats    = m.get('feature_names', [])
    top_feats = []
    mdl = m['model']
    if hasattr(mdl, 'feature_importances_'):
        pairs = sorted(zip(feats, mdl.feature_importances_), key=lambda x: -x[1])[:15]
        top_feats = [{'feature': f, 'importance': round(float(i), 6)} for f, i in pairs]

    baseline_rho = _active_cs_baseline(conn)
    new_rho = m['spearman_rho']
    promote = clears_promotion_bar(new_rho, baseline_rho, CS_PROMOTION_MARGIN)

    cur = conn.cursor()
    if not promote:
        save_cs_model(m, path=CS_CANDIDATE_PATH)
        print(f"[CSRanker] Candidate REJECTED: rho={new_rho:.4f} did not beat active model's "
              f"{baseline_rho:.4f} + {CS_PROMOTION_MARGIN} margin. Saved to {CS_CANDIDATE_PATH} "
              f"for inspection; active model unchanged.")
        cur.execute("""
            INSERT INTO model_registry
                (model_name, model_version, model_type, trained_at,
                 training_samples, cv_roc_auc, cv_accuracy,
                 feature_count, top_features_json, model_path, is_active, horizon_days, notes)
            VALUES ('cs_ranker', ?, 'LightGBM Regressor', ?, ?, ?, ?, ?, ?, ?, 0, 5, ?)
            RETURNING id
        """, (
            version, m['trained_at'], m['n_samples'],
            new_rho, None,
            len(feats), json.dumps(top_feats), CS_CANDIDATE_PATH,
            f"REJECTED spearman_rho={new_rho:.4f} vs baseline={baseline_rho:.4f}",
        ))
        model_id = cur.fetchone()[0]
        conn.commit()
        print(f"[CSRanker] Rejected candidate logged as model_id={model_id} version={version} (is_active=0)")
        return model_id

    save_cs_model(m, path=CS_MODEL_PATH)
    cur.execute("UPDATE model_registry SET is_active = 0 WHERE model_name = 'cs_ranker' AND is_active = 1")
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, cv_accuracy,
             feature_count, top_features_json, model_path, is_active, horizon_days, notes)
        VALUES ('cs_ranker', ?, 'LightGBM Regressor', ?, ?, ?, ?, ?, ?, ?, 1, 5, ?)
        RETURNING id
    """, (
        version, m['trained_at'], m['n_samples'],
        new_rho, None,
        len(feats), json.dumps(top_feats), CS_MODEL_PATH,
        f"spearman_rho={new_rho:.4f}" + (f" (beat baseline {baseline_rho:.4f})" if baseline_rho is not None else " (no prior model)"),
    ))
    model_id = cur.fetchone()[0]
    conn.commit()
    print(f"[CSRanker] Registered as model_id={model_id} version={version} (ACTIVE)")
    return model_id


# ── Scoring ───────────────────────────────────────────────────────────────────

def score_batch() -> int:
    """
    Score all technical_signals rows where cs_score IS NULL and win_probability IS NOT NULL.
    Normalizes predictions to 0-100 percentile within today's batch before writing.
    Returns count of rows scored.
    """
    m = load_cs_model()
    if m is None:
        print("[CSRanker] No model found — run --train first.")
        return 0

    q = f"""
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net, ts.above_sma200, ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net, ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               ts.iv_rank, ts.iv_skew,
               ts.rs_rank_21d, ts.rs_rank_63d,
               ts.insider_buy_pct_90d,
               ts.opening_range_break,
               ts.vwap_deviation_pct,
               ts.first_hour_vol_share,
               sf.fifty_two_week_high,
               sf.piotroski_f_score, sf.debt_to_equity, sf.operating_margins,
               sf.return_on_equity, sf.revenue_growth, sf.earnings_growth,
               sf.earnings_yield, sf.price_to_book, sf.market_cap,
               aeh.n_analysts, aeh.buy_count, aeh.target_mean,
               psh_az.score_value AS altman_z,
               psh_oo.score_value AS ohlson_o
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        {as_of_join_sql('analyst_estimates_history', 'aeh', 'ts', 'symbol', 'date')}
        LEFT JOIN proprietary_scores_history psh_az
               ON psh_az.symbol = ts.symbol
              AND psh_az.source = 'moneycontrol'
              AND psh_az.score_type = 'altman_z_score'
              AND psh_az.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'altman_z_score' AND p2.date <= ts.date
              )
        LEFT JOIN proprietary_scores_history psh_oo
               ON psh_oo.symbol = ts.symbol
              AND psh_oo.source = 'moneycontrol'
              AND psh_oo.score_type = 'ohlson_o_score'
              AND psh_oo.date = (
                  SELECT MAX(p2.date) FROM proprietary_scores_history p2
                  WHERE p2.symbol = ts.symbol AND p2.source = 'moneycontrol'
                    AND p2.score_type = 'ohlson_o_score' AND p2.date <= ts.date
              )
        WHERE ts.cs_score IS NULL
          AND ts.win_probability IS NOT NULL
        ORDER BY ts.date DESC
        LIMIT 10000
    """
    df = read_df(q)
    if df.empty:
        print("[CSRanker] No pending signals to score.")
        return 0

    df['horizon_days'] = 5
    X = build_features(df)

    # Align to training feature set
    for col in m['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    X = X[m['feature_names']]

    raw_preds = m['model'].predict(X)

    # Percentile-rank within this batch → 0-100
    n = len(raw_preds)
    rank_order = raw_preds.argsort().argsort()   # stable double-argsort = rank
    cs_scores  = rank_order / max(1, n - 1) * 100

    conn  = connect()
    cur   = conn.cursor()
    updates = [
        (round(float(cs_scores[idx]), 2), row.symbol, row.signal_date)
        for idx, row in enumerate(df.itertuples(index=False))
    ]
    cur.executemany(
        "UPDATE technical_signals SET cs_score = ? WHERE symbol = ? AND date = ?",
        updates,
    )
    conn.commit()
    count = len(updates)
    print(f"[CSRanker] Scored and wrote cs_score for {count} signals.")
    return count


# ── CLI ───────────────────────────────────────────────────────────────────────

if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--score', action='store_true')
    args = parser.parse_args()

    if args.train:
        df = load_cs_training_data()
        if df.empty:
            print("[CSRanker] No training data — aborting.")
            sys.exit(1)
        m = train_cs_ranker(df)
        conn = connect()
        _register_cs_model(conn, m)

    if args.score:
        score_batch()

    if not args.train and not args.score:
        parser.print_help()
