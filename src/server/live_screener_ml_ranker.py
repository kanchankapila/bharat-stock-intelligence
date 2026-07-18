#!/usr/bin/env python3
"""
Live Screener ML Ranker
========================
The existing live_screener_optimizer.py finds good filter COMBINATIONS via a shallow
decision tree (max_depth=3) — useful for humans picking a strategy, but coarse: it can't
weigh a stock's own change_per/volume at match time, and it only ever activates the
newest tree unconditionally (no protection against a retrain that's actually worse).

This engine trains a single gradient-boosted classifier over the same NiftyTrader
filter-match data to predict P(same-day win) per (date, symbol), gated behind a
promotion check so a retrain that scores worse than the currently-active model never
replaces it (the underlying model_registry-less version of the ensemble.pkl promotion
bar in ml_ensemble.py).

Run:
    python live_screener_ml_ranker.py --train   # fit + honest held-out AUC, promote or reject
    python live_screener_ml_ranker.py --score   # write win_probability for the latest collection cycle
"""
import argparse
import datetime
import json
import os
import pickle

import numpy as np
import pandas as pd

from db_compat import execute, executemany, query_one, read_df

MODEL_PATH = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ml_models", "live_screener_intraday_clf.pkl")
CANDIDATE_PATH = MODEL_PATH.replace(".pkl", "_candidate.pkl")

MIN_SAMPLES = 150          # minimum resolved (date, symbol) rows before training at all
MIN_DATES = 10             # minimum distinct trading days for an honest chronological split
TEST_FRAC = 0.2            # most recent 20% of dates held out, untouched by CV
PROMOTION_MARGIN = 0.01    # new held-out AUC must beat the active model's by this much


# ── feature construction ──────────────────────────────────────────────────────

def _load_training_frame() -> pd.DataFrame:
    return read_df("""
        SELECT o.symbol, o.filter_key, o.appeared_at, o.return_intraday,
               a.change_per, a.volume
        FROM live_screener_outcomes o
        JOIN live_screener_appearances a ON a.id = o.appearance_id
        WHERE o.return_intraday IS NOT NULL
    """)


def _build_matrix(df: pd.DataFrame):
    """One row per (appeared_at, symbol): binary filter-match columns + mean change_per/
    log-volume at match time + the mean same-day return across whichever filters it matched
    that day. Mirrors live_screener_optimizer.py's pivot, plus the two appearance-level
    features that pivot doesn't carry (change_per, volume)."""
    agg = df.groupby(["appeared_at", "symbol"]).agg(
        return_intraday=("return_intraday", "mean"),
        change_per=("change_per", "mean"),
        volume=("volume", "mean"),
    ).reset_index()

    pivot = df.pivot_table(
        index=["appeared_at", "symbol"], columns="filter_key", aggfunc="size", fill_value=0
    ).clip(upper=1).reset_index()
    filter_cols = [c for c in pivot.columns if c not in ("appeared_at", "symbol")]

    matrix = pd.merge(pivot, agg, on=["appeared_at", "symbol"])
    matrix["log_volume"] = np.log1p(matrix["volume"].clip(lower=0).fillna(0))
    matrix["change_per"] = matrix["change_per"].fillna(0.0)
    feature_cols = filter_cols + ["change_per", "log_volume"]
    return matrix.sort_values("appeared_at").reset_index(drop=True), feature_cols


def _make_model(spw: float):
    from lightgbm import LGBMClassifier
    return LGBMClassifier(
        n_estimators=150, learning_rate=0.05, num_leaves=15, max_depth=4,
        subsample=0.8, subsample_freq=1, colsample_bytree=0.8,
        min_child_samples=20, scale_pos_weight=spw, n_jobs=-1, verbose=-1,
    )


# ── training ───────────────────────────────────────────────────────────────────

def _load_active_metrics() -> dict | None:
    if not os.path.exists(MODEL_PATH):
        return None
    try:
        with open(MODEL_PATH, "rb") as f:
            art = pickle.load(f)
        return {"test_auc": art.get("test_auc"), "trained_at": art.get("trained_at")}
    except Exception:
        return None


def train():
    from sklearn.metrics import accuracy_score, roc_auc_score
    from sklearn.model_selection import TimeSeriesSplit

    df = _load_training_frame()
    if df.empty:
        print("[LiveScreenerMLRanker] No resolved return_intraday data yet — run live_screener_resolver.py first.")
        return
    matrix, feature_cols = _build_matrix(df)
    if len(matrix) < MIN_SAMPLES:
        print(f"[LiveScreenerMLRanker] Only {len(matrix)} resolved (date,symbol) samples "
              f"(need >= {MIN_SAMPLES}) — skipping.")
        return

    dates = np.array(sorted(matrix["appeared_at"].unique()))
    if len(dates) < MIN_DATES:
        print(f"[LiveScreenerMLRanker] Only {len(dates)} distinct trading days "
              f"(need >= {MIN_DATES} for an honest time-based split) — skipping.")
        return

    y = (matrix["return_intraday"] > 0).astype(int)
    X = matrix[feature_cols].fillna(0.0)
    base_rate = float(y.mean())
    spw = (1 - base_rate) / max(base_rate, 1e-6)

    # Held-out test window: the most recent TEST_FRAC of DATES (not rows — a cross-sectional
    # day can carry many symbols, so a row-based split can leak most of a boundary day into
    # both sides). CV below only ever touches the training window.
    n_test_dates = max(1, int(len(dates) * TEST_FRAC))
    test_dates = set(dates[-n_test_dates:])
    test_mask = matrix["appeared_at"].isin(test_dates).values
    train_mask = ~test_mask

    X_train, y_train = X[train_mask], y[train_mask]
    X_test, y_test = X[test_mask], y[test_mask]
    if y_train.nunique() < 2 or y_test.nunique() < 2:
        print("[LiveScreenerMLRanker] Train/test split has only one class on one side "
              "(all wins or all losses) — skipping until there's a more balanced sample.")
        return

    # Purged-in-time OOF AUC over the training window only (TimeSeriesSplit never trains on
    # rows chronologically after what it validates on).
    n_splits = min(5, max(2, len(dates) // (MIN_DATES // 2)))
    tscv = TimeSeriesSplit(n_splits=n_splits)
    cv_aucs = []
    for tr_idx, val_idx in tscv.split(X_train):
        y_tr, y_val = y_train.iloc[tr_idx], y_train.iloc[val_idx]
        if y_tr.nunique() < 2 or y_val.nunique() < 2:
            continue
        m = _make_model(spw)
        m.fit(X_train.iloc[tr_idx], y_tr)
        cv_aucs.append(roc_auc_score(y_val, m.predict_proba(X_train.iloc[val_idx])[:, 1]))
    cv_auc = float(np.mean(cv_aucs)) if cv_aucs else None

    # Final model: fit on the full training window, scored ONCE against the untouched test
    # window — the number that answers "does it generalize", not "how was it tuned".
    model = _make_model(spw)
    model.fit(X_train, y_train)
    test_proba = model.predict_proba(X_test)[:, 1]
    test_auc = float(roc_auc_score(y_test, test_proba))
    test_acc = float(accuracy_score(y_test, (test_proba > 0.5).astype(int)))

    print(f"[LiveScreenerMLRanker] n={len(matrix)} base_rate={base_rate:.3f} "
          f"cv_auc={cv_auc if cv_auc is None else round(cv_auc, 4)} test_auc={test_auc:.4f} "
          f"test_acc={test_acc:.4f} train_rows={len(X_train)} test_rows={len(X_test)} "
          f"dates={len(dates)}")

    baseline = _load_active_metrics()
    promote = (
        baseline is None or baseline.get("test_auc") is None
        or test_auc >= baseline["test_auc"] + PROMOTION_MARGIN
    )

    # Refit on ALL data (train + test windows) for the artifact that actually goes live --
    # matches the OOF/held-out probe above, same as breakout_classifier.py's convention.
    final_model = _make_model(spw)
    final_model.fit(X, y)
    artifact = {
        "model": final_model,
        "feature_names": feature_cols,
        "trained_at": datetime.datetime.now().isoformat(),
        "cv_auc": cv_auc,
        "test_auc": test_auc,
        "test_acc": test_acc,
        "base_rate": base_rate,
        "n_samples": len(matrix),
    }
    os.makedirs(os.path.dirname(MODEL_PATH), exist_ok=True)

    if promote:
        with open(MODEL_PATH, "wb") as f:
            pickle.dump(artifact, f)
        execute("""
            INSERT INTO app_settings (key, value, "updatedAt")
            VALUES ('live_screener_ml_model_status', ?, ?)
            ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"
        """, (
            json.dumps({
                "trained_at": artifact["trained_at"], "cv_auc": cv_auc, "test_auc": test_auc,
                "test_acc": test_acc, "base_rate": base_rate, "n_samples": len(matrix),
                "n_features": len(feature_cols),
            }),
            datetime.datetime.now().isoformat(),
        ))
        print(f"[LiveScreenerMLRanker] Model ACTIVATED (test_auc={test_auc:.4f}"
              + (f", beat baseline {baseline['test_auc']:.4f})" if baseline and baseline.get('test_auc') is not None else ", no prior model)"))
    else:
        with open(CANDIDATE_PATH, "wb") as f:
            pickle.dump(artifact, f)
        print(f"[LiveScreenerMLRanker] Candidate REJECTED: test_auc={test_auc:.4f} did not "
              f"beat active model's {baseline['test_auc']:.4f} + {PROMOTION_MARGIN} margin. "
              f"Saved to {CANDIDATE_PATH} for inspection; active model unchanged.")


# ── scoring ──────────────────────────────────────────────────────────────────

def score():
    if not os.path.exists(MODEL_PATH):
        print("[LiveScreenerMLRanker] No active model yet — run --train first.")
        return
    with open(MODEL_PATH, "rb") as f:
        art = pickle.load(f)
    model, feature_names = art["model"], art["feature_names"]

    run_row = query_one("SELECT MAX(id) FROM live_screener_runs WHERE status IN ('SUCCESS','PARTIAL')")
    run_id = run_row[0] if run_row else None
    if not run_id:
        print("[LiveScreenerMLRanker] No live screener run to score yet.")
        return

    appearances = read_df(
        "SELECT symbol, filter_key, change_per, volume FROM live_screener_appearances WHERE run_id = ?",
        (run_id,),
    )
    if appearances.empty:
        print(f"[LiveScreenerMLRanker] Run {run_id} has no appearances to score.")
        return

    agg = appearances.groupby("symbol").agg(
        change_per=("change_per", "mean"), volume=("volume", "mean")
    )
    flags = pd.crosstab(appearances["symbol"], appearances["filter_key"]).clip(upper=1)
    matrix = agg.join(flags, how="left").fillna(0.0)
    matrix["log_volume"] = np.log1p(matrix["volume"].clip(lower=0))

    for f in feature_names:
        if f not in matrix.columns:
            matrix[f] = 0.0
    X = matrix[feature_names]

    proba = model.predict_proba(X)[:, 1]
    now = datetime.datetime.now().isoformat()
    version = art.get("trained_at", "unknown")
    rows = [(run_id, sym, float(round(p, 4)), version, now) for sym, p in zip(matrix.index, proba)]

    executemany("""
        INSERT INTO live_screener_ml_scores (run_id, symbol, win_probability, model_version, computed_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(run_id, symbol) DO UPDATE SET
            win_probability = excluded.win_probability,
            model_version = excluded.model_version,
            computed_at = excluded.computed_at
    """, rows)
    print(f"[LiveScreenerMLRanker] Scored {len(rows)} symbols for run_id={run_id}.")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="ML win-probability ranker for the NiftyTrader live screener")
    parser.add_argument("--train", action="store_true", help="Fit + report held-out AUC, promote or reject")
    parser.add_argument("--score", action="store_true", help="Write win_probability for the latest collection cycle")
    args = parser.parse_args()
    if args.train:
        train()
    if args.score:
        score()
    if not (args.train or args.score):
        parser.print_help()
