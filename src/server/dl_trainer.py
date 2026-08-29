#!/usr/bin/env python3
"""
DL retrain orchestrator. Runs full pipeline, quality-gates new model,
promotes only if it beats current production model.
Quality gate lives in dl_engine.py's _promote_lstm_version() — see that function's
docstring for the full rule (must beat the active version's roc_auc by a margin,
refuses anything with diverged/non-finite weights).
"""

import polars as pl
import subprocess
import sys
import math
import json
import argparse
from datetime import datetime
from pathlib import Path

from db_compat import connect, ConnWrapper

MODEL_DIR = Path(__file__).parent / "ml_models"
LOCK_KEY  = "dl_retrain_running"
PYDIR     = str(Path(__file__).parent)

# Must exceed queues.ts's dl-retrain-weekly/emergency BullMQ timeout (24h) -- a lower threshold
# here would consider a legitimately-still-running full-universe retrain "stale" partway through
# and let a second trainer start concurrently (both writing lstm_v{N}.pt / dl_model_config.json
# at once). The old 7200s (2h) threshold predated any measurement of real training time; a
# 25-symbol sample measured ~15min under typical GPU contention on this machine, so a full
# ~2100-symbol run plus walk-forward validation can genuinely run for many hours.
STALE_LOCK_SECONDS = 25 * 60 * 60  # 25h -- 1h of slack past the 24h job timeout


def _get_setting(con: ConnWrapper, key: str, default=None):
    row = con.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def _set_setting(con: ConnWrapper, key: str, value: str):
    con.execute(
        "INSERT INTO app_settings (key, value) VALUES (?,?) "
        "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        (key, value),
    )
    con.commit()


def _record_model_registry(con: ConnWrapper, new_version: int, auc, acc, promoted: bool) -> None:
    """Write this training attempt's model_registry row, deactivating the prior active
    BiLSTM row iff this one was actually promoted (mirrors cs_ranker.py's
    _register_cs_model / ml_ensemble.py's champion-challenger bookkeeping). Split out from
    retrain_models() so the is_active handling is unit-testable without the real
    training/subprocess/torch pipeline.

    Previously this INSERT ran unconditionally with is_active based on a gate that treated
    NaN metrics as an automatic pass, and never deactivated the previous row either way —
    every version from v4 through v18 was left with is_active=1 in model_registry forever.
    """
    if promoted:
        con.execute(
            "UPDATE model_registry SET is_active=0 WHERE model_name=? AND is_active=1",
            ("BiLSTM",),
        )
    con.execute(
        """INSERT INTO model_registry
           (model_name, model_version, model_type, cv_roc_auc, cv_accuracy,
            training_samples, is_active, trained_at)
           VALUES (?,?,?,?,?,?,?,CURRENT_TIMESTAMP)""",
        ("BiLSTM", str(new_version), "deep_learning", auc, acc, -1, 1 if promoted else 0),
    )
    con.commit()


def _run(cmd: str, timeout_sec: int = 1800) -> int:
    cmd_resolved = cmd.replace("python ", f'"{sys.executable}" ', 1)
    print(f"[TRAINER] Running: {cmd_resolved}")
    # Redirect stdio to DEVNULL so the subprocess (and any grandchildren it spawns, e.g.
    # feature_engineering.py's ProcessPoolExecutor workers) never hold Node's inherited
    # pipe endpoints open. If this process is killed by Node the pipe closes immediately.
    import os
    _kwargs: dict = {
        "shell": True,
        "cwd": PYDIR,
        "timeout": timeout_sec,
        "stdin": subprocess.DEVNULL,
        "stdout": subprocess.DEVNULL,
        "stderr": subprocess.DEVNULL,
    }
    if sys.platform == "win32":
        _kwargs["creationflags"] = subprocess.CREATE_NO_WINDOW
    else:
        _kwargs["close_fds"] = True
    try:
        result = subprocess.run(cmd_resolved, **_kwargs)
        return result.returncode
    except subprocess.TimeoutExpired:
        # A hung sub-step (observed: a broken ProcessPoolExecutor in feature_engineering.py
        # can block its own shutdown/join indefinitely on Windows) used to wedge this whole
        # process forever, leaving dl_retrain_running='1' stuck until an unrelated server
        # restart happened to kill it — masking weeks of "job succeeded" heartbeats while
        # model_registry never got a new row. A bounded timeout turns that into a real,
        # loud failure that clears the lock via the except block in retrain_models().
        print(f"[TRAINER] Command timed out after {timeout_sec}s, killing: {cmd_resolved}")
        return 1


def retrain_models(trigger: str = "scheduled") -> dict:
    con = connect()

    # Lock check — prevent concurrent retrains
    lock_val = _get_setting(con, LOCK_KEY)
    if lock_val == "1":
        lock_time_str = _get_setting(con, "dl_retrain_acquired_at")
        is_stale = False
        if lock_time_str:
            try:
                lock_time = datetime.fromisoformat(lock_time_str)
                if (datetime.now() - lock_time).total_seconds() > STALE_LOCK_SECONDS:
                    is_stale = True
            except Exception:
                is_stale = True
        else:
            is_stale = True

        if not is_stale:
            print("[TRAINER] Retrain already running — skipping")
            con.close()
            return {"status": "SKIPPED", "reason": "lock_held"}
        else:
            print("[TRAINER] Stale lock detected, clearing lock and proceeding.")

    _set_setting(con, LOCK_KEY, "1")
    _set_setting(con, "dl_retrain_acquired_at", datetime.now().isoformat())
    con.close()

    result = {"trigger": trigger, "timestamp": datetime.now().isoformat()}

    try:
        # Step 1: Refresh today's features only (fast mode)
        rc = _run("python feature_engineering.py --date today")
        if rc != 0:
            raise RuntimeError("feature_engineering.py failed")

        # Step 2: Determine new version
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        cfg_path = MODEL_DIR / "dl_model_config.json"
        cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {"lstm_version": 1}
        new_version = cfg.get("lstm_version", 1) + 1

        # Step 3: Train BiLSTM in-process
        import importlib.util
        spec = importlib.util.spec_from_file_location("dl_engine", Path(__file__).parent / "dl_engine.py")
        dl = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(dl)

        metrics = dl.train_lstm(version=new_version)
        result["metrics"] = metrics

        acc = metrics.get("directional_accuracy")
        auc = metrics.get("roc_auc")
        acc_str = 'N/A' if acc is None or math.isnan(acc) else f'{acc:.3f}'
        auc_str = 'N/A' if auc is None or math.isnan(auc) else f'{auc:.3f}'

        # Step 4: Quality gate — delegate to dl_engine's _promote_lstm_version, the ONE gate
        # for this model (mirrors ml_ensemble.py/cs_ranker.py's promotion pattern). This used
        # to be a separate, weaker gate reimplemented here that only checked acc/auc for NaN
        # and treated "metrics came back NaN" as "skip the check, promote anyway" — which is
        # backwards: train_lstm() sets metrics["error"] when the weights themselves diverged
        # (and correctly refuses to even save the checkpoint), but this gate never looked at
        # that key, so a diverged-and-unsaved version still got activated in dl_model_config.json
        # (observed live: v19 pointed to a lstm_v19.pt that was never written). Every version
        # from v4 through v18 was also left with is_active=1 in model_registry forever, since
        # this gate never deactivated the previous row either.
        result["promoted"] = dl._promote_lstm_version(new_version, metrics)
        if result["promoted"]:
            print(f"[TRAINER] Quality gate PASSED (acc={acc_str}, auc={auc_str}) -> promoted v{new_version}")
        else:
            print(f"[TRAINER] Quality gate FAILED/SKIPPED (acc={acc_str}, auc={auc_str}) — "
                  f"keeping v{cfg.get('lstm_version', 1)}. Candidate weights (if saved) are left "
                  f"on disk at lstm_v{new_version}.pt for inspection, not deleted.")

        # Step 5: Write model_registry entry
        con2 = connect()
        try:
            _record_model_registry(con2, new_version, auc, acc, result["promoted"])

            # Step 6: Regime retrain — piggybacks on the weekly schedule since nothing
            # fires trigger="monthly" (dead code path); without this the HMM model
            # silently never gets (re)trained if ml_models/hmm_regime.pkl goes missing.
            if trigger in ("scheduled", "monthly"):
                _run("python regime_detector.py --mode train")

            _set_setting(con2, "dl_last_retrain", datetime.now().isoformat())
            _set_setting(con2, LOCK_KEY, "0")
        finally:
            con2.close()

    except Exception as e:
        con3 = connect()
        try:
            _set_setting(con3, LOCK_KEY, "0")
        finally:
            con3.close()
        result["error"] = str(e)
        print(f"[TRAINER] ERROR: {e}")

    return result


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--trigger", choices=["scheduled", "drift", "monthly"], default="scheduled")
    args = parser.parse_args()
    result = retrain_models(args.trigger)
    print(f"[TRAINER] Done: {result}")
    # Exit non-zero on a real training error so the BullMQ worker records a failure instead of a
    # false success. Without this, retrain_models() swallows its own exceptions (returns an 'error'
    # dict, never throws), the process exits 0, the job heartbeat logs success — yet model_registry
    # gets no new BiLSTM row (observed: job "succeeded" but the model went 29 days without a retrain).
    # SKIPPED (concurrent-lock) is not a failure, so gate only on 'error'.
    if result.get("error"):
        sys.exit(1)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
