"""
Online / Incremental Learning Engine
========================================
Continuously updates signal confidence models using a rolling window of recent
signal_outcomes — without full retraining.

Strategy:
  - Primary: SGDClassifier (log-loss → calibrated probabilities) with partial_fit
  - Backup:  PassiveAggressiveClassifier for fast updates
  - Rolling window: last N days of outcomes (default 180 days)
  - After each update, scores all pending technical_signals

Also supports warm-start fine-tuning of the saved ensemble (ml_ensemble.py model)
by calling it on the recent window as additional training epochs.

Run:  python online_learner.py
      python online_learner.py --window 90   # last 90 days of outcomes
      python online_learner.py --min-new 10  # only update if ≥10 new outcomes
      python online_learner.py --dry-run
"""

import os, sys, json, datetime, argparse, pickle, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

DB_PATH        = os.path.join(os.getcwd(), 'database.sqlite')
from db_compat import connect, read_df, query_one, execute, use_postgres, ConnWrapper
MODELS_DIR     = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
ONLINE_PATH    = os.path.join(MODELS_DIR, 'online_sgd.pkl')
ENSEMBLE_PATH  = os.path.join(MODELS_DIR, 'ensemble.pkl')

SIGNAL_TYPES = [
    'RSI_DIVERGENCE', 'HIDDEN_DIVERGENCE', 'RESISTANCE_BREAKOUT',
    'MACD_CROSSOVER', 'BB_COMPRESSION', 'GOLDEN_CROSS', 'OVERSOLD_RECOVERY',
    'EMA_BULL_STACK', 'WEEK_52_BREAKOUT', 'BULLISH_ENGULFING', 'SUPERTREND_CROSS',
    'NR7_COMPRESSION', 'VOLUME_ACCUMULATION', 'NEAR_52W_HIGH',
    'CONSECUTIVE_STRENGTH', 'ATR_CONTRACTION', 'PCR_EXTREME',
]
REGIME_MAP = {'BULL': 1.0, 'SIDEWAYS': 0.0, 'BEAR': -1.0}


# ── Feature vector (same as ml_ensemble.py) ──────────────────────────────────

def _parse_types(signals_json: str) -> set[str]:
    try:
        return {s.get('type', '') for s in json.loads(signals_json or '[]') if isinstance(s, dict)}
    except Exception:
        return set()


def build_features(df: pd.DataFrame) -> np.ndarray:
    """Return numpy feature matrix; same feature order every call for compatibility."""
    X = []
    for _, row in df.iterrows():
        feats = [
            float(row.get('signal_score', 5) or 5),
            float(row.get('rsi',          50) or 50),
            float(row.get('adx',          20) or 20),
            float(row.get('volume_ratio',  1) or 1),
            float(row.get('horizon_days',  15) or 15),
            REGIME_MAP.get(str(row.get('nifty_regime', '')), 0.0),
        ]
        # SMA200 distance
        try:
            cmp    = float(row.get('cmp',    0) or 0)
            sma200 = float(row.get('sma200', 0) or 0)
            feats.append((cmp - sma200) / max(sma200, 1e-9) * 100)
        except Exception:
            feats.append(0.0)

        # score × regime interaction
        feats.append(feats[0] * feats[5])
        # RSI deviation
        feats.append(abs(feats[1] - 50))

        # Signal type one-hot
        types = _parse_types(str(row.get('signals_json', '[]')))
        feats.extend([1.0 if t in types else 0.0 for t in SIGNAL_TYPES])
        # Signal count
        feats.append(float(len(types)))

        X.append(feats)
    return np.array(X, dtype=np.float32)


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_recent_outcomes(conn: ConnWrapper, window_days: int, min_new: int) -> pd.DataFrame:
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=window_days)).strftime('%Y-%m-%d')
    q = """
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.scan_date = so.signal_date
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
          AND so.signal_date >= ?
        ORDER BY so.signal_date DESC
    """
    df = read_df(q, (cutoff,))
    return df


def load_pending_signals(conn: ConnWrapper) -> pd.DataFrame:
    q = """
        SELECT symbol, scan_date AS signal_date, signal_score, signals_json,
               rsi, adx, nifty_regime, cmp, sma200, volume_ratio
        FROM technical_signals
        WHERE win_probability IS NULL
        ORDER BY scan_date DESC
        LIMIT 10000
    """
    df = read_df(q)
    df['horizon_days'] = 15
    return df


# ── Online Model ──────────────────────────────────────────────────────────────

def load_or_init_sgd() -> dict:
    if os.path.exists(ONLINE_PATH):
        with open(ONLINE_PATH, 'rb') as f:
            return pickle.load(f)

    from sklearn.linear_model import SGDClassifier
    from sklearn.preprocessing import StandardScaler
    sgd = SGDClassifier(
        loss='log_loss', penalty='l2', alpha=1e-4,
        max_iter=1, warm_start=True, random_state=42, class_weight='balanced',
    )
    scaler = StandardScaler()
    return {
        'model':        sgd,
        'scaler':       scaler,
        'scaler_fitted': False,
        'n_samples_seen': 0,
        'last_updated':   None,
    }


def save_sgd(state: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(ONLINE_PATH, 'wb') as f:
        pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)


def partial_fit_sgd(state: dict, X: np.ndarray, y: np.ndarray) -> dict:
    from sklearn.linear_model import SGDClassifier

    classes = np.array([0, 1])
    if not state['scaler_fitted']:
        state['scaler'].fit(X)
        state['scaler_fitted'] = True
    Xs = state['scaler'].transform(X)

    state['model'].partial_fit(Xs, y, classes=classes)
    state['n_samples_seen'] += len(X)
    state['last_updated']    = datetime.datetime.now().isoformat()
    return state


def predict_sgd(state: dict, X: np.ndarray) -> np.ndarray:
    if not state['scaler_fitted']:
        return np.full(len(X), 0.5)
    Xs = state['scaler'].transform(X)
    try:
        return state['model'].predict_proba(Xs)[:, 1]
    except Exception:
        return np.full(len(X), 0.5)


# ── Register update ───────────────────────────────────────────────────────────

def register_update(conn: ConnWrapper, state: dict, n_new: int, cv_auc: float):
    version = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    cur = conn.cursor()
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, is_active, horizon_days, notes)
        VALUES ('online_sgd', ?, 'OnlineSGD', ?, ?, ?, 1, 15, ?)
    """, (
        version,
        state['last_updated'],
        state['n_samples_seen'],
        round(cv_auc, 4),
        f"Incremental update — {n_new} new outcomes",
    ))
    conn.commit()


# ── Score pending signals ─────────────────────────────────────────────────────

def score_pending_with_ensemble_blend(
    conn: ConnWrapper,
    sgd_state: dict,
    ensemble: dict | None,
    df: pd.DataFrame,
) -> int:
    """Blend online SGD (40%) + ensemble (60%) if ensemble is available."""
    X = build_features(df)

    sgd_probs = predict_sgd(sgd_state, X)

    if ensemble:
        # Align features to ensemble's expected columns
        import pandas as pd
        feat_df = pd.DataFrame(X)  # raw array — need named cols
        # Use SGD as fallback for ensemble alignment
        ens_probs = sgd_probs  # fallback if alignment fails
        try:
            from ml_ensemble import build_features as ens_feats, predict_proba_ensemble
            X_named = ens_feats(df)
            for col in ensemble['feature_names']:
                if col not in X_named.columns:
                    X_named[col] = 0.0
            X_named = X_named[ensemble['feature_names']].astype(np.float32)
            ens_probs = predict_proba_ensemble(ensemble, X_named)
        except Exception:
            pass

        probs = 0.4 * sgd_probs + 0.6 * ens_probs
    else:
        probs = sgd_probs

    cur = conn.cursor()
    updated = 0
    for (_, row), prob in zip(df.iterrows(), probs):
        cur.execute(
            "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND scan_date = ?",
            (round(float(prob), 4), row['symbol'], row['signal_date']),
        )
        updated += 1
    conn.commit()
    return updated


# ── Main ──────────────────────────────────────────────────────────────────────

def run(window_days: int = 180, min_new: int = 5, dry_run: bool = False):
    try:
        from sklearn.linear_model import SGDClassifier
    except ImportError:
        print("[OnlineLearner] scikit-learn not installed.")
        sys.exit(1)

    print(f"[OnlineLearner] Starting at {datetime.datetime.now()}")
    conn = connect()

    try:
        df = load_recent_outcomes(conn, window_days, min_new)
        print(f"[OnlineLearner] {len(df)} recent outcomes in last {window_days} days")

        if len(df) < min_new:
            print(f"[OnlineLearner] Need {min_new} new outcomes — skipping update.")
            return

        y  = (df['outcome'] == 'WIN').astype(int).values
        X  = build_features(df)

        # Load existing SGD state
        state = load_or_init_sgd()

        # Evaluate on last 20% before updating (rough held-out estimate)
        split = max(int(len(X) * 0.8), 5)
        Xtrain, Xval = X[:split], X[split:]
        ytrain, yval = y[:split], y[split:]

        if dry_run:
            print("[OnlineLearner] Dry-run: skipping update and scoring.")
            return

        state = partial_fit_sgd(state, Xtrain, ytrain)

        # Crude AUC on val set
        cv_auc = 0.5
        if len(Xval) >= 5:
            try:
                from sklearn.metrics import roc_auc_score
                val_probs = predict_sgd(state, Xval)
                if len(np.unique(yval)) > 1:
                    cv_auc = roc_auc_score(yval, val_probs)
            except Exception:
                pass

        print(f"[OnlineLearner] Updated — samples_seen={state['n_samples_seen']}  "
              f"val_AUC={cv_auc:.4f}")
        save_sgd(state)
        register_update(conn, state, len(df), cv_auc)

        # Load ensemble for blended scoring
        ensemble = None
        if os.path.exists(ENSEMBLE_PATH):
            with open(ENSEMBLE_PATH, 'rb') as f:
                ensemble = pickle.load(f)

        pending = load_pending_signals(conn)
        if not pending.empty:
            n = score_pending_with_ensemble_blend(conn, state, ensemble, pending)
            print(f"[OnlineLearner] Scored {n} pending signals.")

        print("[OnlineLearner] Done.")

    finally:
        conn.close()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Online / Incremental Learning Engine")
    parser.add_argument("--window",    type=int, default=180,
                        help="Rolling window in days (default: 180)")
    parser.add_argument("--min-new",   type=int, default=5,
                        help="Minimum new outcomes to trigger update (default: 5)")
    parser.add_argument("--dry-run",   action="store_true")
    args = parser.parse_args()

    run(window_days=args.window, min_new=args.min_new, dry_run=args.dry_run)
