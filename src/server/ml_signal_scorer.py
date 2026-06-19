"""
ML Signal Confidence Scorer
================================
Trains a GradientBoostingClassifier on historical signal_outcomes to predict
win probability for new signals, then writes win_probability to technical_signals.

Features used:
  - signal_score (composite score 1-10)
  - rsi, sma200_distance, bb_width, volume_ratio (from technical_signals or signals_json)
  - adx (trend strength)
  - nifty_regime encoded (BULL=1, SIDEWAYS=0, BEAR=-1)
  - signal type one-hot encoded

Requirements:
    pip install scikit-learn pandas numpy

Run:  python ml_signal_scorer.py              # train + score all pending signals
      python ml_signal_scorer.py --train-only  # train and save model only
      python ml_signal_scorer.py --score-only  # load saved model, score pending signals
      python ml_signal_scorer.py --min-samples 50
"""

import os
import sys
import json
import math
import datetime
import argparse
import pickle

import numpy as np
import pandas as pd

from db_compat import connect, read_df, ConnWrapper

MODEL_PATH = os.path.join(os.getcwd(), 'src', 'server', 'ml_signal_model.pkl')

REGIME_MAP   = {'BULL': 1.0, 'SIDEWAYS': 0.0, 'BEAR': -1.0}
SIGNAL_TYPES = [
    'RSI_DIVERGENCE', 'HIDDEN_DIVERGENCE', 'RESISTANCE_BREAKOUT',
    'MACD_CROSSOVER', 'BB_COMPRESSION', 'GOLDEN_CROSS',
    'OVERSOLD_RECOVERY', 'EMA_BULL_STACK', 'WEEK_52_BREAKOUT',
    'BULLISH_ENGULFING', 'SUPERTREND_CROSS', 'NR7_COMPRESSION',
    'VOLUME_ACCUMULATION', 'NEAR_52W_HIGH', 'CONSECUTIVE_STRENGTH',
    'ATR_CONTRACTION', 'PCR_EXTREME',
]


def load_training_data() -> pd.DataFrame:
    """Join signal_outcomes with technical_signals for feature extraction."""
    query = """
        SELECT
            so.symbol,
            so.signal_date,
            so.return_pct,
            so.outcome,
            so.signal_score,
            so.signals_json,
            so.horizon_days,
            ts.rsi,
            ts.adx,
            ts.nifty_regime,
            ts.sma200,
            ts.cmp,
            ts.volume_ratio
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
            ON ts.symbol = so.symbol AND ts.scan_date = so.signal_date
        WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
          AND so.return_pct IS NOT NULL
    """
    df = read_df(query)
    return df


def extract_features(df: pd.DataFrame) -> pd.DataFrame:
    """Build feature matrix from raw joined data."""
    features = pd.DataFrame()

    features['signal_score']  = pd.to_numeric(df['signal_score'], errors='coerce').fillna(5)
    features['rsi']           = pd.to_numeric(df['rsi'], errors='coerce').fillna(50)
    features['adx']           = pd.to_numeric(df['adx'], errors='coerce').fillna(20)
    features['volume_ratio']  = pd.to_numeric(df['volume_ratio'], errors='coerce').fillna(1.0)
    features['horizon_days']  = pd.to_numeric(df['horizon_days'], errors='coerce').fillna(5)

    # Nifty regime encoding
    features['regime_enc'] = df['nifty_regime'].map(REGIME_MAP).fillna(0.0)

    # SMA200 distance %
    cmp    = pd.to_numeric(df['cmp'], errors='coerce')
    sma200 = pd.to_numeric(df['sma200'], errors='coerce')
    features['sma200_dist'] = ((cmp - sma200) / sma200 * 100).fillna(0)

    # Signal type one-hot from signals_json
    type_counts: dict[str, list[int]] = {t: [] for t in SIGNAL_TYPES}
    for signals_json in df['signals_json']:
        found: set[str] = set()
        try:
            sigs = json.loads(signals_json or '[]')
            for s in sigs:
                if isinstance(s, dict):
                    found.add(s.get('type', ''))
        except (json.JSONDecodeError, TypeError):
            pass
        for t in SIGNAL_TYPES:
            type_counts[t].append(1 if t in found else 0)

    for t in SIGNAL_TYPES:
        features[f'sig_{t}'] = type_counts[t]

    return features


def build_label(df: pd.DataFrame) -> pd.Series:
    """Binary: WIN=1, else=0."""
    return (df['outcome'] == 'WIN').astype(int)


def train(min_samples: int = 30) -> object | None:
    """Train GradientBoostingClassifier. Returns fitted model or None if insufficient data."""
    try:
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.model_selection import cross_val_score
        from sklearn.preprocessing import StandardScaler
        from sklearn.pipeline import Pipeline
    except ImportError:
        print("[ML] ERROR: scikit-learn not installed. Run: pip install scikit-learn")
        sys.exit(1)

    print("[ML] Loading training data...")
    df = load_training_data()
    print(f"[ML] {len(df)} labelled outcomes loaded.")

    if len(df) < min_samples:
        print(f"[ML] Insufficient data ({len(df)} < {min_samples} samples). "
              "Run signal scans and compute outcomes first.")
        return None

    X = extract_features(df)
    y = build_label(df)

    win_rate = y.mean()
    print(f"[ML] Win rate in training set: {win_rate:.1%}  ({y.sum()} wins / {len(y)} total)")

    model = Pipeline([
        ('scaler', StandardScaler()),
        ('gb', GradientBoostingClassifier(
            n_estimators=200,
            max_depth=4,
            learning_rate=0.05,
            subsample=0.8,
            random_state=42,
        )),
    ])

    cv_scores = cross_val_score(model, X, y, cv=5, scoring='roc_auc')
    print(f"[ML] CV ROC-AUC: {cv_scores.mean():.3f} ± {cv_scores.std():.3f}")

    model.fit(X, y)
    print(f"[ML] Model trained on {len(df)} samples.")

    # Feature importances (from the GB step)
    gb       = model.named_steps['gb']
    feat_imp = sorted(zip(X.columns, gb.feature_importances_), key=lambda x: -x[1])
    print("[ML] Top 10 features:")
    for name, imp in feat_imp[:10]:
        print(f"  {name:30s}  {imp:.4f}")

    return model


def score_pending(conn: ConnWrapper, model) -> int:
    """Score technical_signals rows with no win_probability yet. Returns count updated."""
    query = """
        SELECT symbol, scan_date, signal_score, signals_json,
               rsi, adx, nifty_regime, sma200, cmp, volume_ratio
        FROM technical_signals
        WHERE win_probability IS NULL
          AND signals_json IS NOT NULL
        ORDER BY scan_date DESC
        LIMIT 5000
    """
    df = read_df(query)
    if df.empty:
        print("[ML] No pending signals to score.")
        return 0

    print(f"[ML] Scoring {len(df)} signals...")
    df['outcome']     = None
    df['return_pct']  = None
    df['horizon_days'] = 15

    X    = extract_features(df)
    probs = model.predict_proba(X)[:, 1]

    cur = conn.cursor()
    cur.executemany(
        "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND scan_date = ?",
        [(round(float(prob), 4), row['symbol'], row['scan_date'])
         for (_, row), prob in zip(df.iterrows(), probs)],
    )
    updated = len(df)

    conn.commit()
    return updated


def save_model(model) -> None:
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)
    with open(MODEL_PATH, 'wb') as f:
        pickle.dump(model, f)
    print(f"[ML] Model saved to {MODEL_PATH}")


def load_model_from_disk():
    if not os.path.exists(MODEL_PATH):
        return None
    with open(MODEL_PATH, 'rb') as f:
        model = pickle.load(f)
    print(f"[ML] Loaded model from {MODEL_PATH}")
    return model


def run(train_only: bool = False, score_only: bool = False, min_samples: int = 30):
    print(f"[ML] Starting at {datetime.datetime.now()}")
    conn = connect()

    try:
        if score_only:
            model = load_model_from_disk()
            if model is None:
                print("[ML] No saved model found. Run without --score-only to train first.")
                return
        else:
            model = train(min_samples=min_samples)
            if model is None:
                return
            save_model(model)

        if not train_only:
            updated = score_pending(conn, model)
            print(f"[ML] Updated win_probability for {updated} signals.")

    finally:
        conn.close()

    print("[ML] Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ML Signal Confidence Scorer")
    parser.add_argument("--train-only",  action="store_true",
                        help="Train and save model, do not score pending signals")
    parser.add_argument("--score-only",  action="store_true",
                        help="Load saved model and score pending signals (no retraining)")
    parser.add_argument("--min-samples", type=int, default=30,
                        help="Minimum labelled outcomes required to train (default: 30)")
    args = parser.parse_args()

    run(train_only=args.train_only, score_only=args.score_only, min_samples=args.min_samples)
