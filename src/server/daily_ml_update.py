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

import subprocess
import sys
import datetime
import argparse

SCRIPTS = [
    ('outcome_resolver',  ['python', 'outcome_resolver.py']),
    ('online_learner',    ['python', 'online_learner.py', '--window', '30', '--min-new', '1']),
    ('ml_ensemble_incr',  ['python', 'ml_ensemble.py', '--incremental', '--incr-days', '3']),
    ('drift_detector',    ['python', 'drift_detector.py']),
]


def run(dry_run: bool = False) -> None:
    print(f"\n[DailyML] Starting daily feedback loop — {datetime.datetime.now():%Y-%m-%d %H:%M:%S}")
    failed = []
    for name, cmd in SCRIPTS:
        print(f"\n[DailyML] -- {name} --")
        if dry_run:
            print(f"  DRY-RUN: {' '.join(cmd)}")
            continue
        result = subprocess.run(cmd)
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
