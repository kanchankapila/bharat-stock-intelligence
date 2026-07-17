"""
Backtest Optimizer
==================
Grid search over (min_score, horizon_days, stop_loss_pct, max_positions).
Finds config maximising Sharpe ratio subject to constraints:
  win_rate >= 0.45, max_drawdown_pct >= -25.0, total_trades >= 20

Writes optimal params to app_settings:
  optimal_min_score, optimal_horizon_days, optimal_stop_loss_pct, optimal_max_positions

Only updates app_settings if new Sharpe >= current x 1.05.
Uses the most recent `--window` days of data (default 365).

Run:  python backtest_optimizer.py
      python backtest_optimizer.py --window 365 --dry-run
"""

import os, sys, datetime, argparse, itertools
from typing import Optional

from db_compat import connect, use_postgres, ConnWrapper

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

PARAM_GRID = {
    'min_score':     [3, 4, 5, 6, 7],
    'horizon_days':  [7, 10, 15, 20, 30],
    'stop_loss_pct': [5, 7, 10, 12],
    'max_positions': [10, 15, 20],
}

CONSTRAINT_WIN_RATE     = 0.45
CONSTRAINT_MAX_DRAWDOWN = -25.0
CONSTRAINT_MIN_TRADES   = 20
CONSTRAINT_MIN_TRADES_HOLDOUT = 10  # holdout window is smaller than the full search window
UPDATE_THRESHOLD        = 1.05   # new Sharpe must be >= current * 1.05
TRAIN_FRAC              = 0.7    # fraction of window_days used for the grid search itself


def find_best_config(
    results: list,
) -> Optional[dict]:
    """Given list of {'config': ..., 'stats': ...} dicts, return the one with
    highest Sharpe that satisfies all constraints. Returns None if none pass."""
    valid = [
        r for r in results
        if (r['stats'].get('win_rate', 0) >= CONSTRAINT_WIN_RATE
            and r['stats'].get('max_drawdown_pct', -999) >= CONSTRAINT_MAX_DRAWDOWN
            and r['stats'].get('total_trades', 0) >= CONSTRAINT_MIN_TRADES)
    ]
    if not valid:
        return None
    return max(valid, key=lambda r: r['stats'].get('sharpe_ratio', 0.0))


def should_update(current_sharpe: float, new_sharpe: float) -> bool:
    if current_sharpe <= 0:
        return new_sharpe > 0
    return new_sharpe >= current_sharpe * UPDATE_THRESHOLD


def _get_current_sharpe(conn: ConnWrapper) -> float:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='optimal_sharpe'"
    ).fetchone()
    return float(row[0]) if row else 0.0


def _write_optimal_params(conn: ConnWrapper, config: dict, sharpe: float):
    now = datetime.datetime.now().isoformat()
    pairs = [
        ('optimal_min_score',     str(config['min_score'])),
        ('optimal_horizon_days',  str(config['horizon_days'])),
        ('optimal_stop_loss_pct', str(config['stop_loss_pct'])),
        ('optimal_max_positions', str(config['max_positions'])),
        ('optimal_sharpe',        str(round(sharpe, 4))),
    ]
    for key, value in pairs:
        conn.execute("""
            INSERT INTO app_settings (key, value, "updatedAt")
            VALUES (?,?,?)
            ON CONFLICT(key) DO UPDATE SET value=excluded.value, "updatedAt"=excluded."updatedAt"
        """, (key, value, now))
    conn.commit()


def run_grid_search(
    conn: ConnWrapper,
    window_days: int = 365,
    dry_run: bool = False,
    train_frac: float = TRAIN_FRAC,
) -> Optional[dict]:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from backtester import Backtester

    # Walk-forward split: the grid search only ever sees the TRAIN portion; the winning
    # config is then replayed once, untouched, on the HOLDOUT portion, and it's the HOLDOUT
    # Sharpe that decides whether app_settings gets updated. Previously every combo (and the
    # promotion decision) used the exact same single window end-to-end -- a pure in-sample
    # search with nothing checking that the winner generalises past the data it was picked on.
    end         = datetime.date.today().isoformat()
    start       = (datetime.date.today() - datetime.timedelta(days=window_days)).isoformat()
    holdout_days = int(window_days * (1 - train_frac))
    train_end    = (datetime.date.today() - datetime.timedelta(days=holdout_days)).isoformat()
    train_start, holdout_start, holdout_end = start, train_end, end

    keys   = list(PARAM_GRID.keys())
    combos = list(itertools.product(*[PARAM_GRID[k] for k in keys]))
    total  = len(combos)
    print(f"[BtOptimizer] Grid search (train): {total} combinations  {train_start} -> {train_end}")
    print(f"[BtOptimizer] Holdout window (out-of-sample check): {holdout_start} -> {holdout_end}")

    results = []
    bt = Backtester()

    for i, combo in enumerate(combos, 1):
        cfg = dict(zip(keys, combo))
        print(f"  [{i}/{total}] {cfg} ...", end=' ', flush=True)

        try:
            # stop_loss_pct is stored in cfg and saved with results;
            # Backtester.run() does not yet accept it as a parameter
            stats = bt.run(
                start=train_start, end=train_end,
                horizon_days=cfg['horizon_days'],
                min_score=cfg['min_score'],
                max_positions=cfg['max_positions'],
                run_name=f"opt_{i}",
                stop_loss_pct=cfg['stop_loss_pct'],
            )
        except Exception as e:
            print(f"ERROR: {e}")
            continue

        if not stats:
            print("no trades")
            continue

        print(f"Sharpe={stats.get('sharpe_ratio',0):.3f}  "
              f"WR={stats.get('win_rate',0):.2f}  "
              f"DD={stats.get('max_drawdown_pct',0):.1f}%")
        results.append({'config': cfg, 'stats': stats})

    if not results:
        print("[BtOptimizer] No results on the train window -- cannot optimise.")
        bt.close()
        conn.execute("DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'")
        conn.commit()
        return None

    best = find_best_config(results)
    if not best:
        print("[BtOptimizer] No config passed all constraints on the train window.")
        bt.close()
        conn.execute("DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'")
        conn.commit()
        return None

    print(f"\n[BtOptimizer] Best TRAIN config: {best['config']}")
    print(f"  Train Sharpe={best['stats']['sharpe_ratio']:.4f}  WR={best['stats']['win_rate']:.2f}")

    # Out-of-sample replay: same config, holdout window the grid search never touched.
    try:
        holdout_stats = bt.run(
            start=holdout_start, end=holdout_end,
            horizon_days=best['config']['horizon_days'],
            min_score=best['config']['min_score'],
            max_positions=best['config']['max_positions'],
            run_name="opt_holdout",
            stop_loss_pct=best['config']['stop_loss_pct'],
        )
    finally:
        bt.close()

    # Clean up intermediate optimizer run rows (run_names like 'opt_%', incl. 'opt_holdout').
    # This always runs, dry-run or not: Backtester.run() unconditionally persists each trial
    # via save_run() (no persist flag exists on that shared method), so these rows are
    # ephemeral scratch data created earlier in this same call, not pre-existing state a
    # dry-run needs to protect.
    if dry_run:
        print(f"[BtOptimizer] [DRY] Cleaning up intermediate trial rows from backtesting_runs "
              f"(run_name LIKE 'opt_%') -- scratch rows from this grid search, not persisted "
              f"config changes.")
    conn.execute("DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'")
    conn.commit()

    if not holdout_stats:
        print("[BtOptimizer] No holdout trades for the winning config -- cannot validate "
              "out-of-sample. Not updating.")
        return best

    print(f"[BtOptimizer] Holdout Sharpe={holdout_stats.get('sharpe_ratio',0):.4f}  "
          f"WR={holdout_stats.get('win_rate',0):.2f}  "
          f"DD={holdout_stats.get('max_drawdown_pct',0):.1f}%  "
          f"trades={holdout_stats.get('total_trades',0)}")

    holdout_passes = (
        holdout_stats.get('win_rate', 0) >= CONSTRAINT_WIN_RATE
        and holdout_stats.get('max_drawdown_pct', -999) >= CONSTRAINT_MAX_DRAWDOWN
        and holdout_stats.get('total_trades', 0) >= CONSTRAINT_MIN_TRADES_HOLDOUT
    )
    if not holdout_passes:
        print("[BtOptimizer] Winning config failed constraints on the holdout window -- "
              "likely overfit to the train window. Not updating app_settings.")
        return best

    current_sharpe = _get_current_sharpe(conn)
    new_sharpe     = holdout_stats['sharpe_ratio']  # promotion decision uses the OUT-OF-SAMPLE sharpe

    if dry_run:
        print(f"[BtOptimizer] [DRY] Would update app_settings using HOLDOUT Sharpe "
              f"(current={current_sharpe:.4f}, new={new_sharpe:.4f})")
        return best

    if should_update(current_sharpe, new_sharpe):
        _write_optimal_params(conn, best['config'], new_sharpe)
        print(f"[BtOptimizer] app_settings updated. "
              f"Sharpe {current_sharpe:.4f} -> {new_sharpe:.4f} (holdout)")
    else:
        print(f"[BtOptimizer] No update: new holdout Sharpe {new_sharpe:.4f} < "
              f"current {current_sharpe:.4f} x {UPDATE_THRESHOLD}")

    return best


def run(window_days: int = 365, dry_run: bool = False):
    if not use_postgres() and not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"Database not found: {DB_PATH}. Run from project root.")
    conn = connect()
    try:
        run_grid_search(conn, window_days=window_days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--window',  type=int, default=365,
                        help='Rolling window in days (default: 365)')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(window_days=args.window, dry_run=args.dry_run)
