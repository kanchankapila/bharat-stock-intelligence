#!/usr/bin/env python3
"""
Three-layer drift detection:
  Layer 1: PSI on feature distributions (feature drift)
  Layer 2: Rolling 30-day directional accuracy (prediction drift)
  Layer 3: Held-out ROC-AUC vs the promotion bar (from persisted training metrics)
Writes drift_score / directional_accuracy / roc_auc to dl_model_performance.

KNOWN LIMITATION -- the PSI thresholds below are a measured point-in-time calibration, not a
self-maintaining one. They were derived from this panel's own null distribution on 2026-08-15
(replacing the credit-scoring convention 0.25/0.20, which sat below this data's noise floor and
made the detector fire EMERGENCY_RETRAIN at 16 of 16 historical evaluation points -- 100%, i.e.
zero information, while applying a permanent 0.85x haircut to every stock's win_probability).
Measured values beat borrowed ones, but they are still a snapshot: as feature_store grows,
gains/loses columns, or the market re-rates, these will drift out of date exactly the way 0.25
did. They are overridable from `app_settings` so retuning does not require a code change.

The correct end state is self-calibration: threshold each run against the empirical distribution
of this detector's OWN past runs (`dl_model_performance.drift_score` is already persisted every
run, so the data is free) and flag when a run is an outlier against that history. Two real
blockers, neither hand-waveable:
  1. The stored history is methodology-contaminated -- rows written before the 2026-08-14
     row-vs-date slice fix and this 2026-08-15 recalibration carry values (2.7-3.3) that are
     not comparable to current ones (0.53-0.65). Self-calibrating off them today would inherit
     the very bug that was just fixed. This needs a methodology-version column so a change
     invalidates prior rows, plus enough clean runs to accumulate.
  2. A fully adaptive threshold normalises slow, persistent drift -- the boiling-frog failure.
     Any rolling baseline needs an absolute floor so genuine long-run drift still surfaces.
Until both are handled, a measured default with a documented derivation is the honest option;
inventing a bespoke adaptive statistic to ship into live scoring is not.
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

import json
import math
import argparse
from datetime import datetime, timedelta

import numpy as np
import pandas as pd

from db_compat import read_df, query_one, execute
import sys

# ── PSI thresholds, calibrated from THIS panel's measured null (2026-08-15) ────────────────
# The previous values (PSI_WARN=0.20, PSI_CRIT=0.25) are the credit-scoring convention, which
# assumes features are slow-moving demographics. feature_store's columns are z-scored financial
# series with volatility clustering, where two windows of the SAME calm market routinely differ
# by far more than 0.25 -- so the alarm level sat below this data's own noise floor.
#
# Measured, not assumed (scratchpad replay over the real panel, 402 dates / 62 features,
# training-vs-serving windows evaluated at 16 historical points spanning 14 months):
#   * The detector fired EMERGENCY_RETRAIN at 16 of 16 evaluation points -- 100%, in every
#     market condition on record. It had NEVER produced a negative result, so its output
#     carried no information at all; `get_drift_multiplier`'s 0.85x haircut on win_probability
#     was in practice an unconditional constant nobody chose.
#   * Per-feature PSI null distribution (n=1,178 feature x evaluation pairs):
#     p50=0.526  p75=1.250  p90=2.712  p95=3.595  p99=6.248. Under PSI_CRIT=0.25, 66.8% of
#     features "breach" when nothing is wrong -- against a PSI_FRAC of 20%.
# PSI_CRIT is set at the measured p95 so ~5% of features breach under normal conditions, which
# restores PSI_FRAC=0.20's intended meaning: fire at ~4x the noise floor. PSI_WARN = p90.
#
# These are DEFAULTS, not fixed constants: each is overridable from `app_settings` (same
# pattern as edge_adjustment_enabled / intraday_learned_weights) via _threshold() below, so
# recalibration is a settings update, not a code change and redeploy. They are still a
# point-in-time measurement and WILL go stale as the panel grows and the feature set changes --
# see this module's docstring for the self-calibrating design that would remove them entirely,
# and why it isn't in place yet.
PSI_WARN    = 2.70   # measured p90 of the per-feature null
PSI_CRIT    = 3.60   # measured p95 of the per-feature null
PSI_FRAC    = 0.20   # fraction of features that must breach PSI_CRIT for emergency retrain

# get_drift_multiplier thresholds `drift_score`, which is avg_psi (the MEAN across features) --
# a different statistic on a different scale from the per-feature PSI the constants above
# describe. Reusing PSI_CRIT/PSI_WARN for both conflated the two: avg_psi's own measured null
# never fell below 0.647 across all 16 evaluation points (range 0.647-1.477), so `avg_psi >
# PSI_CRIT(0.25)` was true on every run ever made, pinning the haircut permanently on. These are
# calibrated to avg_psi's own null (p95 ~1.45), so a haircut now means something happened.
DRIFT_AVG_WARN = 1.20
DRIFT_AVG_CRIT = 1.50

ACC_DROP    = 0.15  # 15% drop from baseline triggers retrain


def _threshold(key: str, default: float) -> float:
    """Read a drift threshold from app_settings, falling back to the measured default.

    Deliberately fail-open to `default`: a missing/garbage settings row must not silently
    disable drift detection, and must not raise inside a monitoring path either.
    """
    try:
        row = query_one("SELECT value FROM app_settings WHERE key = ?", (key,))
        if not row:
            return default
        raw = row[0] if isinstance(row, (list, tuple)) else row["value"]
        val = float(raw)
        return val if math.isfinite(val) else default
    except Exception:
        return default


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
    #
    # The 80/20 split ALSO silently orphaned everything between the two windows: measured
    # 2026-08-15, baseline ended 2026-04-27 while recent started 2026-07-08, leaving 51 trading
    # dates in NEITHER window -- so the most recent quarter before the serving window was
    # invisible to the comparison. Baseline is now everything up to the recent window
    # (contiguous, no orphans), which is also the honest "what the model was trained on vs what
    # it is scoring now" question this check is supposed to answer.
    dates      = np.sort(df["date"].unique())
    n_recent   = min(30, max(1, len(dates) // 5))
    recent_dates = dates[-n_recent:]
    baseline   = df[df["date"].isin(dates[:-n_recent])]
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

    psi_crit  = _threshold("drift_psi_crit", PSI_CRIT)
    psi_frac  = _threshold("drift_psi_frac", PSI_FRAC)
    avg_warn  = _threshold("drift_avg_warn", DRIFT_AVG_WARN)

    values    = list(psi_scores.values())
    crit_frac = sum(1 for v in values if v > psi_crit) / len(values)
    max_psi   = max(values)
    avg_psi   = float(np.mean(values))

    # WARNING keys off a FRACTION (and avg_psi), never `max_psi > PSI_WARN`. The max of ~62
    # correlated features is an extreme-value statistic: against any per-feature bar it trips
    # essentially always, which is the same "fires 100% of the time, therefore says nothing"
    # defect as the pre-calibration EMERGENCY_RETRAIN -- measured 2026-08-15, max_psi cleared
    # PSI_WARN at 16 of 16 historical evaluation points even AFTER the thresholds were
    # recalibrated. max_psi is still reported (it's useful for a human reading the log line),
    # just not used as a trigger.
    status = "OK"
    if crit_frac > psi_frac:
        status = "EMERGENCY_RETRAIN"
    elif crit_frac > psi_frac / 2 or avg_psi > avg_warn:
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
        # DRIFT_AVG_*, not PSI_CRIT/PSI_WARN: `drift_score` is avg_psi (mean across features),
        # not a per-feature PSI, and the two live on different scales. See the constants' own
        # derivation above -- comparing avg_psi against the per-feature bar made this haircut
        # unconditional on every run this detector has ever made.
        ds = float(row[0] if isinstance(row, (list, tuple)) else row['drift_score'])
        if ds > _threshold("drift_avg_crit", DRIFT_AVG_CRIT):
            return 0.85
        if ds > _threshold("drift_avg_warn", DRIFT_AVG_WARN):
            return 0.93
        return 1.0
    except Exception as e:
        print(f"[DRIFT] get_drift_multiplier failed, defaulting to 1.0 (no haircut applied — drift status unknown): {e}", file=sys.stderr)
        return 1.0


# ---------------------------------------------------------------------------
# Layer 3: held-out ROC-AUC vs an absolute quality floor.
#
# Gap fixed 2026-08-24: walk_forward_validate() has always computed a held-out
# roc_auc, but nothing ever persisted it -- the INSERT above only writes
# drift_score, so dl_model_performance's directional_accuracy/roc_auc columns
# stayed NULL forever, check_accuracy_drift never found a fresh baseline, and
# the API served an empty AUC history. Two additions:
#   * write_training_metrics(): called from dl_engine.train_lstm() immediately
#     after training; persists the held-out metrics under TODAY's date with
#     model_version='lstm_vN' (the daily drift row keeps 'current', so the
#     ON CONFLICT target (model_name, eval_date, horizon_days) never collides).
#     NaN metrics are skipped -- a failed validation run must not look like data.
#   * check_auc_drift(): compares the most recent persisted held-out AUC against
#     an absolute floor. Deliberately a MONITOR, not a second gate: promotion
#     decisions stay in model_promotion.py (relative bars + staleness override);
#     this only records that serving quality shows evidence of decay.
# ---------------------------------------------------------------------------
PROMOTION_AUC_FLOOR = 0.55  # settings-overridable via app_settings key 'dl_min_roc_auc'


def write_training_metrics(metrics: dict, eval_date=None, model_version: str = "current") -> None:
    """Persist walk_forward_validate()'s held-out metrics into dl_model_performance."""
    day = eval_date or datetime.today().strftime("%Y-%m-%d")
    acc = metrics.get("directional_accuracy")
    auc = metrics.get("roc_auc")
    n   = metrics.get("n_test") or metrics.get("sample_count")

    def _clean(x):
        if x is None or (isinstance(x, float) and math.isnan(x)):
            return None
        return float(x)

    try:
        execute(
            """INSERT INTO dl_model_performance
               (model_name, model_version, eval_date, horizon_days,
                directional_accuracy, roc_auc, sample_count)
               VALUES (?, ?, ?, 5, ?, ?, ?)
               ON CONFLICT(model_name, eval_date, horizon_days) DO UPDATE SET
                 model_version=excluded.model_version,
                 directional_accuracy=excluded.directional_accuracy,
                 roc_auc=excluded.roc_auc,
                 sample_count=excluded.sample_count""",
            ("LSTM_TFT_ENSEMBLE", model_version, day,
             _clean(acc), _clean(auc), int(n) if n else None))
        print(f"[DRIFT] persisted held-out metrics for {day}: "
              f"acc={_clean(acc)} auc={_clean(auc)} n={n}")
    except Exception as e:
        # Monitoring write: swallow-and-log so it can never fail a finished training run.
        print(f"[DRIFT] held-out metric persistence failed (non-fatal): {e}", file=sys.stderr)


def check_auc_drift(min_roc_auc=None) -> dict:
    """Latest persisted held-out ROC-AUC vs the absolute floor (monitor only)."""
    if min_roc_auc is None:
        min_roc_auc = _threshold("dl_min_roc_auc", PROMOTION_AUC_FLOOR)
    try:
        row = query_one(
            "SELECT roc_auc, eval_date FROM dl_model_performance "
            "WHERE model_name = ? AND roc_auc IS NOT NULL "
            "ORDER BY eval_date DESC LIMIT 1", ("LSTM_TFT_ENSEMBLE",))
    except Exception as e:
        return {"status": "QUERY_FAILED", "error": str(e)}
    if not row:
        return {"status": "NO_DATA",
                "note": "no held-out roc_auc persisted yet; "
                        "next `dl_engine.py --mode train` run populates it"}
    if isinstance(row, (list, tuple)):
        auc_val, day = row[0], row[1]
    else:
        auc_val, day = row["roc_auc"], row["eval_date"]
    auc    = float(auc_val)
    status = "OK" if auc >= min_roc_auc else "DEGRADED"
    print(f"[DRIFT] AUC monitor: {auc:.4f} on {day} vs floor {min_roc_auc:.2f} -> {status}")
    return {"status": status, "held_out_roc_auc": auc,
            "eval_date": str(day), "floor": min_roc_auc}


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="LSTM_TFT_ENSEMBLE")
    args = parser.parse_args()

    r1 = check_feature_drift(args.model)
    r2 = check_accuracy_drift(args.model)
    # Monitor-only: a DEGRADED AUC must NOT exit(1) -- retrain decisions belong to
    # model_promotion (relative bars + staleness override), not to an absolute floor.
    r3 = check_auc_drift()
    print(f"[DRIFT] AUC monitor: {r3.get('status')}"
          + (f" held_out_auc={r3['held_out_roc_auc']:.4f}" if "held_out_roc_auc" in r3 else ""))

    if r1.get("status") == "EMERGENCY_RETRAIN" or r2.get("status") == "EMERGENCY_RETRAIN":
        print("[DRIFT] EMERGENCY_RETRAIN required")
        exit(1)  # Non-zero exit signals BullMQ worker to queue retrain
    print("[DRIFT] OK")

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
