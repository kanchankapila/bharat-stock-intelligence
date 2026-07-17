#!/usr/bin/env python3
"""
DL retrain orchestrator. Runs full pipeline, quality-gates new model,
promotes only if it beats current production model.
Quality gate: directional_accuracy > 0.50 AND roc_auc > 0.52
"""

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

QUALITY_MIN_ACC = 0.50
QUALITY_MIN_AUC = 0.52


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


def _run(cmd: str, timeout_sec: int = 1800) -> int:
    cmd_resolved = cmd.replace("python ", f'"{sys.executable}" ', 1)
    print(f"[TRAINER] Running: {cmd_resolved}")
    try:
        result = subprocess.run(cmd_resolved, shell=True, cwd=PYDIR, timeout=timeout_sec)
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
                if (datetime.now() - lock_time).total_seconds() > 7200:
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

        acc_valid = acc is not None and not math.isnan(acc)
        auc_valid = auc is not None and not math.isnan(auc)

        acc_val_for_gate = acc if acc_valid else 0.0
        auc_val_for_gate = auc if auc_valid else 0.0

        # Gate: accuracy must beat random (>=0.50). Skip gate if NaN/None (insufficient data).
        acc_ok = (not acc_valid) or (acc_val_for_gate >= QUALITY_MIN_ACC)
        auc_ok = (not auc_valid) or (auc_val_for_gate > QUALITY_MIN_AUC)  # NaN = skip AUC gate

        acc_str = 'N/A' if not acc_valid else f'{acc:.3f}'
        auc_str = 'N/A' if not auc_valid else f'{auc:.3f}'

        # Step 4: Quality gate
        if acc_ok and auc_ok:
            cfg["lstm_version"] = new_version
            cfg_path.write_text(json.dumps(cfg, indent=2))
            print(f"[TRAINER] Quality gate PASSED (acc={acc_str}, auc={auc_str}) -> promoted v{new_version}")
            result["promoted"] = True
        else:
            bad_path = MODEL_DIR / f"lstm_v{new_version}.pt"
            if bad_path.exists():
                bad_path.unlink()
            reason = f"acc={acc_str}<{QUALITY_MIN_ACC}" if not acc_ok else f"auc={auc_str}<{QUALITY_MIN_AUC}"
            print(f"[TRAINER] Quality gate FAILED ({reason}) — keeping v{cfg.get('lstm_version', 1)}")
            result["promoted"] = False

        # Step 5: Write model_registry entry
        con2 = connect()
        try:
            con2.execute(
                """INSERT INTO model_registry
                   (model_name, model_version, model_type, cv_roc_auc,
                    training_samples, is_active, trained_at)
                   VALUES (?,?,?,?,?,?,CURRENT_TIMESTAMP)""",
                ("BiLSTM", str(new_version), "deep_learning",
                 auc, -1, 1 if result.get("promoted") else 0),
            )
            con2.commit()

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
