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

# Import feature engineering from the binary ensemble — same pipeline, different label.
sys.path.insert(0, os.path.dirname(__file__))
from ml_ensemble import build_features

MODELS_DIR    = os.path.join(os.path.dirname(__file__), 'ml_models')
CS_MODEL_PATH = os.path.join(MODELS_DIR, 'cs_ranker.pkl')
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
    conn = connect()
    nifty = _get_nifty_returns()
    if nifty.empty:
        print("[CSRanker] WARNING: No NIFTY50 data in stock_ohlcv — using raw return_pct as target")
        nifty = None

    q = """
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
        LEFT JOIN fundamentals_history fh
               ON fh.symbol = so.symbol
              AND fh.as_of_date = (
                  SELECT MAX(fh2.as_of_date) FROM fundamentals_history fh2
                  WHERE fh2.symbol = so.symbol AND fh2.as_of_date <= so.signal_date
              )
        LEFT JOIN stock_fundamentals sf ON sf.symbol = so.symbol
        LEFT JOIN analyst_estimates_history aeh
               ON aeh.symbol = so.symbol
              AND aeh.as_of_date = (
                  SELECT MAX(aeh2.as_of_date) FROM analyst_estimates_history aeh2
                  WHERE aeh2.symbol = so.symbol AND aeh2.as_of_date <= so.signal_date
              )
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

    # Held-out test: last 20% of dates (chronological, no shuffling)
    dates_sorted = sorted(df['signal_date'].unique())
    n_test_dates = max(1, int(len(dates_sorted) * 0.20))
    test_dates   = set(dates_sorted[-n_test_dates:])
    train_mask   = ~df['signal_date'].isin(test_dates)
    test_mask    = df['signal_date'].isin(test_dates)

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


def save_cs_model(m: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(CS_MODEL_PATH, 'wb') as f:
        pickle.dump(m, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[CSRanker] Saved to {CS_MODEL_PATH}")


def load_cs_model() -> dict | None:
    if not os.path.exists(CS_MODEL_PATH):
        return None
    with open(CS_MODEL_PATH, 'rb') as f:
        return pickle.load(f)


def _register_cs_model(conn: ConnWrapper, m: dict) -> int:
    import json
    version  = datetime.datetime.utcnow().strftime('%Y%m%d_%H%M%S')
    feats    = m.get('feature_names', [])
    top_feats = []
    mdl = m['model']
    if hasattr(mdl, 'feature_importances_'):
        pairs = sorted(zip(feats, mdl.feature_importances_), key=lambda x: -x[1])[:15]
        top_feats = [{'feature': f, 'importance': round(float(i), 6)} for f, i in pairs]

    cur = conn.cursor()
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
        m['spearman_rho'], None,
        len(feats), json.dumps(top_feats), CS_MODEL_PATH,
        f"spearman_rho={m['spearman_rho']:.4f}",
    ))
    model_id = cur.fetchone()[0]
    conn.commit()
    print(f"[CSRanker] Registered as model_id={model_id} version={version}")
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

    q = """
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
        save_cs_model(m)
        conn = connect()
        _register_cs_model(conn, m)

    if args.score:
        score_batch()

    if not args.train and not args.score:
        parser.print_help()
