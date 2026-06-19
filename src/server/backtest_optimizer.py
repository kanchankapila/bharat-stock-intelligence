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
UPDATE_THRESHOLD        = 1.05   # new Sharpe must be >= current * 1.05


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
) -> Optional[dict]:
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    from backtester import Backtester

    end   = datetime.date.today().isoformat()
    start = (datetime.date.today() - datetime.timedelta(days=window_days)).isoformat()

    keys   = list(PARAM_GRID.keys())
    combos = list(itertools.product(*[PARAM_GRID[k] for k in keys]))
    total  = len(combos)
    print(f"[BtOptimizer] Grid search: {total} combinations  {start} -> {end}")

    results = []
    bt = Backtester()

    try:
        for i, combo in enumerate(combos, 1):
            cfg = dict(zip(keys, combo))
            print(f"  [{i}/{total}] {cfg} ...", end=' ', flush=True)

            try:
                # stop_loss_pct is stored in cfg and saved with results;
                # Backtester.run() does not yet accept it as a parameter
                stats = bt.run(
                    start=start, end=end,
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

    finally:
        bt.close()

    # Clean up intermediate optimizer run rows (run_names like 'opt_%')
    conn.execute("DELETE FROM backtesting_runs WHERE run_name LIKE 'opt_%'")
    conn.commit()

    if not results:
        print("[BtOptimizer] No results -- cannot optimise.")
        return None

    best = find_best_config(results)
    if not best:
        print("[BtOptimizer] No config passed all constraints.")
        return None

    print(f"\n[BtOptimizer] Best config: {best['config']}")
    print(f"  Sharpe={best['stats']['sharpe_ratio']:.4f}  "
          f"WR={best['stats']['win_rate']:.2f}")

    current_sharpe = _get_current_sharpe(conn)
    new_sharpe     = best['stats']['sharpe_ratio']

    if dry_run:
        print(f"[BtOptimizer] [DRY] Would update app_settings "
              f"(current Sharpe={current_sharpe:.4f}, new={new_sharpe:.4f})")
        return best

    if should_update(current_sharpe, new_sharpe):
        _write_optimal_params(conn, best['config'], new_sharpe)
        print(f"[BtOptimizer] app_settings updated. "
              f"Sharpe {current_sharpe:.4f} -> {new_sharpe:.4f}")
    else:
        print(f"[BtOptimizer] No update: new Sharpe {new_sharpe:.4f} < "
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
