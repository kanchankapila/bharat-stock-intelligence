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
import sqlite3
import numpy as np
from datetime import datetime, timedelta

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
from sklearn.model_selection import StratifiedKFold, cross_val_score
from sklearn.preprocessing import StandardScaler
from sklearn.metrics import roc_auc_score, accuracy_score
from sklearn.pipeline import Pipeline
from sklearn.calibration import CalibratedClassifierCV

DB_PATH = os.path.join(os.path.dirname(__file__), '..', '..', 'database.sqlite')
MODEL_DIR = os.path.join(os.path.dirname(__file__), 'ml_models')
MODEL_PATH = os.path.join(MODEL_DIR, 'confluence_ml.pkl')
SCALER_PATH = os.path.join(MODEL_DIR, 'confluence_scaler.pkl')

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

def get_connection():
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn


def build_training_data(conn):
    rows = conn.execute("""
        SELECT
            cs.symbol,
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
            COALESCE(sf.return_on_equity, 0)     AS return_on_equity,
            COALESCE(sf.piotroski_f_score, 4)    AS piotroski_f_score,
            so.outcome
        FROM confluence_signals cs
        JOIN signal_outcomes so
          ON so.symbol = cs.symbol
          AND DATE(cs.computed_at) = so.signal_date
          AND so.horizon_days = 7
          AND so.outcome IN ('WIN', 'LOSS')
        LEFT JOIN technical_signals ts
          ON ts.symbol = cs.symbol
          AND ts.date = DATE(cs.computed_at)
        LEFT JOIN quant_scores qs ON qs.symbol = cs.symbol
        LEFT JOIN stock_fundamentals sf ON sf.symbol = cs.symbol
        WHERE cs.confluence_score IS NOT NULL
    """).fetchall()

    if len(rows) < 30:
        return None, None, len(rows)

    X, y = [], []
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

    return np.array(X, dtype=np.float32), np.array(y), len(rows)


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


def train(conn):
    X, y, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Insufficient training data (need >=30 rows with outcomes, have {n}). Skipping.')
        return

    print(f'[ML] Training on {n} samples (win rate: {y.mean():.1%})')
    scaler = StandardScaler()
    X_scaled = scaler.fit_transform(X)

    base_model = build_model()
    model = CalibratedClassifierCV(base_model, cv=5, method='isotonic')
    model.fit(X_scaled, y)

    cv = StratifiedKFold(n_splits=5, shuffle=True, random_state=42)
    auc_scores = cross_val_score(model, X_scaled, y, cv=cv, scoring='roc_auc')
    print(f'[ML] CV AUC: {auc_scores.mean():.3f} +/- {auc_scores.std():.3f}')

    os.makedirs(MODEL_DIR, exist_ok=True)
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)
    with open(SCALER_PATH, 'wb') as f:
        pickle.dump(scaler, f)

    # Register in model_registry if table exists
    try:
        conn.execute("""
            INSERT OR REPLACE INTO model_registry (model_name, model_type, auc_score,
              feature_count, is_active, trained_at)
            VALUES (?, ?, ?, ?, 1, CURRENT_TIMESTAMP)
        """, ('confluence_ml', 'breakout_probability', float(auc_scores.mean()), len(FEATURE_COLS)))
        conn.commit()
    except Exception:
        pass  # model_registry may not exist or have different schema

    print(f'[ML] Model saved to {MODEL_PATH}')


def update_probabilities(conn):
    if not os.path.exists(MODEL_PATH) or not os.path.exists(SCALER_PATH):
        print('[ML] No trained model found. Run with --train first.')
        return

    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    with open(SCALER_PATH, 'rb') as f:
        scaler = pickle.load(f)

    latest_batch = conn.execute(
        'SELECT MAX(computed_at) as ts FROM confluence_signals'
    ).fetchone()['ts']
    if not latest_batch:
        print('[ML] No confluence_signals found.')
        return

    rows = conn.execute("""
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
          ON ts.symbol = cs.symbol AND ts.date = DATE(cs.computed_at)
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

    X_scaled = scaler.transform(X)
    probs = model.predict_proba(X_scaled)[:, 1]

    for row, prob in zip(rows, probs):
        conn.execute("""
            UPDATE confluence_signals
            SET ml_breakout_probability = ?
            WHERE symbol = ? AND computed_at = ?
        """, (float(round(prob, 4)), row['symbol'], row['computed_at']))

    conn.commit()
    print(f'[ML] Updated ml_breakout_probability for {len(rows)} signals (batch: {latest_batch})')


def evaluate(conn):
    X, y, n = build_training_data(conn)
    if X is None:
        print(f'[ML] Not enough data to evaluate (have {n} rows).')
        return
    if not os.path.exists(MODEL_PATH):
        print('[ML] No model file found.')
        return
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    with open(SCALER_PATH, 'rb') as f:
        scaler = pickle.load(f)
    X_scaled = scaler.transform(X)
    probs = model.predict_proba(X_scaled)[:, 1]
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
