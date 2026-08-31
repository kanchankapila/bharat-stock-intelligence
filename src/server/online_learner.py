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
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

import copy, os, sys, json, datetime, argparse, pickle, warnings
warnings.filterwarnings('ignore')

import numpy as np
import pandas as pd

from db_compat import connect, read_df, ConnWrapper

# Script-relative, not os.getcwd()-relative -- see ml_ensemble.py's MODELS_DIR comment.
MODELS_DIR     = os.path.join(os.path.dirname(os.path.abspath(__file__)), 'ml_models')
ONLINE_PATH    = os.path.join(MODELS_DIR, 'online_sgd.pkl')
ENSEMBLE_PATH  = os.path.join(MODELS_DIR, 'ensemble.pkl')

def build_features(df: pd.DataFrame) -> np.ndarray:
    """Delegate to ml_ensemble's canonical build_features so the SGD and the
    stacking ensemble always operate on an identical feature vector.

    The import is deferred so loading online_learner does not pull in lightgbm /
    xgboost at startup — they are only needed when ml_ensemble actually trains.
    Returns a numpy float32 array (SGD / StandardScaler do not need DataFrame).
    """
    from ml_ensemble import build_features as _ens_build  # type: ignore
    return _ens_build(df).astype(np.float32).values


# ── Data Loading ─────────────────────────────────────────────────────────────

def load_recent_outcomes(window_days: int, min_new: int) -> pd.DataFrame:
    """Load resolved outcomes joined to the same rich feature columns as
    ml_ensemble.load_training_data so build_features() receives every column
    it expects (missing ones default safely inside the ensemble's num() helper).
    """
    # 2026-08-30: was a hand-rolled ~30-column SELECT while build_features() (called on this
    # DataFrame two calls downstream) reads 304 raw columns -- the other ~90% silently defaulted
    # to constants via num()'s fallback, same bug class as cs_ranker.py/exit_policy.py (see
    # ml-model-bugs.md). Worse here than in those two: load_pending_signals() below already
    # delegates to ml_ensemble's canonical (full-width) query, so the SGD/PassiveAggressive
    # models were trained on a narrow constant-padded vector but SCORED on the real wide one --
    # a train/serve feature-distribution skew, not just a narrower model. Fixed by sharing the
    # same full_feature_train_sql() cs_ranker.py/exit_policy.py now use.
    from ml_ensemble import full_feature_train_sql  # deferred, see build_features() above
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=window_days)).strftime('%Y-%m-%d')
    select_cols, joins = full_feature_train_sql('so', 'signal_date')
    q = f"""
        SELECT so.symbol, so.signal_date, so.horizon_days, so.outcome,
               so.signal_score, so.signals_json,
               {select_cols}
        FROM signal_outcomes so
        {joins}
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL')
          AND so.signal_date >= ?
          AND so.signal_source = 'technical'
        ORDER BY so.signal_date ASC
    """
    df = read_df(q, (cutoff,))
    return df


def load_pending_signals() -> pd.DataFrame:
    """Mirror ml_ensemble.load_pending_signals exactly so the feature vector
    is identical at predict time to what build_features() produces at train time.
    """
    from ml_ensemble import load_pending_signals as _ens_load  # type: ignore
    return _ens_load()


# ── Online Model ──────────────────────────────────────────────────────────────

def _new_sgd_state() -> dict:
    from sklearn.linear_model import SGDClassifier
    from sklearn.preprocessing import StandardScaler
    return {
        'model':          SGDClassifier(loss='log_loss', penalty='l2', alpha=1e-4,
                                        max_iter=1, warm_start=True, random_state=42),
        'scaler':         StandardScaler(),
        'scaler_fitted':  False,
        'n_samples_seen': 0,
        'last_updated':   None,
    }


def load_or_init_sgd(expected_n_features: int | None = None) -> dict:
    if os.path.exists(ONLINE_PATH):
        try:
            with open(ONLINE_PATH, 'rb') as f:
                state = pickle.load(f)
            # Detect feature-count mismatch (e.g. after build_features was expanded).
            # n_features_in_ is set by sklearn after the first partial_fit.
            if expected_n_features is not None and state.get('scaler_fitted'):
                fitted_n = getattr(state['scaler'], 'n_features_in_', None)
                if fitted_n is not None and fitted_n != expected_n_features:
                    print(
                        f"[OnlineLearner] Feature count changed "
                        f"({fitted_n} → {expected_n_features}) — resetting SGD."
                    )
                    os.remove(ONLINE_PATH)
                    return _new_sgd_state()
            return state
        except Exception as e:
            print(f"[OnlineLearner] Could not load SGD state ({e}) — reinitialising.", file=sys.stderr)
    return _new_sgd_state()


def save_sgd(state: dict):
    os.makedirs(MODELS_DIR, exist_ok=True)
    with open(ONLINE_PATH, 'wb') as f:
        pickle.dump(state, f, protocol=pickle.HIGHEST_PROTOCOL)


def partial_fit_sgd(state: dict, X: np.ndarray, y: np.ndarray) -> dict:
    from sklearn.linear_model import SGDClassifier

    from sklearn.utils.class_weight import compute_sample_weight
    classes = np.array([0, 1])
    if not state['scaler_fitted']:
        state['scaler'].fit(X)
        state['scaler_fitted'] = True
    Xs = state['scaler'].transform(X)
    sample_weights = compute_sample_weight('balanced', y)

    state['model'].partial_fit(Xs, y, classes=classes, sample_weight=sample_weights)
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

# An incremental update that regresses cv_auc below the last active row's by more than this
# is logged but NOT marked active -- the SGD state itself (state['model']/state['scaler'])
# has already absorbed the new batch via partial_fit regardless (online learning has no
# clean "reject this batch" rollback short of a full snapshot mechanism, out of scope here),
# but model_registry must not claim a regressed update is the trustworthy active state.
ONLINE_REGRESSION_TOLERANCE = 0.02


def register_update(conn: ConnWrapper, state: dict, n_new: int, cv_auc: float) -> bool:
    """Registers this incremental update in model_registry. Returns whether it was marked
    active -- the caller uses this to decide whether to persist the post-update SGD state to
    disk or revert to its own pre-update snapshot (see run()'s save_sgd call).

    Promotion gate (Finding #17, 2026-07-28 full-stack audit): this used to insert every
    update as is_active=1 with no comparison to pre-update state and no deactivation of
    prior rows -- model_registry could accumulate multiple 'active' online_sgd rows, and a
    regressed update was indistinguishable from a good one to anything reading is_active.
    Deactivate the previous active row, and only mark this one active if cv_auc didn't
    regress beyond ONLINE_REGRESSION_TOLERANCE versus it.

    Fixed 2026-08-15 (recurring-bugs.md, "the live online_sgd.pkl is never withheld even when
    cv_auc regresses"): partial_fit mutates the live SGD state in place with no undo, so this
    function alone can't prevent a bad batch from being absorbed into the in-memory state --
    but the ON-DISK file is a different question. run() now snapshots state before partial_fit
    and only writes the post-update state to disk if this returns True, otherwise it re-persists
    the pre-update snapshot -- so a regression this function correctly refuses to mark active no
    longer survives into the next process that loads online_sgd.pkl either.
    """
    baseline_auc = None
    try:
        row = conn.execute(
            "SELECT cv_roc_auc FROM model_registry "
            "WHERE model_name = 'online_sgd' AND is_active = 1 ORDER BY id DESC LIMIT 1"
        ).fetchone()
        if row and row[0] is not None:
            baseline_auc = float(row[0])
    except Exception:
        pass

    is_active = 1 if (baseline_auc is None or cv_auc >= baseline_auc - ONLINE_REGRESSION_TOLERANCE) else 0
    notes = f"Incremental update — {n_new} new outcomes"
    if not is_active:
        notes += f" (REGRESSED: cv_auc={cv_auc:.4f} vs active baseline={baseline_auc:.4f} — not marked active)"
        print(f"[OnlineLearner] WARNING: cv_auc regressed from {baseline_auc:.4f} to {cv_auc:.4f} "
              f"(beyond {ONLINE_REGRESSION_TOLERANCE} tolerance) — this update logged but NOT marked active.")

    version = datetime.datetime.now().strftime('%Y%m%d_%H%M%S')
    cur = conn.cursor()
    cur.execute("UPDATE model_registry SET is_active = 0 WHERE model_name = 'online_sgd' AND is_active = 1")
    cur.execute("""
        INSERT INTO model_registry
            (model_name, model_version, model_type, trained_at,
             training_samples, cv_roc_auc, is_active, horizon_days, notes)
        VALUES ('online_sgd', ?, 'OnlineSGD', ?, ?, ?, ?, 15, ?)
    """, (
        version,
        state['last_updated'],
        state['n_samples_seen'],
        round(cv_auc, 4),
        is_active,
        notes,
    ))
    conn.commit()
    return bool(is_active)


# ── Score pending signals ─────────────────────────────────────────────────────

def _compute_blend_weights(ensemble_path: str) -> tuple[float, float]:
    """Return (sgd_weight, ens_weight) based on ensemble freshness."""
    if not os.path.exists(ensemble_path):
        return 1.0, 0.0
    age_days = (datetime.datetime.now().timestamp() - os.path.getmtime(ensemble_path)) / 86400
    if age_days > 14:
        return 0.75, 0.25
    if age_days > 5:
        return 0.60, 0.40
    return 0.40, 0.60


def score_pending_with_ensemble_blend(
    conn: ConnWrapper,
    sgd_state: dict,
    ensemble: dict | None,
    df: pd.DataFrame,
) -> int:
    """Blend online SGD (40%) + ensemble (60%) if ensemble is available."""
    # build_features() now delegates to ml_ensemble.build_features, so X_named
    # (DataFrame) and X (numpy) share the same column layout — no realignment needed.
    from ml_ensemble import build_features as _ens_build, predict_proba_ensemble  # type: ignore
    X_named = _ens_build(df)
    X = X_named.astype(np.float32).values

    sgd_probs = predict_sgd(sgd_state, X)

    if ensemble:
        try:
            for col in ensemble.get('feature_names', []):
                if col not in X_named.columns:
                    X_named[col] = 0.0
            X_ens = X_named[ensemble['feature_names']].astype(np.float32)
            ens_probs = predict_proba_ensemble(ensemble, X_ens)
        except Exception:
            ens_probs = sgd_probs
        sgd_w, ens_w = _compute_blend_weights(ENSEMBLE_PATH)
        probs = sgd_w * sgd_probs + ens_w * ens_probs
        print(f"[OnlineLearner] Blend: SGD={sgd_w:.2f} ENS={ens_w:.2f}")
    else:
        probs = sgd_probs

    cur = conn.cursor()
    # Stamp win_probability_scored_at here too (migration 1787050000000) -- this writer runs
    # before ml_ensemble.py's do_score pass in the daily job chain (queues.ts) and fills
    # win_probability for the whole universe, so do_score's own `WHERE win_probability IS
    # NULL` candidate query finds nothing left to score and its stamp never fires. Confirmed
    # live: win_probability_scored_at was 0% populated on 7 of the last 9 trading days.
    cur.executemany(
        "UPDATE technical_signals SET win_probability = ?, win_probability_scored_at = CURRENT_TIMESTAMP "
        "WHERE symbol = ? AND date = ?",
        [(round(float(prob), 4), row['symbol'], row['signal_date'])
         for (_, row), prob in zip(df.iterrows(), probs)],
    )
    updated = len(df)
    conn.commit()
    return updated


def _embargoed_train_end(n_rows: int, n_dates: int, med_horizon: int, val_start: int) -> int:
    """Finding #21 (2026-07-28 audit): row-count estimate of how many training rows near the
    val_start boundary to drop so their own forward-return horizon can't still reach into the
    val split (adapted from ml_ensemble.py's date-based embargo — horizon_days varies per row
    here rather than being fixed, so this uses the median horizon as a representative gap).
    """
    samples_per_day = max(1.0, n_rows / max(1, n_dates))
    embargo = int(min(samples_per_day * med_horizon, n_rows // 10))
    return max(5, val_start - embargo)


# ── Main ──────────────────────────────────────────────────────────────────────

def run(window_days: int = 180, min_new: int = 5, dry_run: bool = False):
    try:
        from sklearn.linear_model import SGDClassifier
    except ImportError:
        print("[OnlineLearner] scikit-learn not installed.", file=sys.stderr)
        sys.exit(1)

    print(f"[OnlineLearner] Starting at {datetime.datetime.now()}")
    conn = connect()

    try:
        df = load_recent_outcomes(window_days, min_new)
        print(f"[OnlineLearner] {len(df)} recent outcomes in last {window_days} days")

        if len(df) < min_new:
            print(f"[OnlineLearner] Need {min_new} new outcomes — skipping update.")
            return

        # NEUTRAL is inconclusive — exclude it rather than silently mapping to LOSS (=0)
        df = df[df['outcome'] != 'NEUTRAL'].reset_index(drop=True)
        if len(df) < min_new:
            print(f"[OnlineLearner] Only {len(df)} non-neutral outcomes — skipping update.")
            return
        y  = (df['outcome'] == 'WIN').astype(int).values
        X  = build_features(df)

        # Load existing SGD state; pass feature count so a stale pkl is reset
        # automatically rather than crashing on the first partial_fit call.
        state = load_or_init_sgd(expected_n_features=X.shape[1])

        # Evaluate on last 20% before updating (rough held-out estimate)
        split = max(int(len(X) * 0.8), 5)
        # Finding #21 (2026-07-28 audit): this val_AUC now gates register_update()'s is_active
        # decision (Finding #17's promotion-gate fix) so it's no longer purely informational —
        # a plain positional cut with zero gap for the outcome horizon leaks forward-window
        # overlap across the boundary. Embargo the rows whose own horizon could still reach
        # into the val split, mirroring ml_ensemble.py's date-based embargo.
        med_horizon = int(pd.to_numeric(df['horizon_days'], errors='coerce').median() or 15)
        n_dates = df['signal_date'].nunique()
        train_end = _embargoed_train_end(len(X), n_dates, med_horizon, split)
        Xtrain, Xval = X[:train_end], X[split:]
        ytrain, yval = y[:train_end], y[split:]

        if dry_run:
            print("[OnlineLearner] Dry-run: skipping update and scoring.")
            return

        # Snapshot before partial_fit mutates state in place (no undo exists for online
        # learning otherwise) -- restored below if register_update rejects this batch, so a
        # regression is not persisted to disk even though it can't be un-absorbed in memory.
        pre_update_state = copy.deepcopy(state)
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
        is_active = register_update(conn, state, len(df), cv_auc)
        # save_sgd used to run unconditionally BEFORE register_update, so a regressed batch's
        # weights were persisted to disk even when model_registry correctly refused to mark it
        # active -- the on-disk file and the registry's "what's live" claim could disagree.
        # Persist the pre-update snapshot instead when rejected.
        save_sgd(state if is_active else pre_update_state)
        if not is_active:
            print("[OnlineLearner] Regressed update NOT persisted to disk — reverted to the pre-update SGD state.")

        try:
            from signal_type_priors import update_priors_from_outcomes
            update_priors_from_outcomes(df[['signals_json', 'outcome']])
            print(f"[OnlineLearner] Signal-type priors updated.")
        except Exception as e:
            print(f"[OnlineLearner] Prior update skipped: {e}", file=sys.stderr)

        # Load ensemble for blended scoring
        ensemble = None
        if os.path.exists(ENSEMBLE_PATH):
            with open(ENSEMBLE_PATH, 'rb') as f:
                ensemble = pickle.load(f)

        pending = load_pending_signals()
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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
