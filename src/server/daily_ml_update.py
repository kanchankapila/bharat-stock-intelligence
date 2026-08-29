"""
Daily ML feedback loop — run after market close (~15:35 IST).

Order:
  1. outcome_resolver  — labels matured signals WIN/LOSS/NEUTRAL using today's prices
  2. online_learner    — partial_fit SGD + update Beta-Bernoulli priors
  3. ml_ensemble       — warm-start LGBM incremental (+20 rounds on last 3d)
  4. drift_detector    — PSI feature drift check → writes to dl_model_performance

Run: python daily_ml_update.py
     python daily_ml_update.py --dry-run
"""

import polars as pl
import subprocess
import sys
import datetime
import argparse
import os

SCRIPTS = [
    ('outcome_resolver',  ['python', 'outcome_resolver.py']),
    ('online_learner',    ['python', 'online_learner.py', '--window', '30', '--min-new', '1']),
    ('ml_ensemble_incr',  ['python', 'ml_ensemble.py', '--incremental', '--incr-days', '3']),
    ('drift_detector',    ['python', 'drift_detector.py']),
]

# On Windows, subprocess.run() with the default stdout/stderr=None inherits the *parent* process's
# stdio handles — which are the pipe endpoints that Node's execFile/spawn gave us. When Node kills
# the parent python.exe (daily_ml_update.py) via taskkill /T /F, the grandchildren spawned here
# may survive briefly with those handles still open, preventing the pipe's 'close' event from
# firing in Node. The slot is therefore never released and _runningPython stays inflated.
# Fix: redirect all stdio to DEVNULL so grandchildren never hold Node's pipe endpoints.
_DEVNULL = subprocess.DEVNULL
_POPEN_KWARGS: dict = {
    "stdin":  _DEVNULL,
    "stdout": _DEVNULL,
    "stderr": _DEVNULL,
}
if sys.platform == "win32":
    # CREATE_NO_WINDOW also prevents a console window from appearing and ensures
    # the grandchild has its own console group (further isolating its handle table).
    _POPEN_KWARGS["creationflags"] = subprocess.CREATE_NO_WINDOW
else:
    _POPEN_KWARGS["close_fds"] = True


def run(dry_run: bool = False) -> None:
    print(f"\n[DailyML] Starting daily feedback loop — {datetime.datetime.now():%Y-%m-%d %H:%M:%S}")
    failed = []
    for name, cmd in SCRIPTS:
        print(f"\n[DailyML] -- {name} --")
        if dry_run:
            print(f"  DRY-RUN: {' '.join(cmd)}")
            continue
        result = subprocess.run(cmd, **_POPEN_KWARGS)
        if result.returncode != 0:
            print(f"[DailyML] WARNING: {name} exited {result.returncode}")
            failed.append(name)
        else:
            print(f"[DailyML] {name} OK")

    print(f"\n[DailyML] Complete — {datetime.datetime.now():%H:%M:%S}")
    if failed:
        print(f"[DailyML] Failed steps: {failed}")
        sys.exit(1)


if __name__ == '__main__':
    parser = argparse.ArgumentParser(description='Daily ML feedback loop runner')
    parser.add_argument('--dry-run', action='store_true', help='Print commands without running')
    args = parser.parse_args()
    run(dry_run=args.dry_run)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
