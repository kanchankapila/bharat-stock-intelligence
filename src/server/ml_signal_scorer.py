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
            ON ts.symbol = so.symbol AND ts.date = so.signal_date
        WHERE so.outcome IN ('WIN', 'LOSS', 'NEUTRAL')
          AND so.return_pct IS NOT NULL
          AND so.signal_source = 'technical'
        ORDER BY so.signal_date
    """
    # ORDER BY signal_date added (Finding #45, 2026-07-28 full-stack audit): cross_val_score
    # below uses cv=5 with the sklearn default of shuffle=False, whose "contiguous fold"
    # property is meaningless without a guaranteed chronological row order -- the reported
    # CV AUC wasn't a trustworthy walk-forward estimate without this.
    #
    # ts.scan_date -> ts.date fixed in the same pass: technical_signals has no scan_date
    # column (only `date` -- confirmed against db/schema.postgres.sql), so this JOIN
    # previously threw psycopg2.errors.UndefinedColumn on every single run against
    # Postgres. This is consistent with the audit's own "confirmed dormant" framing for
    # this script -- it hadn't just never been scheduled, it couldn't have run successfully
    # against production at all.
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


def compute_embargo(n_samples: int, n_unique_dates: int, horizon_days: float,
                     n_splits_target: int = 5) -> tuple[int, int]:
    """Purged walk-forward embargo -- same formula as confluence_ml_engine.py's
    compute_embargo() / ml_ensemble.py's _fit_stack (Finding #45, 2026-07-28 full-stack
    audit). StratifiedKFold(cv=5)'s default shuffle=False groups rows by class label
    first, then slices contiguous chunks WITHIN each class -- that is NOT a chronological
    walk-forward split even if the input rows are pre-sorted by date, so a real
    TimeSeriesSplit(gap=embargo) is needed here, not just an ORDER BY."""
    samples_per_day = max(1.0, n_samples / max(1, n_unique_dates))
    raw_embargo = int(samples_per_day * horizon_days)
    embargo = min(raw_embargo, n_samples // 6, n_samples // 10)
    n_splits = max(2, min(n_splits_target, n_samples // max(1, embargo + 1) - 1))
    return embargo, n_splits


def train(min_samples: int = 30) -> tuple[object, float, int] | tuple[None, None, int]:
    """Train GradientBoostingClassifier. Returns (fitted model, purged CV AUC, n_samples),
    or (None, None, n_rows_seen) if insufficient data."""
    try:
        from sklearn.ensemble import GradientBoostingClassifier
        from sklearn.model_selection import cross_val_score, TimeSeriesSplit
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
        return None, None, len(df)

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

    # Purged, chronological CV (Finding #45): df is sorted by signal_date (see
    # load_training_data), and rows carry overlapping-window forward-return labels --
    # horizon_days varies per row, so the median horizon is used as a representative
    # embargo width (a conservative, not row-exact, purge).
    median_horizon = float(pd.to_numeric(df['horizon_days'], errors='coerce').fillna(5).median())
    embargo, n_splits = compute_embargo(len(X), df['signal_date'].nunique(), median_horizon)
    cv = TimeSeriesSplit(n_splits=n_splits, gap=embargo)

    cv_scores = cross_val_score(model, X, y, cv=cv, scoring='roc_auc')
    cv_auc = float(cv_scores.mean())
    print(f"[ML] CV ROC-AUC: {cv_auc:.3f} +/- {cv_scores.std():.3f}  "
          f"(TimeSeriesSplit n_splits={n_splits}, embargo={embargo} rows)")

    model.fit(X, y)
    print(f"[ML] Model trained on {len(df)} samples.")

    # Feature importances (from the GB step)
    gb       = model.named_steps['gb']
    feat_imp = sorted(zip(X.columns, gb.feature_importances_), key=lambda x: -x[1])
    print("[ML] Top 10 features:")
    for name, imp in feat_imp[:10]:
        print(f"  {name:30s}  {imp:.4f}")

    return model, cv_auc, len(df)


def score_pending(conn: ConnWrapper, model) -> int:
    """Score technical_signals rows with no win_probability yet. Returns count updated."""
    # date AS scan_date (not a real column -- see load_training_data()'s note on the same
    # ts.scan_date -> ts.date fix) keeps the Python-side df['scan_date']/row['scan_date']
    # references below unchanged.
    query = """
        SELECT symbol, date AS scan_date, signal_score, signals_json,
               rsi, adx, nifty_regime, sma200, cmp, volume_ratio
        FROM technical_signals
        WHERE win_probability IS NULL
          AND signals_json IS NOT NULL
        ORDER BY date DESC
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
        "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND date = ?",
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


# `technical_signals.win_probability` is the canonical, hard-gated ML output for the whole
# platform (scoring_engine.py's 0.40 win-probability floor, written under ml_ensemble.py's
# own PROMOTION_MARGIN check). This script is confirmed dormant -- not wired into any
# queues.ts cron -- but nothing stops it being run manually, at which point it would
# silently overwrite that canonical, gated column with an ungated model (Finding #45,
# 2026-07-28 full-stack audit). CANONICAL_WRITE_TOLERANCE allows this simpler model to be
# somewhat worse than the canonical ensemble without blocking the write (it's a different,
# intentionally lighter model family, not expected to beat the full stacking ensemble) --
# but a write is refused outright if it would be a meaningful downgrade.
CANONICAL_WRITE_TOLERANCE = 0.03


def _active_ensemble_baseline(conn: ConnWrapper) -> float | None:
    """test_roc_auc (preferred) or cv_roc_auc of the currently active canonical `ensemble`
    model -- the one whose win_probability this script would overwrite."""
    try:
        row = conn.execute(
            "SELECT test_roc_auc, cv_roc_auc FROM model_registry "
            "WHERE model_name = 'ensemble' AND is_active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if not row:
            return None
        test_auc, cv_auc = row[0], row[1]
        val = test_auc if test_auc is not None else cv_auc
        return float(val) if val is not None else None
    except Exception:
        return None


def register_run(conn: ConnWrapper, cv_auc: float, n_samples: int, promoted: bool,
                  baseline_auc: float | None) -> None:
    try:
        notes = f"CV AUC={cv_auc:.4f}" + (
            f" vs canonical ensemble baseline={baseline_auc:.4f} -> "
            f"{'WROTE win_probability' if promoted else 'REFUSED write, canonical column untouched'}"
            if baseline_auc is not None else " (no active ensemble baseline to compare against)"
        )
        conn.execute("""
            INSERT INTO model_registry (model_name, model_version, model_type, cv_roc_auc,
              training_samples, is_active, notes, trained_at)
            VALUES ('ml_signal_scorer', ?, 'GradientBoostingClassifier', ?, ?, ?, ?, CURRENT_TIMESTAMP)
        """, (
            datetime.datetime.now().strftime('%Y%m%d_%H%M%S'),
            round(cv_auc, 4), n_samples, 1 if promoted else 0, notes,
        ))
        conn.commit()
    except Exception:
        conn.rollback()


def run(train_only: bool = False, score_only: bool = False, min_samples: int = 30):
    print(f"[ML] Starting at {datetime.datetime.now()}")
    conn = connect()

    try:
        if score_only:
            model = load_model_from_disk()
            if model is None:
                print("[ML] No saved model found. Run without --score-only to train first.")
                return
            cv_auc, n_samples = None, None
        else:
            model, cv_auc, n_samples = train(min_samples=min_samples)
            if model is None:
                return
            save_model(model)

        if not train_only:
            # Promotion gate (Finding #45, 2026-07-28 full-stack audit): only allowed to
            # write to the canonical win_probability column if this run's CV AUC doesn't
            # meaningfully undercut the currently-active canonical ensemble's own AUC.
            # --score-only reuses a previously-saved (already-trained) model with no fresh
            # cv_auc to check -- refuse that path outright rather than assume it's still safe.
            if cv_auc is None:
                print("[ML] REFUSED: --score-only has no fresh CV AUC to gate against the "
                      "canonical ensemble baseline -- re-run without --score-only to train "
                      "and re-validate before writing win_probability.")
                return

            baseline_auc = _active_ensemble_baseline(conn)
            promoted = baseline_auc is None or cv_auc >= baseline_auc - CANONICAL_WRITE_TOLERANCE
            register_run(conn, cv_auc, n_samples, promoted, baseline_auc)

            if not promoted:
                print(f"[ML] REFUSED: CV AUC={cv_auc:.4f} is more than {CANONICAL_WRITE_TOLERANCE} "
                      f"below the active canonical ensemble's {baseline_auc:.4f} -- NOT writing "
                      f"win_probability. Model saved to {MODEL_PATH} for inspection only.")
                return

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
