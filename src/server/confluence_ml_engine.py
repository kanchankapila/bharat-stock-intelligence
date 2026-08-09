#!/usr/bin/env python3
"""
Confluence ML Engine — XGBoost/LightGBM breakout probability model.

Modes:
  --train                Retrain model from signal_outcomes + technical_signals
  --update-probabilities Write ML probabilities for current confluence_signals batch
  --evaluate             Print model metrics (AUC, accuracy, feature importances)
"""

import argparse
import os
import sys
import json
import pickle
import numpy as np
from datetime import datetime, timedelta

from db_compat import connect, use_postgres, ConnWrapper
from model_promotion import (clears_promotion_bar, rejections_since,
                              staleness_override_applies,
                              DEFAULT_STALENESS_MAX_DAYS, DEFAULT_STALENESS_MAX_REJECTIONS)
from as_of import as_of_join_sql

# ── Optional imports (graceful fallback) ──────────────────────────────────────
try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

try:
    import lightgbm as lgb
    HAS_LGB = True
except ImportError:
    HAS_LGB = False

from sklearn.ensemble import GradientBoostingClassifier, RandomForestClassifier
from sklearn.linear_model import LogisticRegression
from sklearn.model_selection import TimeSeriesSplit, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.calibration import CalibratedClassifierCV

MODEL_DIR = os.path.join(os.path.dirname(__file__), 'ml_models')
MODEL_PATH = os.path.join(MODEL_DIR, 'confluence_ml.pkl')
CANDIDATE_PATH = MODEL_PATH + '.candidate'
# New held-out AUC must beat the active model's by at least this much to be promoted.
# Same value as ml_ensemble.py's PROMOTION_MARGIN, for consistency across engines.
PROMOTION_MARGIN = 0.005
# Staleness-override safety valve (2026-08-06) -- see model_promotion.staleness_override_applies'
# own docstring. confluence_ml had NO such valve before this: its active baseline (trained
# 2026-07-30T10:11:57Z, ~46min BEFORE the 2026-07-30 CV-leakage fix commit aa5862d2 landed)
# carries a leak-inflated AUC (0.777) that every honest post-fix retrain since has been
# measured against and rejected -- confirmed live, a real, currently-stuck deadlock, not
# hypothetical. Same DEFAULT_* thresholds as ensemble/cs_ranker (7 days unbeaten + 10 rejections).
CONFLUENCE_STALENESS_MAX_DAYS = DEFAULT_STALENESS_MAX_DAYS
CONFLUENCE_STALENESS_MAX_REJECTIONS = DEFAULT_STALENESS_MAX_REJECTIONS

FEATURE_COLS = [
    'bullish_screener_count',
    'bearish_screener_count',
    'active_screener_count',
    'trend_alignment_score',
    'volume_score',
    'sector_strength_score',
    'fundamental_score',
    'rsi',
    'volume_ratio',
    'above_sma200',
    'signal_score',
    'momentum_score',
    'rank_composite',
    'return_on_equity',
    'piotroski_f_score',
    'confluence_score',
]

MIN_TRAINING_ROWS = 30

# computed_at is TIMESTAMPTZ on Postgres / TEXT day-string on SQLite. Normalize to a
# 'YYYY-MM-DD' text day-key so it joins against the TEXT signal_date / technical_signals.date
# columns (a bare (computed_at)::date on PG can't be compared to a text column).
_CS_DAY = "to_char(cs.computed_at, 'YYYY-MM-DD')" if use_postgres() else "DATE(cs.computed_at)"


def get_connection() -> ConnWrapper:
    return connect()


def build_training_data(conn):
    # Common feature projection — column NAMES are what the consumer reads (order-independent).
    _SELECT_COLS = """
            cs.symbol,
            so.signal_date,
            cs.bullish_screener_count,
            cs.bearish_screener_count,
            cs.active_screener_count,
            cs.trend_alignment_score,
            cs.volume_score,
            cs.sector_strength_score,
            cs.fundamental_score,
            cs.confluence_score,
            COALESCE(cs.rsi, 50)                AS rsi,
            COALESCE(ts.volume_ratio, 1.0)       AS volume_ratio,
            COALESCE(ts.above_sma200, 0)         AS above_sma200,
            COALESCE(ts.signal_score, 0)         AS signal_score,
            COALESCE(qs.momentum_score, 50)      AS momentum_score,
            COALESCE(qs.rank_composite, 50)      AS rank_composite,
            COALESCE(fh.return_on_equity, 0)     AS return_on_equity,
            COALESCE(fh.piotroski_f_score, 4)    AS piotroski_f_score,
            so.outcome"""

    # Point-in-time fundamentals as-of so.signal_date. stock_fundamentals is a current
    # snapshot only -- joining it directly (as this used to) leaks future fundamentals
    # into training rows for symbols whose outcome predates today.
    _FUND_JOIN = as_of_join_sql('fundamentals_history', 'fh', 'so', 'symbol', 'signal_date')

    if use_postgres():
        # Outcome-driven rewrite: the ~4k h7 WIN/LOSS outcomes drive the scan, and a LATERAL
        # picks the latest confluence row per (symbol, signal-day) using a SARGABLE computed_at
        # range so the (symbol, computed_at) PK does a range-seek. The previous version ran a
        # ROW_NUMBER() window over the ENTIRE ~1.9M-row confluence_signals table and joined on a
        # non-sargable to_char(computed_at) day-key — it hung for >8 min and tripped the 120s
        # queue timeout every run. This form returns the same rows in <1s.
        sql = f"""
        SELECT
        {_SELECT_COLS}
        FROM signal_outcomes so
        JOIN LATERAL (
            SELECT c.* FROM confluence_signals c
            WHERE c.symbol = so.symbol
              AND c.confluence_score IS NOT NULL
              AND c.computed_at >= so.signal_date::timestamp
              AND c.computed_at <  so.signal_date::timestamp + INTERVAL '1 day'
            ORDER BY c.computed_at DESC
            LIMIT 1
        ) cs ON true
        LEFT JOIN technical_signals ts ON ts.symbol = cs.symbol AND ts.date = so.signal_date
        LEFT JOIN quant_scores qs       ON qs.symbol = cs.symbol
        {_FUND_JOIN}
        WHERE so.horizon_days = 7 AND so.outcome IN ('WIN', 'LOSS')
          AND so.signal_source = 'confluence'
        """
    else:
        # SQLite (dev): tiny dataset, keep the portable window-function form (no LATERAL).
        sql = f"""
        WITH daily_confluence AS (
            SELECT * FROM (
                SELECT cs.*,
                    ROW_NUMBER() OVER (
                        PARTITION BY cs.symbol, {_CS_DAY}
                        ORDER BY cs.computed_at DESC
                    ) AS row_num
                FROM confluence_signals cs
                WHERE cs.confluence_score IS NOT NULL
            )
            WHERE row_num = 1
        )
        SELECT
        {_SELECT_COLS}
        FROM daily_confluence cs
        JOIN signal_outcomes so
          ON so.symbol = cs.symbol
          AND {_CS_DAY} = so.signal_date
          AND so.horizon_days = 7
          AND so.outcome IN ('WIN', 'LOSS')
          AND so.signal_source = 'confluence'
        LEFT JOIN technical_signals ts
          ON ts.symbol = cs.symbol
          AND ts.date = {_CS_DAY}
        LEFT JOIN quant_scores qs ON qs.symbol = cs.symbol
        {_FUND_JOIN}
        """
    rows = conn.execute(sql).fetchall()

    if len(rows) < MIN_TRAINING_ROWS:
        return None, None, None, len(rows)

    # Sort chronologically by signal_date -- required for TimeSeriesSplit(gap=embargo) in
    # train() to actually be a walk-forward split rather than an arbitrary row order (Finding
    # #16, 2026-07-28 full-stack audit: the query itself had no ORDER BY, so even disabling
    # StratifiedKFold's shuffle wouldn't have made the folds chronological).
    rows = sorted(rows, key=lambda r: r['signal_date'])

    X, y, dates = [], [], []
    for r in rows:
        x_row = [
            r['bullish_screener_count'] or 0,
            r['bearish_screener_count'] or 0,
            r['active_screener_count'] or 0,
            r['trend_alignment_score'] or 0,
            r['volume_score'] or 0,
            r['sector_strength_score'] or 0,
            r['fundamental_score'] or 0,
            r['rsi'] or 50,
            r['volume_ratio'] or 1,
            r['above_sma200'] or 0,
            r['signal_score'] or 0,
            r['momentum_score'] or 50,
            r['rank_composite'] or 50,
            r['return_on_equity'] or 0,
            r['piotroski_f_score'] or 4,
            r['confluence_score'] or 0,
        ]
        X.append(x_row)
        y.append(1 if r['outcome'] == 'WIN' else 0)
        dates.append(r['signal_date'])

    return np.array(X, dtype=np.float32), np.array(y), np.array(dates), len(rows)


def build_model():
    if HAS_XGB:
        print('[ML] Using XGBoost')
        return xgb.XGBClassifier(
            n_estimators=200, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            use_label_encoder=False, eval_metric='logloss',
            random_state=42, n_jobs=-1
        )
    if HAS_LGB:
        print('[ML] Using LightGBM')
        return lgb.LGBMClassifier(
            n_estimators=200, max_depth=5, learning_rate=0.05,
            subsample=0.8, colsample_bytree=0.8,
            random_state=42, n_jobs=-1, verbose=-1
        )
    print('[ML] Using GradientBoosting (scikit-learn fallback)')
    return GradientBoostingClassifier(
        n_estimators=200, max_depth=4, learning_rate=0.05,
        subsample=0.8, random_state=42
    )


def compute_embargo(n_samples: int, n_unique_dates: int, horizon_days: int,
                     n_splits_target: int = 5) -> tuple[int, int]:
    """Purged walk-forward embargo, mirroring ml_ensemble.py's _fit_stack formula exactly
    (Finding #16, 2026-07-28 full-stack audit): rows carry `horizon_days`-forward-return
    labels, so adjacent trading days' rows have heavily overlapping forward windows and
    correlated outcomes -- a plain TimeSeriesSplit with no gap would still leak across the
    train/test boundary via that overlap. Returns (embargo_rows, n_splits), capping
    n_splits so sklearn's `n_splits * (test_size + gap) < n_samples` constraint always
    holds."""
    samples_per_day = max(1.0, n_samples / max(1, n_unique_dates))
    raw_embargo = int(samples_per_day * horizon_days)
    embargo = min(raw_embargo, n_samples // 6, n_samples // 10)
    n_splits = max(2, min(n_splits_target, n_samples // max(1, embargo + 1) - 1))
    return embargo, n_splits


def train(conn):
    X, y, dates, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Insufficient training data (need >={MIN_TRAINING_ROWS} rows with outcomes, have {n}). Skipping.')
        return False

    class_counts = np.bincount(y, minlength=2)
    if class_counts.min() < 5:
        print(f'[ML] Insufficient class balance for 5-fold calibration '
              f'(need >=5 wins and losses, have {class_counts[1]} wins and {class_counts[0]} losses). Skipping.')
        return False

    print(f'[ML] Training on {n} samples (win rate: {y.mean():.1%})')

    # Purged, chronological CV (Finding #16, 2026-07-28 full-stack audit): rows carry
    # 7-day-forward-return labels with heavily overlapping windows across adjacent trading
    # days -- the previous StratifiedKFold(shuffle=True) on an unordered query result was a
    # textbook CV leakage pattern (identical to what ml_ensemble.py's _fit_stack was already
    # built to avoid), inflating cv_roc_auc versus true forward performance. build_training_data
    # now returns rows sorted by signal_date; embargo/n_splits mirror _fit_stack's own formula.
    # This purged split is used ONLY for the outer, reported cv_roc_auc metric.
    # CalibratedClassifierCV's OWN internal cv below is deliberately left as the plain
    # integer 5 (unshuffled, contiguous stratified folds -- this was never the shuffled
    # StratifiedKFold the audit flagged, only the standalone `cv` object below was): each
    # outer TimeSeriesSplit fold's training slice can be far smaller than the full dataset
    # (e.g. ~1,500 rows for an early fold), and re-applying the SAME embargo size to that
    # inner split violates sklearn's `n_splits * (test_size + gap) < n_samples` constraint,
    # crashing every inner fold (confirmed live: "Too many splits=5 ... gap=2349").
    embargo, n_splits = compute_embargo(len(X), len(set(dates.tolist())), horizon_days=7)
    cv = TimeSeriesSplit(n_splits=n_splits, gap=embargo)

    # Scaler lives INSIDE the pipeline so cross_val_score and CalibratedClassifierCV's
    # internal CV each refit it per-fold. Previously scaler.fit_transform(X) ran on the
    # full dataset before any split, so every fold's held-out rows had already shaped the
    # mean/std used to scale that fold's training rows -- inflating the reported CV AUC
    # that gates deployment of this model.
    base_model = build_model()
    pipeline = Pipeline([('scaler', StandardScaler()), ('clf', base_model)])
    model = CalibratedClassifierCV(pipeline, cv=5, method='isotonic')
    model.fit(X, y)

    auc_scores = cross_val_score(model, X, y, cv=cv, scoring='roc_auc')
    new_auc = float(auc_scores.mean())
    print(f'[ML] CV AUC: {new_auc:.3f} +/- {auc_scores.std():.3f}  '
          f'(TimeSeriesSplit n_splits={n_splits}, embargo={embargo} rows)')

    # Promotion gate (Finding #17, 2026-07-28 full-stack audit): train() used to
    # unconditionally overwrite confluence_ml.pkl and set is_active=1 regardless of AUC --
    # a single noisy or adverse-regime retrain could silently degrade the live
    # ml_breakout_probability for every downstream consumer with no safety net. Matches the
    # champion/challenger gate ml_ensemble.py/live_screener_ml_ranker.py already use: only
    # activate if the new model beats the currently-active one's cv_roc_auc by >=
    # PROMOTION_MARGIN, or there is no active model yet.
    baseline_id = None
    baseline_auc = None
    baseline_trained_at = None
    try:
        row = conn.execute("""
            SELECT id, cv_roc_auc, trained_at FROM model_registry
            WHERE model_name = 'confluence_ml' AND is_active = 1
            ORDER BY id DESC LIMIT 1
        """).fetchone()
        if row and row[1] is not None:
            baseline_id, baseline_auc, baseline_trained_at = row[0], float(row[1]), row[2]
    except Exception:
        conn.rollback()

    clears_bar = clears_promotion_bar(new_auc, baseline_auc, PROMOTION_MARGIN)

    # Staleness override (2026-08-06): a baseline whose AUC predates a leak/bug fix can become
    # permanently unbeatable -- every honest post-fix retrain is measuring something the
    # pre-fix baseline never had to. Mirrors ml_ensemble.py/cs_ranker.py.
    staleness_override = False
    age_days = 0.0
    rejections = 0
    if baseline_id is not None and not clears_bar:
        rejections = rejections_since(conn, 'confluence_ml', baseline_id)
        staleness_override, age_days = staleness_override_applies(
            baseline_trained_at, rejections,
            CONFLUENCE_STALENESS_MAX_DAYS, CONFLUENCE_STALENESS_MAX_REJECTIONS)

    promote = clears_bar or staleness_override

    os.makedirs(MODEL_DIR, exist_ok=True)
    version = datetime.now().strftime('%Y%m%d_%H%M%S')

    if not promote:
        with open(CANDIDATE_PATH, 'wb') as f:
            pickle.dump(model, f)
        print(f'[ML] Candidate REJECTED: CV AUC={new_auc:.4f} did not beat active model\'s '
              f'{baseline_auc:.4f} + {PROMOTION_MARGIN} margin. Saved to {CANDIDATE_PATH} '
              f'for inspection; active model unchanged.')
        try:
            conn.execute("""
                INSERT INTO model_registry (model_name, model_version, model_type, cv_roc_auc,
                  feature_count, is_active, trained_at, notes)
                VALUES (?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP, ?)
            """, ('confluence_ml', version, 'breakout_probability', new_auc, len(FEATURE_COLS),
                  f'REJECTED cv_roc_auc={new_auc:.4f} vs baseline={baseline_auc:.4f}'
                  + (f' (baseline stale {age_days:.1f}d, {rejections} rejections so far)'
                     if baseline_id is not None else '')))
            conn.commit()
        except Exception:
            conn.rollback()
        return True

    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)

    if baseline_id is None:
        promo_note = f'cv_roc_auc={new_auc:.4f} (no prior model)'
    elif staleness_override:
        promo_note = (f'cv_roc_auc={new_auc:.4f}; STALENESS OVERRIDE -- baseline id={baseline_id} '
                       f'unbeaten {age_days:.1f}d across {rejections} rejections; adopting '
                       f'best-available candidate (baseline cv_roc_auc={baseline_auc:.4f})')
    else:
        promo_note = f'cv_roc_auc={new_auc:.4f} (beat baseline {baseline_auc:.4f})'

    # Register in model_registry (best-effort). NOTE: the prior code wrote a non-existent
    # `auc_score` column (correct column is cv_roc_auc) and omitted the NOT NULL model_version,
    # so the insert silently failed on every run — fixed here. rollback() keeps a failed
    # best-effort write from poisoning the shared Postgres transaction.
    try:
        conn.execute("""
            UPDATE model_registry SET is_active = 0
            WHERE model_name = 'confluence_ml' AND is_active = 1
        """)
        conn.execute("""
            INSERT INTO model_registry (model_name, model_version, model_type, cv_roc_auc,
              feature_count, is_active, trained_at, notes)
            VALUES (?, ?, ?, ?, ?, 1, CURRENT_TIMESTAMP, ?)
        """, ('confluence_ml', version, 'breakout_probability', new_auc, len(FEATURE_COLS), promo_note))
        conn.commit()
    except Exception:
        conn.rollback()

    if staleness_override:
        print(f'[ML] Promoted via STALENESS OVERRIDE: baseline id={baseline_id} unbeaten '
              f'{age_days:.1f}d across {rejections} rejections')
    print(f'[ML] Model ACTIVATED (CV AUC={new_auc:.4f}'
          + (f', beat baseline {baseline_auc:.4f})' if baseline_auc is not None else ', no prior model)'))
    print(f'[ML] Model saved to {MODEL_PATH}')
    return True


def update_probabilities(conn):
    if not os.path.exists(MODEL_PATH):
        print('[ML] No trained model found. Attempting initial training.')
        if not train(conn):
            print('[ML] Probability overlay deferred until enough 7-day outcomes are available.')
            return

    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)

    latest_batch = conn.execute(
        'SELECT MAX(computed_at) as ts FROM confluence_signals'
    ).fetchone()['ts']
    if not latest_batch:
        print('[ML] No confluence_signals found.')
        return

    rows = conn.execute(f"""
        SELECT cs.symbol, cs.computed_at,
            COALESCE(cs.bullish_screener_count, 0)  AS bullish_screener_count,
            COALESCE(cs.bearish_screener_count, 0)  AS bearish_screener_count,
            COALESCE(cs.active_screener_count, 0)   AS active_screener_count,
            COALESCE(cs.trend_alignment_score, 0)   AS trend_alignment_score,
            COALESCE(cs.volume_score, 0)            AS volume_score,
            COALESCE(cs.sector_strength_score, 0)   AS sector_strength_score,
            COALESCE(cs.fundamental_score, 0)       AS fundamental_score,
            COALESCE(cs.confluence_score, 0)        AS confluence_score,
            COALESCE(cs.rsi, 50)                    AS rsi,
            COALESCE(ts.volume_ratio, 1.0)          AS volume_ratio,
            COALESCE(ts.above_sma200, 0)            AS above_sma200,
            COALESCE(ts.signal_score, 0)            AS signal_score,
            COALESCE(qs.momentum_score, 50)         AS momentum_score,
            COALESCE(qs.rank_composite, 50)         AS rank_composite,
            COALESCE(sf.return_on_equity, 0)        AS return_on_equity,
            COALESCE(sf.piotroski_f_score, 4)       AS piotroski_f_score
        FROM confluence_signals cs
        LEFT JOIN technical_signals ts
          ON ts.symbol = cs.symbol AND ts.date = {_CS_DAY}
        LEFT JOIN quant_scores qs ON qs.symbol = cs.symbol
        LEFT JOIN stock_fundamentals sf ON sf.symbol = cs.symbol
        WHERE cs.computed_at = ?
    """, (latest_batch,)).fetchall()

    if not rows:
        print('[ML] No rows to score.')
        return

    X = np.array([[
        r['bullish_screener_count'], r['bearish_screener_count'], r['active_screener_count'],
        r['trend_alignment_score'], r['volume_score'], r['sector_strength_score'],
        r['fundamental_score'], r['rsi'], r['volume_ratio'], r['above_sma200'],
        r['signal_score'], r['momentum_score'], r['rank_composite'],
        r['return_on_equity'], r['piotroski_f_score'], r['confluence_score'],
    ] for r in rows], dtype=np.float32)

    # model is a CalibratedClassifierCV wrapping a Pipeline(scaler, clf) -- scaling
    # happens inside predict_proba, so X is passed through raw (unscaled).
    probs = model.predict_proba(X)[:, 1]

    conn.executemany("""
        UPDATE confluence_signals
        SET ml_breakout_probability = ?
        WHERE symbol = ? AND computed_at = ?
    """, [(float(round(prob, 4)), row['symbol'], row['computed_at'])
          for row, prob in zip(rows, probs)])

    conn.commit()
    print(f'[ML] Updated ml_breakout_probability for {len(rows)} signals (batch: {latest_batch})')


def evaluate(conn):
    X, y, _dates, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Not enough data to evaluate (have {n} rows).')
        return
    if not os.path.exists(MODEL_PATH):
        print('[ML] No model file found.')
        return
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    probs = model.predict_proba(X)[:, 1]
    preds = (probs >= 0.5).astype(int)
    print(f'[ML] Samples: {n}  Win rate: {y.mean():.1%}')
    print(f'[ML] AUC: {roc_auc_score(y, probs):.3f}  Accuracy: {accuracy_score(y, preds):.3f}')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--train', action='store_true')
    parser.add_argument('--update-probabilities', action='store_true')
    parser.add_argument('--evaluate', action='store_true')
    args = parser.parse_args()

    conn = get_connection()
    try:
        if args.train:
            train(conn)
        elif args.update_probabilities:
            update_probabilities(conn)
        elif args.evaluate:
            evaluate(conn)
        else:
            print('No mode specified. Use --train, --update-probabilities, or --evaluate.')
    finally:
        conn.close()
