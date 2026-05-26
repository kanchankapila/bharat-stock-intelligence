#!/usr/bin/env python3
"""
DL retrain orchestrator. Runs full pipeline, quality-gates new model,
promotes only if it beats current production model.
Quality gate: directional_accuracy > 0.50 AND roc_auc > 0.52
"""

import subprocess
import sqlite3
import json
import argparse
from datetime import datetime
from pathlib import Path

DB_PATH   = Path(__file__).parent.parent.parent / "stock_intelligence.db"
MODEL_DIR = Path(__file__).parent / "ml_models"
LOCK_KEY  = "dl_retrain_running"
PYDIR     = str(Path(__file__).parent)

QUALITY_MIN_ACC = 0.50
QUALITY_MIN_AUC = 0.52


def _get_setting(con: sqlite3.Connection, key: str, default=None):
    row = con.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
    return row[0] if row else default


def _set_setting(con: sqlite3.Connection, key: str, value: str):
    con.execute("INSERT OR REPLACE INTO app_settings (key, value) VALUES (?,?)", (key, value))
    con.commit()


def _run(cmd: str) -> int:
    print(f"[TRAINER] Running: {cmd}")
    result = subprocess.run(cmd, shell=True, cwd=PYDIR)
    return result.returncode


def retrain_models(trigger: str = "scheduled") -> dict:
    con = sqlite3.connect(DB_PATH)

    # Lock check — prevent concurrent retrains
    if _get_setting(con, LOCK_KEY) == "1":
        print("[TRAINER] Retrain already running — skipping")
        con.close()
        return {"status": "SKIPPED", "reason": "lock_held"}

    _set_setting(con, LOCK_KEY, "1")
    con.close()

    result = {"trigger": trigger, "timestamp": datetime.now().isoformat()}

    try:
        # Step 1: Refresh features
        rc = _run("python feature_engineering.py")
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

        acc = metrics.get("directional_accuracy", 0)
        auc = metrics.get("roc_auc", 0)

        # Step 4: Quality gate
        if acc > QUALITY_MIN_ACC and auc > QUALITY_MIN_AUC:
            cfg["lstm_version"] = new_version
            cfg_path.write_text(json.dumps(cfg, indent=2))
            print(f"[TRAINER] Quality gate PASSED (acc={acc:.3f}, auc={auc:.3f}) → promoted v{new_version}")
            result["promoted"] = True
        else:
            bad_path = MODEL_DIR / f"lstm_v{new_version}.pt"
            if bad_path.exists():
                bad_path.unlink()
            print(f"[TRAINER] Quality gate FAILED (acc={acc:.3f}<{QUALITY_MIN_ACC} or "
                  f"auc={auc:.3f}<{QUALITY_MIN_AUC}) — keeping v{cfg.get('lstm_version', 1)}")
            result["promoted"] = False

        # Step 5: Write model_registry entry
        con2 = sqlite3.connect(DB_PATH)
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

            # Step 6: Regime retrain on monthly trigger
            if trigger == "monthly":
                _run("python regime_detector.py --mode train")

            _set_setting(con2, "dl_last_retrain", datetime.now().isoformat())
            _set_setting(con2, LOCK_KEY, "0")
        finally:
            con2.close()

    except Exception as e:
        con3 = sqlite3.connect(DB_PATH)
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
