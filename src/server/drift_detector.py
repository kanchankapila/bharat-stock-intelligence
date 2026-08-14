#!/usr/bin/env python3
"""
Two-layer drift detection:
  Layer 1: PSI on feature distributions (feature drift)
  Layer 2: Rolling 30-day directional accuracy (prediction drift)
Writes drift_score to dl_model_performance.
"""

import json
import argparse
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from db_compat import read_df, query_one, execute

PSI_WARN    = 0.20
PSI_CRIT    = 0.25
PSI_FRAC    = 0.20  # fraction of features that must breach PSI_CRIT for emergency retrain
ACC_DROP    = 0.15  # 15% drop from baseline triggers retrain


def _psi(expected: np.ndarray, actual: np.ndarray, bins: int = 10) -> float:
    """Population Stability Index between two distributions."""
    eps = 1e-6
    breakpoints = np.percentile(expected, np.linspace(0, 100, bins + 1))
    breakpoints[0]  = -np.inf
    breakpoints[-1] = np.inf

    exp_pct = np.histogram(expected, bins=breakpoints)[0] / len(expected)
    act_pct = np.histogram(actual,   bins=breakpoints)[0] / len(actual)

    exp_pct = np.clip(exp_pct, eps, None)
    act_pct = np.clip(act_pct, eps, None)

    return float(np.sum((act_pct - exp_pct) * np.log(act_pct / exp_pct)))


def check_feature_drift(model_name: str = "LSTM_TFT_ENSEMBLE") -> dict:
    """Compare recent 30-day feature distribution vs training-window baseline."""
    df = read_df("SELECT * FROM feature_store WHERE timeframe='D' ORDER BY date")

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    numeric_cols = [c for c in numeric_cols if not c.startswith("target_")]

    if len(df) < 60:
        return {"status": "INSUFFICIENT_DATA"}

    # feature_store is a long (symbol, date) panel -- ~2,400 rows per date -- so slicing
    # by ROW count (the old df.iloc[-30:]) grabbed the last 30 symbols of a single date,
    # not a 30-day window. Any market-wide column broadcast identically to every symbol
    # on a date (fii_10d_net, dxy, nifty_vix, ...) then had near-zero variance in "recent"
    # against a real multi-date baseline, pinning PSI far above PSI_CRIT every run
    # regardless of actual drift. Slice by distinct DATE instead.
    dates      = np.sort(df["date"].unique())
    cutoff_idx = int(len(dates) * 0.8)
    recent_dates = dates[-30:] if len(dates) > 30 else dates[cutoff_idx:]
    baseline   = df[df["date"].isin(dates[:cutoff_idx])]
    recent     = df[df["date"].isin(recent_dates)]

    psi_scores = {}
    for col in numeric_cols:
        b = baseline[col].dropna().values
        r = recent[col].dropna().values
        if len(b) < 10 or len(r) < 5:
            continue
        psi_scores[col] = _psi(b, r)

    if not psi_scores:
        return {"status": "NO_FEATURES"}

    values    = list(psi_scores.values())
    crit_frac = sum(1 for v in values if v > PSI_CRIT) / len(values)
    max_psi   = max(values)
    avg_psi   = float(np.mean(values))

    status = "OK"
    if crit_frac > PSI_FRAC:
        status = "EMERGENCY_RETRAIN"
    elif max_psi > PSI_WARN:
        status = "WARNING"

    today = datetime.today().strftime("%Y-%m-%d")
    execute(
        """INSERT INTO dl_model_performance
           (model_name, model_version, eval_date, horizon_days, drift_score)
           VALUES (?, 'current', ?, 5, ?)
           ON CONFLICT(model_name, eval_date, horizon_days) DO UPDATE SET
             model_version=excluded.model_version, drift_score=excluded.drift_score""",
        (model_name, today, avg_psi),
    )

    print(f"[DRIFT] Feature drift: max_psi={max_psi:.3f} avg={avg_psi:.3f} "
          f"crit_frac={crit_frac:.2%} -> {status}")
    return {"status": status, "max_psi": max_psi, "avg_psi": avg_psi, "crit_frac": crit_frac}


def check_accuracy_drift(model_name: str = "LSTM_TFT_ENSEMBLE", horizon: int = 5) -> dict:
    """Compare rolling 30-day accuracy vs baseline stored in dl_model_performance."""
    baseline_row = query_one(
        """SELECT directional_accuracy FROM dl_model_performance
           WHERE model_name=? AND horizon_days=? AND retrain_triggered=0
           ORDER BY eval_date ASC LIMIT 1""",
        (model_name, horizon),
    )
    if not baseline_row or baseline_row[0] is None:
        return {"status": "NO_BASELINE"}

    baseline_acc = baseline_row[0]

    cutoff = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")
    h = int(horizon)
    rows = read_df(
        f"""SELECT prob_up_{h}d, outcome_{h}d FROM deep_learning_predictions
            WHERE model_name=? AND prediction_date>=? AND outcome_{h}d IS NOT NULL""",
        (model_name, cutoff),
    )

    if len(rows) < 20:
        return {"status": "INSUFFICIENT_OUTCOMES", "n_resolved": len(rows)}

    pred_dir = (rows[f"prob_up_{h}d"] > 0.5).astype(int)
    actual   = (rows[f"outcome_{h}d"] == "WIN").astype(int)
    recent_acc = float((pred_dir == actual).mean())
    drop       = baseline_acc - recent_acc

    status = "EMERGENCY_RETRAIN" if drop > ACC_DROP else "OK"
    print(f"[DRIFT] Accuracy drift: baseline={baseline_acc:.3f} recent={recent_acc:.3f} "
          f"drop={drop:.3f} -> {status}")
    return {"status": status, "baseline_acc": baseline_acc, "recent_acc": recent_acc, "drop": drop}


def get_drift_multiplier() -> float:
    """Returns confidence multiplier (0.85–1.0) based on most recent drift score.
    1.0 = no drift, 0.85 = critical drift (15% haircut on win_probability).
    """
    try:
        row = query_one(
            "SELECT drift_score FROM dl_model_performance ORDER BY eval_date DESC LIMIT 1",
        )
        if not row:
            return 1.0
        ds = float(row[0] if isinstance(row, (list, tuple)) else row['drift_score'])
        if ds > PSI_CRIT:
            return 0.85
        if ds > PSI_WARN:
            return 0.93
        return 1.0
    except Exception as e:
        print(f"[DRIFT] get_drift_multiplier failed, defaulting to 1.0 (no haircut applied — drift status unknown): {e}")
        return 1.0


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="LSTM_TFT_ENSEMBLE")
    args = parser.parse_args()

    r1 = check_feature_drift(args.model)
    r2 = check_accuracy_drift(args.model)

    if r1.get("status") == "EMERGENCY_RETRAIN" or r2.get("status") == "EMERGENCY_RETRAIN":
        print("[DRIFT] EMERGENCY_RETRAIN required")
        exit(1)  # Non-zero exit signals BullMQ worker to queue retrain
    print("[DRIFT] OK")
