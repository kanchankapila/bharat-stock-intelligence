#!/usr/bin/env python3
"""
DL retrain orchestrator. Runs full pipeline, quality-gates new model,
promotes only if it beats current production model.
Quality gate lives in dl_engine.py's _promote_lstm_version() — see that function's
docstring for the full rule (must beat the active version's roc_auc by a margin,
refuses anything with diverged/non-finite weights).
"""

import os
import subprocess
import sys
import math
import json
import argparse
import time
from datetime import datetime, timezone
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
# 2026-08-29: this VALUE (24h+1h buffer) is deliberately reasoned, but no scheduled run's real
# per-step duration had ever actually been measured to validate the underlying 24h ceiling --
# STEP_LOG_KEY below exists to close that gap. Once a few weeks of real per-step durations
# accumulate, revisit whether 24h is generous-but-fine or masking real slowness.
STALE_LOCK_SECONDS = 25 * 60 * 60  # 25h -- 1h of slack past the 24h job timeout

# 2026-08-29: lightweight step-level progress, added after a live investigation had to resort to
# checking OS-level CPU deltas on a guessed PID to tell "still working" from "hung" -- every
# per-step subprocess's own stdout/stderr is DEVNULL'd by _run() (see its docstring), so there was
# no way to distinguish the two other than that manual process-level check. Reuses app_settings
# (same pattern as the LOCK_KEY itself) rather than a new table/migration for a diagnostic-only
# feature. STEP_LOG_KEY holds a JSON array of {step, started_at, finished_at, duration_sec} for
# the CURRENT/most recent run, so a future session (or a monitoring check) can answer "how long
# did each step actually take" without re-deriving it from ambiguous log timestamps.
STEP_LOG_KEY = "dl_retrain_step_log"


def _utc_now_iso() -> str:
    """Explicit UTC, not the naive datetime.now() this file used everywhere before 2026-08-29 --
    that stores LOCAL time (confirmed live: this machine's local clock is IST, UTC+5:30) with no
    timezone marker, which silently misled a live investigation into believing a job that started
    exactly on its 06:00 UTC schedule had actually started 5.5 hours late. Every NEW timestamp
    this file writes uses this helper; dl_retrain_acquired_at's own naive datetime.now() calls
    were left as-is deliberately (see the comment at their call sites) since STALE_LOCK_SECONDS'
    comparison logic uses datetime.now() on both sides of the subtraction and is internally
    consistent -- correct by not mixing units, not because naive-local was the right choice."""
    return datetime.now(timezone.utc).isoformat()


class _StepLog:
    """Timestamps each pipeline step to app_settings[STEP_LOG_KEY], explicit UTC. Best-effort --
    a DB hiccup while logging progress must never fail the actual retrain.

    Deliberately does NOT hold a connection across steps: this file's own `retrain_models()`
    already documents (see its Step-5 con2/con3 handling) that a connection checked out once
    and left idle while a step like BiLSTM training runs for hours can be closed server-side --
    the exact class this session separately found and fixed in strategy_optimizer.py/
    backtest_optimizer.py. Each write here opens, uses, and closes its own short-lived
    connection instead of reusing one across the whole run."""

    def __init__(self):
        self.steps: list[dict] = []

    def step(self, name: str):
        return _StepTimer(self, name)

    def _record(self, name: str, started_at: str, finished_at: str, duration_sec: float, status: str):
        self.steps.append({
            "step": name, "started_at": started_at, "finished_at": finished_at,
            "duration_sec": round(duration_sec, 1), "status": status,
        })
        try:
            log_con = connect()
            try:
                _set_setting(log_con, STEP_LOG_KEY, json.dumps(self.steps))
            finally:
                log_con.close()
        except Exception as e:
            print(f"[TRAINER] step-log write failed (non-fatal): {e}")


class _StepTimer:
    def __init__(self, log: _StepLog, name: str):
        self.log, self.name = log, name

    def __enter__(self):
        self.t0 = time.monotonic()
        self.started_at = _utc_now_iso()
        print(f"[TRAINER] step start: {self.name} at {self.started_at} (UTC)")
        return self

    def __exit__(self, exc_type, exc, tb):
        duration = time.monotonic() - self.t0
        finished_at = _utc_now_iso()
        status = "error" if exc_type else "ok"
        # Error-status step lines go to STDERR, not stdout: pythonRunner's non-zero-exit error
        # row (job_run_history.error / the log's stderrSnippet) carries only stderr, so a
        # step-level failure reason printed to stdout is invisible post-mortem. Observed live
        # 2026-09-27 (AF-20260927-20): train_lstm errored after 170min and the job's recorded
        # error was nothing but benign torch warnings -- the actual exception text (printed
        # here and in retrain_models()'s handler, both to stdout) was unrecoverable.
        print(f"[TRAINER] step {status}: {self.name} at {finished_at} (UTC), took {duration:.1f}s",
              file=sys.stderr if exc_type else None)
        self.log._record(self.name, self.started_at, finished_at, duration, status)
        return False  # never swallow the exception


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
        #
        # STDERR, not stdout (2026-09-29): this is the ONLY trace of why the step died, and
        # pythonRunner's job_run_history.error carries stderr only. Lost to stdout twice --
        # first the exception text (AF-20260927-20), then this line on the 2026-09-28 make-up
        # whose recorded stdout held nothing but "step ok: feature_engineering ... 1804.8s".
        print(f"[TRAINER] Command timed out after {timeout_sec}s, killing: {cmd_resolved}",
              file=sys.stderr)
        return 1



def _pid_alive(pid: int) -> bool:
    """Cross-platform: True if a process with this PID currently exists.

    No new dependency (psutil is not in requirements.txt): shells out to the platform's own
    process lister, matching this repo's existing subprocess-heavy style. Errors fail SAFE
    (assume alive) -- a check that cannot determine liveness must never be the reason a real
    lock gets cleared out from under a running retrain.
    """
    if pid is None or pid <= 0:
        return False
    try:
        if sys.platform == "win32":
            r = subprocess.run(["tasklist", "/FI", f"PID eq {pid}", "/NH"],
                                capture_output=True, text=True, timeout=5)
            return str(pid) in (r.stdout or "")
        os.kill(pid, 0)
        return True
    except ProcessLookupError:
        return False
    except PermissionError:
        return True  # exists, just owned by someone else
    except Exception:
        return True  # cannot tell -> fail safe, do not clear a possibly-live lock


def lock_is_stale(lock_time_str, owner_pid=None, now=None, pid_alive=_pid_alive,
                   stale_seconds: int = STALE_LOCK_SECONDS) -> bool:
    """A lock is stale if its OWNING PROCESS is provably gone, or -- when that cannot be
    determined (no recorded PID, an old lock row) -- once `stale_seconds` has elapsed.

    Provenance over elapsed time, for the identical reason registerJob.ts's
    isStaleActiveJob() exists one layer up at the BullMQ level: dl-retrain-weekly ran 14h48m
    on 2026-09-05, was killed by an unrelated pm2 restart (its OS PID confirmed gone), and the
    very next attempt ~22h later -- under the 25h wall-clock window -- was refused with
    "Retrain already running", doing nothing in 4 seconds. Wall-clock alone cannot distinguish
    a genuinely long retrain (this job legitimately runs past 14h) from a dead one; PID
    existence can, and dl_trainer.py runs as its own OS process, so its PID is exactly what the
    lock needs to record.
    """
    if owner_pid and owner_pid > 0 and not pid_alive(owner_pid):
        return True
    if not lock_time_str:
        return True
    try:
        lock_time = datetime.fromisoformat(lock_time_str)
    except Exception:
        return True
    now = now or datetime.now()
    return (now - lock_time).total_seconds() > stale_seconds


def _train_with_oom_retry(train_fn, release_fn):
    """Run train_fn(); on a CUDA-OOM RuntimeError, RELEASE attempt-1's memory BEFORE one retry.

    AF-20260929-01 (measured 2026-09-29 05:08 IST, job 716): attempt 1 died AFTER training had
    completed (the GPU-side divergence check, fixed separately in dl_engine) and the whole-train
    retry — added 2026-09-28 — fired, but attempt 2 died at `BiLSTMModel().to(DEVICE)` allocating
    a few MB. Cause: the old retry ran INSIDE the except block, where the caught exception's
    traceback still referenced attempt 1's frames — model, chunk tensors, validation state, all
    resident on the shared WDDM GPU — so gc.collect()/empty_cache() had almost nothing to free.
    Retrying from OUTSIDE the except block lets the interpreter drop the exception (frames
    included) first; release_fn() then collects them and hands the VRAM back. Bounded: one
    retry (2 attempts x ~2.75h fits the 24h BullMQ lock; the lock is held throughout).
    Non-OOM RuntimeErrors re-raise immediately, unchanged.
    """
    try:
        return train_fn()
    except RuntimeError as e:
        if "out of memory" not in str(e).lower():
            raise
        print("[TRAINER] CUDA OOM escaped train_lstm; releasing attempt-1 memory and "
              "retrying the whole train ONCE", file=sys.stderr)
    # Above the except block EXITED NORMALLY: the interpreter has cleared the active exception,
    # so once nothing else references it, its traceback -> attempt-1 frames -> GPU tensors are
    # collectable. Doing the release while still INSIDE the except block — the old shape — is
    # exactly what made the 2026-09-29 retry die at .to(DEVICE).
    release_fn()
    return train_fn()


def retrain_models(trigger: str = "scheduled") -> dict:
    con = connect()

    # Lock check — prevent concurrent retrains
    lock_val = _get_setting(con, LOCK_KEY)
    if lock_val == "1":
        lock_time_str = _get_setting(con, "dl_retrain_acquired_at")
        owner_pid_str = _get_setting(con, "dl_retrain_owner_pid")
        owner_pid = int(owner_pid_str) if owner_pid_str and owner_pid_str.isdigit() else None

        if not lock_is_stale(lock_time_str, owner_pid=owner_pid):
            print("[TRAINER] Retrain already running — skipping")
            con.close()
            return {"status": "SKIPPED", "reason": "lock_held"}
        else:
            print(f"[TRAINER] Stale lock detected (owner pid {owner_pid} gone or wall-clock "
                  f"expired) -- clearing lock and proceeding.")

    _set_setting(con, LOCK_KEY, "1")
    _set_setting(con, "dl_retrain_acquired_at", datetime.now().isoformat())
    _set_setting(con, "dl_retrain_owner_pid", str(os.getpid()))
    _set_setting(con, STEP_LOG_KEY, "[]")  # clear the previous run's step log at the start of a new one
    con.close()

    result = {"trigger": trigger, "timestamp": datetime.now().isoformat()}
    steps = _StepLog()

    try:
        # Step 1: Refresh today's features only (fast mode).
        # 30min -> 60min budget (2026-09-29, AF-20260929-01): the 1800s _run default killed
        # this step on the 2026-09-28 23:30 IST make-up after 1804.8s (app_settings
        # dl_retrain_step_log), failing the whole retrain before training even started.
        # Measured on this box: 540s on the 2026-09-27 runs; >1804.8s under the 09-28
        # post-close cluster (screener-performance + unified-ranker co-running, RAM 94-96%);
        # the same script's full-universe sibling (dl-feature-refresh) measures 24-103min here.
        # 3600s is ~6.7x the measured quiet runtime, bounded far inside the 24h BullMQ lock,
        # and its write is an idempotent upsert on (symbol, date, timeframe).
        with steps.step("feature_engineering"):
            rc = _run("python feature_engineering.py --date today", timeout_sec=3600)
            # Raised INSIDE the `with` so the step is recorded 'error'. Until 2026-09-29 this
            # check sat AFTER it, which recorded a timed-out subprocess as status 'ok' with its
            # full 1804.8s duration -- precisely the misleading progress record STEP_LOG_KEY
            # exists to prevent, and what made the make-up's failure read as the training step.
            if rc != 0:
                raise RuntimeError("feature_engineering.py failed")

        # Step 2: Determine new version
        MODEL_DIR.mkdir(parents=True, exist_ok=True)
        cfg_path = MODEL_DIR / "dl_model_config.json"
        cfg = json.loads(cfg_path.read_text()) if cfg_path.exists() else {"lstm_version": 1}
        new_version = cfg.get("lstm_version", 1) + 1

        # Step 3: Train BiLSTM in-process -- this is the step expected to dominate total runtime
        # (full-universe LSTM fit + walk-forward validation); the one this session's live
        # investigation had no visibility into beyond an OS-level CPU-delta check on a guessed PID.
        with steps.step("train_lstm"):
            import importlib.util
            spec = importlib.util.spec_from_file_location("dl_engine", Path(__file__).parent / "dl_engine.py")
            dl = importlib.util.module_from_spec(spec)
            spec.loader.exec_module(dl)

            # Whole-train OOM net ABOVE the chunk-level guard (AF-20260927-20, AF-20260929-01):
            # attempt 1 can OOM from a site the per-chunk retry/skip never covered (measured
            # 2026-09-29: the post-training divergence check at dl_engine.py:904). Retry once —
            # but only after _train_with_oom_retry has DROPPED attempt 1's exception/frames and
            # run release_fn (gc + empty_cache), or the retry starts with attempt-1's VRAM still
            # live and dies at model.to(DEVICE) on a few MB (the 2026-09-29 observed failure).
            def _release_attempt1():
                import gc as _gc
                _gc.collect()
                try:
                    if getattr(dl, "torch", None) is not None and dl.DEVICE is not None \
                            and dl.DEVICE.type == "cuda":
                        dl.torch.cuda.empty_cache()
                except Exception as ce:
                    print(f"[TRAINER] empty_cache before retry failed (non-fatal): {ce}",
                          file=sys.stderr)

            metrics = _train_with_oom_retry(
                lambda: dl.train_lstm(version=new_version), _release_attempt1)
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
        with steps.step("record_and_regime_retrain"):
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
        try:
            con3 = connect()
            try:
                _set_setting(con3, LOCK_KEY, "0")
            finally:
                con3.close()
        except Exception as lock_err:
            print(f"[TRAINER] Failed to clear lock (non-fatal): {lock_err}")
        result["error"] = str(e)
        # STDERR, not stdout: this is the only trace of WHY the run failed -- pythonRunner's
        # rejection message (-> job_run_history.error) carries stderr only. Lost to stdout once
        # already (AF-20260927-20: the 2026-09-27 train_lstm failure's exception text is
        # unrecoverable because this print went to stdout). The TRACEBACK too: str(e) alone
        # names the error but not the LINE -- the 2026-09-28 CUDA-OOM recurrence escaped
        # train_lstm from a site the chunk-level guard never covered and without a traceback
        # could only be guessed at.
        import traceback
        print(f"[TRAINER] ERROR: {e}", file=sys.stderr)
        traceback.print_exc(file=sys.stderr)

    result["step_log"] = steps.steps
    total_sec = sum(s["duration_sec"] for s in steps.steps)
    print(f"[TRAINER] step summary: {[(s['step'], s['duration_sec'], s['status']) for s in steps.steps]} "
          f"(total logged: {total_sec:.1f}s)")

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
