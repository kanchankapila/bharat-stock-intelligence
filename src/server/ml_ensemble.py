from pathlib import Path
"""
ML Ensemble Signal Confidence Scorer
======================================
Trains an ensemble of classifiers on historical signal_outcomes and uses the
combined probability estimate as win_probability for new signals.

Models:
  - LGBMClassifier              (GPU-accelerated, replaces GradientBoostingClassifier)
  - XGBClassifier               (GPU-accelerated, 5th base model)
  - RandomForestClassifier
  - ExtraTreesClassifier
  - LogisticRegression          (linear baseline)
  Meta-learner: LogisticRegression on out-of-fold base model probabilities (stacking)

All models are calibrated with CalibratedClassifierCV (isotonic for tree models,
sigmoid for logistic).

Features:
  - signal_score, rsi, adx, volume_ratio, sma200_dist
  - nifty_regime (encoded: BULL=1, SIDEWAYS=0, BEAR=-1)
  - horizon_days
  - signal type one-hot (17 types)
  - score × regime interaction

Requirements:
    pip install scikit-learn pandas numpy lightgbm xgboost

Run:  python ml_ensemble.py
      python ml_ensemble.py --train
      python ml_ensemble.py --score
      python ml_ensemble.py --retrain-full      # discard saved model, retrain from scratch
      python ml_ensemble.py --min-samples 30
"""

import os, sys, json, math, datetime, argparse, pickle, sqlite3, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

DB_PATH      = Path(__file__).parent.parent.parent / "database.sqlite"
MODELS_DIR  = os.path.join(os.getcwd(), 'src', 'server', 'ml_models')
ENSEMBLE_PATH = os.path.join(MODELS_DIR, 'ensemble.pkl')

REGIME_MAP   = {'BULL': 1.0, 'SIDEWAYS': 0.0, 'BEAR': -1.0}
SIGNAL_TYPES = [
    'RSI_DIVERGENCE', 'HIDDEN_DIVERGENCE', 'RESISTANCE_BREAKOUT',
    'MACD_CROSSOVER', 'BB_COMPRESSION', 'GOLDEN_CROSS', 'OVERSOLD_RECOVERY',
    'EMA_BULL_STACK', 'WEEK_52_BREAKOUT', 'BULLISH_ENGULFING', 'SUPERTREND_CROSS',
    'NR7_COMPRESSION', 'VOLUME_ACCUMULATION', 'NEAR_52W_HIGH',
    'CONSECUTIVE_STRENGTH', 'ATR_CONTRACTION', 'PCR_EXTREME',
]


# ── Feature Engineering ──────────────────────────────────────────────────────

def _parse_signal_types(signals_json) -> set[str]:
    if signals_json is None:
        return set()
    try:
        return {s.get('type', '') for s in json.loads(signals_json) if isinstance(s, dict)}
    except Exception:
        return set()


def build_features(df: pd.DataFrame) -> pd.DataFrame:
    X = pd.DataFrame(index=df.index)

    X['signal_score']  = pd.to_numeric(df.get('signal_score', 5), errors='coerce').fillna(5)
    X['rsi']           = pd.to_numeric(df.get('rsi', 50), errors='coerce').fillna(50)
    X['adx']           = pd.to_numeric(df.get('adx', 20), errors='coerce').fillna(20)
    X['volume_ratio']  = pd.to_numeric(df.get('volume_ratio', 1.0), errors='coerce').fillna(1.0)
    X['horizon_days']  = pd.to_numeric(df.get('horizon_days', 15), errors='coerce').fillna(15)

    regime_raw  = df.get('nifty_regime', pd.Series(['UNKNOWN'] * len(df), index=df.index))
    X['regime'] = regime_raw.map(REGIME_MAP).fillna(0.0)

    cmp    = pd.to_numeric(df.get('cmp',    np.nan), errors='coerce')
    sma200 = pd.to_numeric(df.get('sma200', np.nan), errors='coerce')
    X['sma200_dist'] = ((cmp - sma200) / sma200.replace(0, np.nan) * 100).fillna(0)

    # Interaction: score strength in current regime
    X['score_x_regime'] = X['signal_score'] * X['regime']
    # Rsi deviation from neutral zone
    X['rsi_deviation']  = (X['rsi'] - 50).abs()

    # FII flow — normalized (Cr), negative = selling pressure
    X['fii_3d_net'] = pd.to_numeric(df.get('fii_3d_net', 0), errors='coerce').fillna(0) / 10000.0

    # Above SMA200 binary flag
    X['above_sma200'] = pd.to_numeric(df.get('above_sma200', 0), errors='coerce').fillna(0).clip(0, 1)

    # Distance from 52-week high (as % — negative means below the high)
    cmp_s      = pd.to_numeric(df.get('cmp', np.nan), errors='coerce')
    hi52_s     = pd.to_numeric(df.get('fifty_two_week_high', np.nan), errors='coerce')
    X['dist_52w_high'] = ((cmp_s - hi52_s) / hi52_s.replace(0, np.nan) * 100).fillna(0)

    # PCR — put/call ratio (stock level and market level)
    X['pcr_oi']  = pd.to_numeric(df.get('pcr_oi',  1.0), errors='coerce').fillna(1.0)
    X['pcr_vol'] = pd.to_numeric(df.get('pcr_vol', 1.0), errors='coerce').fillna(1.0)

    # Extended FII/DII flows (normalized to 10K Cr scale)
    X['fii_10d_net'] = pd.to_numeric(df.get('fii_10d_net', 0), errors='coerce').fillna(0) / 10000.0
    X['dii_3d_net']  = pd.to_numeric(df.get('dii_3d_net',  0), errors='coerce').fillna(0) / 10000.0

    # Delivery % (institutional conviction proxy, normalized to 0-1)
    X['delivery_pct'] = pd.to_numeric(df.get('delivery_pct', 50), errors='coerce').fillna(50) / 100.0

    # Sector relative momentum
    X['sector_ret_5d']  = pd.to_numeric(df.get('sector_ret_5d',  0), errors='coerce').fillna(0)
    X['sector_ret_21d'] = pd.to_numeric(df.get('sector_ret_21d', 0), errors='coerce').fillna(0)

    # Interaction: delivery conviction × signal score
    X['delivery_x_score'] = X['delivery_pct'] * X['signal_score']

    # Signal type one-hot
    sig_col = df.get('signals_json', pd.Series(['[]'] * len(df), index=df.index))
    type_sets = sig_col.apply(_parse_signal_types)
    for t in SIGNAL_TYPES:
        X[f'sig_{t}'] = type_sets.apply(lambda s: 1 if t in s else 0).astype(np.int8)

    # Signal count (complexity)
    X['signal_count'] = type_sets.apply(len)

    return X.astype(np.float32)


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_training_data(conn: sqlite3.Connection) -> pd.DataFrame:
    q = """
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json, so.return_pct,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net,
               ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               sf.fifty_two_week_high
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN stock_fundamentals sf
               ON sf.symbol = so.symbol
        WHERE so.outcome IN ('WIN','LOSS')
          AND so.return_pct IS NOT NULL
    """
    df = pd.read_sql_query(q, conn)
    df['outcome'] = df['outcome'].map({'WIN': 1, 'LOSS': 0})
    return df


def load_pending_signals(conn: sqlite3.Connection) -> pd.DataFrame:
    q = """
        SELECT ts.symbol, ts.date AS signal_date, ts.signal_score, ts.signals_json,
               ts.rsi, ts.adx, ts.nifty_regime, ts.cmp, ts.sma200, ts.volume_ratio,
               ts.fii_3d_net,
               ts.above_sma200,
               ts.pcr_oi, ts.pcr_vol,
               ts.fii_10d_net, ts.dii_3d_net,
               ts.delivery_pct,
               ts.sector_ret_5d, ts.sector_ret_21d,
               sf.fifty_two_week_high
        FROM technical_signals ts
        LEFT JOIN stock_fundamentals sf ON sf.symbol = ts.symbol
        WHERE ts.win_probability IS NULL
          AND ts.signals_json IS NOT NULL
        ORDER BY ts.date DESC
        LIMIT 10000
    """
    df = pd.read_sql_query(q, conn)
    df['horizon_days'] = 15
    return df


# ── Model Building ────────────────────────────────────────────────────────────

def _gpu_device() -> str:
    """Return 'cuda' if GPU is available AND LightGBM was built with CUDA, else 'cpu'."""
    try:
        import torch
        if not torch.cuda.is_available():
            return 'cpu'
    except ImportError:
        return 'cpu'
    # Verify LightGBM CUDA support with a minimal probe
    try:
        from lightgbm import LGBMClassifier
        import numpy as np
        _probe = LGBMClassifier(n_estimators=1, device='cuda', verbose=-1)
        _probe.fit(np.array([[0], [1]]), np.array([0, 1]))
        return 'cuda'
    except Exception:
        return 'cpu'


def _base_models(scale_pos_weight: float = 1.0):
    from sklearn.ensemble import RandomForestClassifier, ExtraTreesClassifier
    from sklearn.linear_model import LogisticRegression
    from sklearn.calibration import CalibratedClassifierCV
    from lightgbm import LGBMClassifier
    from xgboost import XGBClassifier

    _dev = _gpu_device()

    lgbm = CalibratedClassifierCV(
        LGBMClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.04,
            subsample=0.8, min_child_samples=5, random_state=42,
            device=_dev, verbose=-1, class_weight='balanced',
        ),
        method='isotonic', cv=3,
    )
    xgb_model = CalibratedClassifierCV(
        XGBClassifier(
            n_estimators=300, max_depth=4, learning_rate=0.04,
            subsample=0.8, random_state=42, scale_pos_weight=scale_pos_weight,
            device=_dev, eval_metric='logloss', verbosity=0,
        ),
        method='isotonic', cv=3,
    )
    rf = CalibratedClassifierCV(
        RandomForestClassifier(
            n_estimators=300, max_depth=6, min_samples_leaf=5,
            n_jobs=-1, random_state=42,
        ),
        method='isotonic', cv=3,
    )
    et = CalibratedClassifierCV(
        ExtraTreesClassifier(
            n_estimators=300, max_depth=6, min_samples_leaf=5,
            n_jobs=-1, random_state=42,
        ),
        method='isotonic', cv=3,
    )
    lr = CalibratedClassifierCV(
        LogisticRegression(C=1.0, max_iter=1000, random_state=42),
        method='sigmoid', cv=3,
    )
    return [('lgbm', lgbm), ('xgb', xgb_model), ('rf', rf), ('et', et), ('lr', lr)]


def _fit_stack(X: pd.DataFrame, y: pd.Series, spw: float, embargo: int, n_splits: int = 5):
    """
    Fit OOF-stacked base models + meta-learner on (X, y), purging `embargo` samples
    between each train/validation fold so overlapping forward-return windows cannot
    leak across the boundary. Returns (fitted_base, meta, oof_auc, oof_acc, importances).
    Assumes X is already sorted chronologically.
    """
    from sklearn.model_selection import TimeSeriesSplit
    from sklearn.base import clone as _sklearn_clone
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    from sklearn.pipeline import Pipeline
    from sklearn.metrics import roc_auc_score

    base = _base_models(scale_pos_weight=spw)
    # Keep folds viable once the embargo gap is subtracted.
    n_eff = n_splits
    if embargo > 0:
        n_eff = max(2, min(n_splits, len(X) // max(1, embargo + 1) - 1))
    skf = TimeSeriesSplit(n_splits=n_eff, gap=embargo)

    oof     = np.zeros((len(X), len(base)))
    covered = np.zeros(len(X), dtype=bool)
    fitted  = []

    for j, (name, model) in enumerate(base):
        print(f"[Ensemble]   Training base model: {name}...")
        oof_preds = np.zeros(len(X))
        for train_idx, val_idx in skf.split(X, y):
            m_clone = _sklearn_clone(_base_models(scale_pos_weight=spw)[j][1].estimator)
            m_clone.fit(X.iloc[train_idx], y.iloc[train_idx])
            oof_preds[val_idx] = m_clone.predict_proba(X.iloc[val_idx])[:, 1]
            covered[val_idx] = True
        oof[:, j] = oof_preds
        model.fit(X, y)   # full fit (calibrated) for inference
        fitted.append((name, model))

    # Meta-learner — trained only on rows the walk-forward actually produced OOF preds for
    # (TimeSeriesSplit never validates the initial training block).
    meta = Pipeline([
        ('scaler', StandardScaler()),
        ('lr', LogisticRegression(C=0.5, max_iter=500, random_state=42)),
    ])
    yc = y[covered]
    meta.fit(oof[covered], yc)
    meta_proba = meta.predict_proba(oof[covered])[:, 1]
    auc = roc_auc_score(yc, meta_proba) if yc.nunique() > 1 else 0.5
    acc = float(((meta_proba > 0.5) == yc).mean())

    imp = None
    try:
        gb_cal = fitted[0][1]  # CalibratedClassifierCV for LGBM
        if hasattr(gb_cal, 'calibrated_classifiers_') and gb_cal.calibrated_classifiers_:
            inner = gb_cal.calibrated_classifiers_[0].estimator
            imp = getattr(inner, 'feature_importances_', None)
    except Exception:
        pass

    return fitted, meta, float(auc), acc, imp


def train_ensemble(X: pd.DataFrame, y: pd.Series, dates: pd.Series | None = None,
                   horizon_days: int = 15, min_samples: int = 30):
    from sklearn.metrics import roc_auc_score, precision_score, recall_score, f1_score

    print(f"[Ensemble] Training on {len(X)} samples  (win_rate={y.mean():.1%})")
    spw = float((y == 0).sum()) / max(1, (y == 1).sum())

    # Embargo in samples ≈ one horizon's worth of rows. Prevents overlapping forward
    # windows leaking across train/val/test boundaries (purged walk-forward).
    embargo = 0
    if dates is not None and dates.nunique() > 1:
        samples_per_day = max(1.0, len(X) / dates.nunique())
        embargo = int(min(len(X) // 10, samples_per_day * horizon_days))

    # ── Honest held-out test: last 20%, chronological, with an embargo purge gap ──
    test = {'auc': None, 'precision': None, 'recall': None, 'f1': None, 'n': 0}
    n_test = int(len(X) * 0.20)
    if n_test >= 20 and (len(X) - n_test - embargo) >= max(min_samples, 100):
        tr_end = len(X) - n_test - embargo
        fb, mt, _, _, _ = _fit_stack(X.iloc[:tr_end], y.iloc[:tr_end], spw, embargo)
        X_te, y_te = X.iloc[len(X) - n_test:], y.iloc[len(X) - n_test:]
        te_proba = mt.predict_proba(
            np.column_stack([m.predict_proba(X_te)[:, 1] for _, m in fb])
        )[:, 1]
        if y_te.nunique() > 1:
            te_pred = (te_proba > 0.5).astype(int)
            test = {
                'auc':       float(roc_auc_score(y_te, te_proba)),
                'precision': float(precision_score(y_te, te_pred, zero_division=0)),
                'recall':    float(recall_score(y_te, te_pred, zero_division=0)),
                'f1':        float(f1_score(y_te, te_pred, zero_division=0)),
                'n':         int(n_test),
            }
            print(f"[Ensemble]   HELD-OUT TEST (last {n_test}, embargo={embargo}): "
                  f"AUC={test['auc']:.4f} P={test['precision']:.3f} "
                  f"R={test['recall']:.3f} F1={test['f1']:.3f}")
    else:
        print(f"[Ensemble]   Insufficient data for a held-out test (n={len(X)}); reporting CV only.")

    # ── Production model: refit on ALL data; CV metric is the purged-OOF AUC ──
    fitted, meta, auc, acc, imp = _fit_stack(X, y, spw, embargo)
    print(f"[Ensemble]   Stacking purged-OOF AUC={auc:.4f}  Accuracy={acc:.4f}  (embargo={embargo})")

    return {
        'base_models':  fitted,
        'meta':         meta,
        'feature_names': list(X.columns),
        'feature_importances': imp.tolist() if imp is not None else None,
        'cv_auc':       float(auc),
        'cv_accuracy':  acc,
        'test_auc':     test['auc'],
        'test_precision': test['precision'],
        'test_recall':  test['recall'],
        'test_f1':      test['f1'],
        'test_samples': test['n'],
        'embargo':      embargo,
        'n_samples':    len(X),
        'trained_at':   datetime.datetime.now().isoformat(),
    }


def predict_proba_ensemble(ensemble: dict, X: pd.DataFrame) -> np.ndarray:
    base_probs = np.column_stack([
        m.predict_proba(X)[:, 1] for _, m in ensemble['base_models']
    ])
    return ensemble['meta'].predict_proba(base_probs)[:, 1]


# ── Model Registry ────────────────────────────────────────────────────────────

def register_model(conn: sqlite3.Connection, ensemble: dict) -> int:
    version = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    top_feats = []
    if ensemble.get('feature_importances') and ensemble.get('feature_names'):
        pairs = sorted(
            zip(ensemble['feature_names'], ensemble['feature_importances']),
            key=lambda x: -x[1],
        )[:15]
        top_feats = [{'feature': f, 'importance': round(i, 6)} for f, i in pairs]

    cur = conn.cursor()
    cur.execute("""
        UPDATE model_registry SET is_active = 0
        WHERE model_name = 'ensemble' AND is_active = 1
    """)
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, cv_accuracy,
             test_roc_auc, precision_score, recall_score, f1_score,
             feature_count, top_features_json, model_path, is_active, horizon_days)
        VALUES ('ensemble', ?, 'Stacking Ensemble', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 15)
    """, (
        version,
        ensemble['trained_at'],
        ensemble['n_samples'],
        ensemble['cv_auc'],
        ensemble['cv_accuracy'],
        ensemble.get('test_auc'),
        ensemble.get('test_precision'),
        ensemble.get('test_recall'),
        ensemble.get('test_f1'),
        len(ensemble['feature_names']),
        json.dumps(top_feats),
        ENSEMBLE_PATH,
    ))
    model_id = cur.lastrowid

    # Feature importance log
    if top_feats:
        for rank, ft in enumerate(top_feats, 1):
            cur.execute("""
                INSERT INTO feature_importance_log (model_id, model_name, computed_at, feature_name, importance, rank_position)
                VALUES (?, 'ensemble', ?, ?, ?, ?)
            """, (model_id, ensemble['trained_at'], ft['feature'], ft['importance'], rank))

    conn.commit()
    print(f"[Ensemble] Registered as model_id={model_id} version={version}")
    return model_id


# ── Saving / Loading ──────────────────────────────────────────────────────────

def save_ensemble(ensemble: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(ENSEMBLE_PATH, 'wb') as f:
        pickle.dump(ensemble, f, protocol=pickle.HIGHEST_PROTOCOL)
    print(f"[Ensemble] Saved to {ENSEMBLE_PATH}")


def load_ensemble() -> dict | None:
    if not os.path.exists(ENSEMBLE_PATH):
        return None
    with open(ENSEMBLE_PATH, 'rb') as f:
        return pickle.load(f)


# ── Score Pending Signals ─────────────────────────────────────────────────────

def score_pending(conn: sqlite3.Connection, ensemble: dict) -> int:
    df = load_pending_signals(conn)
    if df.empty:
        print("[Ensemble] No pending signals to score.")
        return 0

    print(f"[Ensemble] Scoring {len(df)} pending signals...")
    X = build_features(df)

    # Align columns to training feature set
    for col in ensemble['feature_names']:
        if col not in X.columns:
            X[col] = 0.0
    X = X[ensemble['feature_names']].astype(np.float32)

    probs = predict_proba_ensemble(ensemble, X)

    cur = conn.cursor()
    updated = 0
    for (_, row), prob in zip(df.iterrows(), probs):
        cur.execute(
            "UPDATE technical_signals SET win_probability = ? WHERE symbol = ? AND date = ?",
            (round(float(prob), 4), row['symbol'], row['signal_date']),
        )
        updated += 1
    conn.commit()

    # Propagate win_probability to active recommendation_log entries
    cols = [r[1] for r in conn.execute("PRAGMA table_info(recommendation_log)").fetchall()]
    if 'win_probability' in cols:
        conn.execute("""
            UPDATE recommendation_log
            SET win_probability = (
                SELECT ts.win_probability
                FROM technical_signals ts
                WHERE ts.symbol = recommendation_log.symbol
                  AND ts.date = recommendation_log.signal_date
                LIMIT 1
            )
            WHERE source = 'technical_scan'
              AND status = 'ACTIVE'
              AND signal_date >= date('now', '-14 days')
        """)
        # Deactivate entries where ML now says win < 40%
        conn.execute("""
            UPDATE recommendation_log
            SET status = 'EXPIRED'
            WHERE win_probability IS NOT NULL
              AND win_probability < 0.40
              AND status = 'ACTIVE'
              AND source = 'technical_scan'
        """)
        conn.commit()
        print("[Ensemble] Propagated win_probability to recommendation_log; low-confidence entries filtered.")

    return updated


# ── Main ──────────────────────────────────────────────────────────────────────

def run(do_train: bool = True, do_score: bool = True,
        retrain_full: bool = False, min_samples: int = 30):
    try:
        from lightgbm import LGBMClassifier  # noqa: F401 — verify dependency at startup
    except ImportError:
        print("[Ensemble] lightgbm not installed. Run: pip install lightgbm")
        sys.exit(1)

    conn = sqlite3.connect(DB_PATH)
    try:
        if do_train:
            if retrain_full or not os.path.exists(ENSEMBLE_PATH):
                print("[Ensemble] Training from scratch...")
            else:
                print("[Ensemble] Retraining (incremental — same architecture)...")

            df = load_training_data(conn)
            df = df.sort_values('signal_date').reset_index(drop=True)
            if len(df) < min_samples:
                print(f"[Ensemble] Need {min_samples} samples, have {len(df)}. Skipping train.")
                do_train = False
            else:
                X = build_features(df)
                y = df['outcome'].astype(int)
                _hz = int(pd.to_numeric(df['horizon_days'], errors='coerce').median() or 15)
                ensemble = train_ensemble(X, y, dates=df['signal_date'],
                                          horizon_days=_hz, min_samples=min_samples)
                save_ensemble(ensemble)
                register_model(conn, ensemble)

        if do_score:
            ensemble = load_ensemble()
            if ensemble is None:
                print("[Ensemble] No saved model — run with --train first.")
            else:
                n = score_pending(conn, ensemble)
                print(f"[Ensemble] Scored {n} signals.")

    finally:
        conn.close()

    print("[Ensemble] Done.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ML Ensemble Signal Confidence Scorer")
    parser.add_argument("--train",       action="store_true", help="Train ensemble model")
    parser.add_argument("--score",       action="store_true", help="Score pending signals")
    parser.add_argument("--retrain-full",action="store_true", help="Discard saved model and retrain")
    parser.add_argument("--min-samples", type=int, default=30)
    args = parser.parse_args()

    do_train = args.train or args.retrain_full or (not args.score)
    do_score = args.score or (not args.train and not args.retrain_full)

    run(do_train=do_train, do_score=do_score,
        retrain_full=args.retrain_full, min_samples=args.min_samples)
