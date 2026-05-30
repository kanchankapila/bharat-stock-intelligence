#!/usr/bin/env python3
"""
Two-layer drift detection:
  Layer 1: PSI on feature distributions (feature drift)
  Layer 2: Rolling 30-day directional accuracy (prediction drift)
Writes drift_score to dl_model_performance.
"""

import sqlite3
import json
import argparse
from datetime import datetime, timedelta
from pathlib import Path

import numpy as np
import pandas as pd

DB_PATH = Path(__file__).parent.parent.parent / "database.sqlite"

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
    con = sqlite3.connect(DB_PATH)
    try:
        df = pd.read_sql(
            "SELECT * FROM feature_store WHERE timeframe='D' ORDER BY date",
            con,
        )
    finally:
        con.close()

    numeric_cols = df.select_dtypes(include=[np.number]).columns.tolist()
    numeric_cols = [c for c in numeric_cols if not c.startswith("target_")]

    if len(df) < 60:
        return {"status": "INSUFFICIENT_DATA"}

    cutoff_idx = int(len(df) * 0.8)
    baseline   = df.iloc[:cutoff_idx]
    recent     = df.iloc[-30:] if len(df) > 30 else df.iloc[cutoff_idx:]

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

    con = sqlite3.connect(DB_PATH)
    try:
        today = datetime.today().strftime("%Y-%m-%d")
        con.execute(
            """INSERT OR REPLACE INTO dl_model_performance
               (model_name, model_version, eval_date, horizon_days, drift_score)
               VALUES (?, 'current', ?, 5, ?)""",
            (model_name, today, avg_psi),
        )
        con.commit()
    finally:
        con.close()

    print(f"[DRIFT] Feature drift: max_psi={max_psi:.3f} avg={avg_psi:.3f} "
          f"crit_frac={crit_frac:.2%} → {status}")
    return {"status": status, "max_psi": max_psi, "avg_psi": avg_psi, "crit_frac": crit_frac}


def check_accuracy_drift(model_name: str = "LSTM_TFT_ENSEMBLE", horizon: int = 5) -> dict:
    """Compare rolling 30-day accuracy vs baseline stored in dl_model_performance."""
    con = sqlite3.connect(DB_PATH)
    try:
        baseline_row = con.execute(
            """SELECT directional_accuracy FROM dl_model_performance
               WHERE model_name=? AND horizon_days=? AND retrain_triggered=0
               ORDER BY eval_date ASC LIMIT 1""",
            (model_name, horizon),
        ).fetchone()
        if not baseline_row or baseline_row[0] is None:
            return {"status": "NO_BASELINE"}

        baseline_acc = baseline_row[0]

        cutoff = (datetime.today() - timedelta(days=30)).strftime("%Y-%m-%d")
        h = int(horizon)
        rows = pd.read_sql(
            f"""SELECT prob_up_{h}d, outcome_{h}d FROM deep_learning_predictions
                WHERE model_name=? AND prediction_date>=? AND outcome_{h}d IS NOT NULL""",
            con, params=(model_name, cutoff),
        )
    finally:
        con.close()

    if len(rows) < 20:
        return {"status": "INSUFFICIENT_OUTCOMES", "n_resolved": len(rows)}

    pred_dir = (rows[f"prob_up_{h}d"] > 0.5).astype(int)
    actual   = (rows[f"outcome_{h}d"] == "WIN").astype(int)
    recent_acc = float((pred_dir == actual).mean())
    drop       = baseline_acc - recent_acc

    status = "EMERGENCY_RETRAIN" if drop > ACC_DROP else "OK"
    print(f"[DRIFT] Accuracy drift: baseline={baseline_acc:.3f} recent={recent_acc:.3f} "
          f"drop={drop:.3f} → {status}")
    return {"status": status, "baseline_acc": baseline_acc, "recent_acc": recent_acc, "drop": drop}


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
