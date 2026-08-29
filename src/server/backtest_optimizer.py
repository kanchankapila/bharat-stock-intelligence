"""
Backtest Optimizer
==================
Grid search over (min_score, horizon_days, stop_loss_pct, max_positions).
Finds config maximising Sharpe ratio subject to constraints:
  win_rate >= 0.45, max_drawdown_pct >= -25.0, total_trades >= 20

Writes optimal params to app_settings:
  optimal_min_score, optimal_horizon_days, optimal_stop_loss_pct, optimal_max_positions

Promotion (2026-08-17 redesign, see docs/audit-findings.md AF-29): the holdout window is split
into up to N_HOLDOUT_FOLDS_MAX walk-forward folds; both the challenger and the current live
champion config are re-scored on each fold (apples-to-apples, never a stale stored number), and
app_settings only updates if the challenger clears UPDATE_THRESHOLD (1.05x) on a MAJORITY of
folds with enough trades to vote. A single fixed config's Sharpe was measured to swing 691.8% of
its mean across 3 non-overlapping windows of the available history -- one point estimate cannot
tell a real improvement from window luck.
Uses the most recent `--window` days of data (default 365).

Run:  python backtest_optimizer.py
      python backtest_optimizer.py --window 365 --dry-run
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode

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


def _get_current_config(conn: ConnWrapper) -> Optional[dict]:
    """Reads the currently-live champion config from app_settings, or None if nothing has ever
    been promoted (the actual state of this gate, confirmed live 2026-08-17: app_settings has
    never held an optimal_sharpe row at all -- see docs/audit-findings.md AF-29)."""
    keys = ('optimal_min_score', 'optimal_horizon_days', 'optimal_stop_loss_pct', 'optimal_max_positions')
    values = {}
    for key in keys:
        row = conn.execute("SELECT value FROM app_settings WHERE key=?", (key,)).fetchone()
        if row is None:
            return None
        values[key] = row[0]
    return {
        'min_score':     int(values['optimal_min_score']),
        'horizon_days':  int(values['optimal_horizon_days']),
        'stop_loss_pct': float(values['optimal_stop_loss_pct']),
        'max_positions': int(values['optimal_max_positions']),
    }


# ── Multi-fold promotion (2026-08-17 redesign) ──────────────────────────────────────
# Measured live (docs/audit-findings.md AF-29): a SINGLE fixed config's holdout Sharpe swung
# 691.8% of its mean across just 3 non-overlapping 45-day slices of the available history,
# sign-flipping between them -- a single point estimate cannot tell a genuine improvement from
# window luck. Compounding that, the old should_update() compared a FRESH holdout Sharpe
# against a STORED current_sharpe from a different, older run -- the two numbers were never
# measured on the same data, a second, separate confound on top of the noise itself.
#
# Both are fixed the way regime_detector.py's train_hmm() fixes single-EM-restart noise: take
# several independent looks and require them to agree, with the champion and challenger always
# scored on the IDENTICAL window so the comparison is apples-to-apples. The difference from the
# HMM case is the noise source -- there it's EM's local optimum (fixed by trying several random
# seeds and keeping the best by TRAIN objective); here it's which slice of the market the
# holdout happens to land on (fixed by splitting the holdout into several folds and requiring a
# MAJORITY, not picking the best -- there is no "best" fold to cherry-pick from without gaming
# the gate the same way selecting EM restarts by holdout score would).
N_HOLDOUT_FOLDS_MAX = 5
MIN_FOLD_DAYS        = 15   # a fold shorter than this can't hold a meaningful signal sample
MIN_FOLD_TRADES      = 5    # a fold with fewer trades than this doesn't cast a vote either way


def _split_holdout_folds(holdout_start: str, holdout_end: str,
                          max_folds: int = N_HOLDOUT_FOLDS_MAX,
                          min_fold_days: int = MIN_FOLD_DAYS) -> list:
    """Walk-forward split of the holdout window into up to max_folds contiguous,
    non-overlapping sub-windows, each at least min_fold_days long. Falls back to a single fold
    spanning the whole holdout window when it is too short to split -- same "degrade gracefully
    as history accumulates" pattern _effective_window_days already uses above. Pure function,
    directly unit-testable.
    """
    start_d = datetime.date.fromisoformat(holdout_start)
    end_d   = datetime.date.fromisoformat(holdout_end)
    total_days = (end_d - start_d).days
    if total_days < min_fold_days:
        return [(holdout_start, holdout_end)]

    n_folds   = max(1, min(max_folds, total_days // min_fold_days))
    fold_days = total_days // n_folds
    folds = []
    cursor = start_d
    for i in range(n_folds):
        fold_end = end_d if i == n_folds - 1 else cursor + datetime.timedelta(days=fold_days)
        folds.append((cursor.isoformat(), fold_end.isoformat()))
        cursor = fold_end
    return folds


def should_update_multi_fold(fold_results: list, min_fold_trades: int = MIN_FOLD_TRADES) -> tuple:
    """Pure decision function -- given per-fold stats already measured (challenger and, where a
    champion exists, champion, both on the SAME window), decide whether a MAJORITY of folds
    with enough trades favour the challenger. No counted folds -> do not promote (fail closed,
    same philosophy as find_best_config returning None when nothing clears constraints).

    Each element of fold_results: {'fold': (start, end), 'challenger_sharpe': float|None,
    'challenger_trades': int, 'champion_sharpe': float|None, 'champion_trades': int}.
    champion_sharpe is None for the bootstrap case (nothing promoted yet) -- that fold votes
    for the challenger under should_update()'s existing current<=0 rule (positive Sharpe wins),
    mirroring the single-window bootstrap behaviour this replaces.

    Returns (promote: bool, votes: list) -- votes annotates each fold with whether it was
    counted and, if so, which way it voted, for the caller to log.
    """
    votes = []
    for fr in fold_results:
        has_champion = fr.get('champion_sharpe') is not None
        c_trades = fr.get('challenger_trades', 0)
        m_trades = fr.get('champion_trades', 0)
        enough = c_trades >= min_fold_trades and (not has_champion or m_trades >= min_fold_trades)
        if not enough or fr.get('challenger_sharpe') is None:
            votes.append({**fr, 'counted': False})
            continue
        champion_sharpe = fr['champion_sharpe'] if has_champion else 0.0
        wins = should_update(champion_sharpe, fr['challenger_sharpe'])
        votes.append({**fr, 'counted': True, 'challenger_wins': wins})

    counted = [v for v in votes if v['counted']]
    if not counted:
        return False, votes
    win_count = sum(1 for v in counted if v['challenger_wins'])
    return win_count > len(counted) / 2, votes


def _run_config_on_window(bt, cfg: dict, start: str, end: str, run_name: str) -> Optional[dict]:
    """One Backtester.run() call for a given config/window -- used identically for the
    challenger and the champion so every fold comparison is scored on the same data."""
    return bt.run(
        start=start, end=end,
        horizon_days=cfg['horizon_days'], min_score=cfg['min_score'],
        max_positions=cfg['max_positions'], stop_loss_pct=cfg['stop_loss_pct'],
        run_name=run_name,
    )


def _score_folds(bt, challenger_cfg: dict, champion_cfg: Optional[dict], folds: list,
                  run_prefix: str = 'fold') -> list:
    """Runs the challenger (and, if one exists, the champion) on each fold. Not unit-tested
    directly -- it only orchestrates Backtester calls, matching run_grid_search's own existing
    precedent of staying out of the pure-function unit tests; should_update_multi_fold is the
    tested decision logic this feeds."""
    fold_results = []
    for i, (f_start, f_end) in enumerate(folds):
        c_stats = _run_config_on_window(bt, challenger_cfg, f_start, f_end, f"{run_prefix}_{i}_challenger")
        m_stats = (_run_config_on_window(bt, champion_cfg, f_start, f_end, f"{run_prefix}_{i}_champion")
                   if champion_cfg is not None else None)
        fold_results.append({
            'fold': (f_start, f_end),
            'challenger_sharpe': c_stats.get('sharpe_ratio') if c_stats else None,
            'challenger_trades': c_stats.get('total_trades', 0) if c_stats else 0,
            'champion_sharpe': m_stats.get('sharpe_ratio') if m_stats else None,
            'champion_trades': m_stats.get('total_trades', 0) if m_stats else 0,
        })
    return fold_results


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


MIN_WINDOW_DAYS = 30  # below this, train+holdout can't both hold a meaningful sample


def _effective_window_days(conn: ConnWrapper, requested_days: int, today: Optional[datetime.date] = None) -> int:
    """Clamp `requested_days` to how much technical_signals history actually exists.

    window_days=365 assumed a year of history. Live-verified 2026-08-15: the table's real
    depth was 91 days (MIN(date)=2026-05-16), so the default TRAIN window (today-365d to
    today-holdout_days, i.e. ~2025-08 to ~2026-04) predated the table's entire existence --
    every one of 300 grid combinations returned "No signals found" on EVERY run this script
    ever made (job_heartbeat: 2 successful runs, app_settings had no optimal_sharpe row at
    all). This was never a constraint-calibration problem -- CONSTRAINT_WIN_RATE /
    CONSTRAINT_MAX_DRAWDOWN were never even reached; the search window itself never touched a
    real row. Clamping here means a stale hardcoded default degrades gracefully as history
    accumulates instead of silently finding nothing forever. Pure function (a fixed `today` is
    injectable) so it is directly unit-testable without touching a real DB or Backtester.

    Returns 0 if there is no scored history at all (caller compares against MIN_WINDOW_DAYS).
    """
    today = today or datetime.date.today()
    depth_row = conn.execute(
        "SELECT MIN(date) FROM technical_signals WHERE signal_score IS NOT NULL"
    ).fetchone()
    min_date = depth_row[0] if depth_row else None
    if not min_date:
        return requested_days
    available_days = (today - datetime.date.fromisoformat(str(min_date)[:10])).days
    if available_days < requested_days:
        print(f"[BtOptimizer] Requested window={requested_days}d but technical_signals only has "
              f"{available_days}d of scored history (since {min_date}) -- using {available_days}d.")
        return max(available_days, 0)
    return requested_days


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
    window_days = _effective_window_days(conn, window_days)
    if window_days < MIN_WINDOW_DAYS:
        print(f"[BtOptimizer] Only {window_days}d of scored history available (<{MIN_WINDOW_DAYS}d "
              f"minimum) -- too little to split into a train/holdout pair. Skipping this run.")
        return None

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
            print(f"ERROR: {e}", file=sys.stderr)
            continue

        if not stats:
            print("no trades")
            continue

        print(f"Sharpe={stats.get('sharpe_ratio',0):.3f}  "
              f"WR={stats.get('win_rate',0):.2f}  "
              f"DD={stats.get('max_drawdown_pct',0):.1f}%")
        results.append({'config': cfg, 'stats': stats})

    # `conn` (this function's write handle -- the DELETE cleanup calls below and
    # _get_current_sharpe/_get_current_config further down) has sat completely idle since
    # _effective_window_days() at the top of this function, while the loop above did ~13-16
    # min of real work through `bt`'s OWN separate connection (300 grid combos). Same failure
    # shape already fixed in strategy_optimizer.py (2026-08-25, 2026-08-26, same docstring
    # there): a connection idle that long can be closed server-side (Postgres/an intermediary)
    # without pool_pre_ping ever catching it, since pre_ping only validates a connection at
    # POOL CHECKOUT and this one was checked out once at the top of run() and never returned.
    # Reproduced live 2026-08-27: exactly this crash, on the FIRST conn.execute() after this
    # loop (the 'opt_%' cleanup DELETE, three lines down) -- "psycopg2.OperationalError:
    # server closed the connection unexpectedly" -- which is why 301 orphaned 'opt_*'/
    # 'opt_holdout' scratch rows were sitting in backtesting_runs from the prior failed run
    # (the crash happens AFTER the holdout run's own row is saved via `bt`, but before this
    # function's own DELETE can clean it up). Reconnecting once here, before the gap's first
    # post-loop use, covers all three DELETE call sites below plus the two reads after them.
    conn.close()
    conn = connect()

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

    new_sharpe = holdout_stats['sharpe_ratio']  # stored/reported Sharpe: full aggregate holdout, unchanged

    # Promotion decision: multi-fold, same-window champion/challenger comparison (see the
    # "Multi-fold promotion" block above for why). _get_current_sharpe is now informational
    # only -- logged for continuity, no longer the promotion input.
    stored_sharpe = _get_current_sharpe(conn)
    champion_cfg = _get_current_config(conn)
    folds = _split_holdout_folds(holdout_start, holdout_end)
    print(f"[BtOptimizer] Promotion check: {len(folds)} holdout fold(s), "
          f"champion={'none (bootstrap)' if champion_cfg is None else champion_cfg} "
          f"(last stored optimal_sharpe={stored_sharpe:.4f}, informational only -- the "
          f"champion below is re-scored fresh on THIS holdout's own folds, not read from storage)")

    fold_bt = Backtester()
    try:
        fold_results = _score_folds(fold_bt, best['config'], champion_cfg, folds)
    finally:
        fold_bt.close()
    conn.execute("DELETE FROM backtesting_runs WHERE run_name LIKE 'fold_%'")
    conn.commit()

    promote, votes = should_update_multi_fold(fold_results)
    for v in votes:
        tag = 'SKIP (too few trades)' if not v.get('counted') else ('WIN' if v['challenger_wins'] else 'LOSS')
        c_s = f"{v['challenger_sharpe']:.4f}" if v.get('challenger_sharpe') is not None else 'n/a'
        m_s = f"{v['champion_sharpe']:.4f}" if v.get('champion_sharpe') is not None else 'n/a'
        print(f"    fold {v['fold'][0]}->{v['fold'][1]}: challenger={c_s}  champion={m_s}  [{tag}]")
    counted = sum(1 for v in votes if v.get('counted'))
    won = sum(1 for v in votes if v.get('counted') and v.get('challenger_wins'))

    if dry_run:
        print(f"[BtOptimizer] [DRY] Would {'update' if promote else 'NOT update'} app_settings "
              f"(aggregate holdout Sharpe={new_sharpe:.4f}, won {won}/{counted} counted fold(s))")
        return best

    if promote:
        _write_optimal_params(conn, best['config'], new_sharpe)
        print(f"[BtOptimizer] app_settings updated. Aggregate holdout Sharpe={new_sharpe:.4f}, "
              f"won {won}/{counted} counted fold(s) against the champion")
    else:
        print(f"[BtOptimizer] No update: challenger won only {won}/{counted} counted fold(s) "
              f"against the champion (majority required).")

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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
