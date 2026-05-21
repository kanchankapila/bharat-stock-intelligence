"""
Reward Engine
=============
Computes risk-adjusted rewards from resolved signal_outcomes and maintains
EMA-smoothed weight multipliers per (signal_type, regime, sector) in
signal_type_weights.  scoring_engine.py reads these at startup.

Reward formula:
  WIN:       (return_pct / horizon_days) × 10
  LOSS:      (return_pct / horizon_days) × 10 × 1.5
  NEUTRAL:   -0.05
  STOP_LOSS: (return_pct / horizon_days) × 10 × 2.0

EMA update (α = 0.15):
  new_weight = old_weight × 0.85 + reward × 0.15
  clamped to [0.3, 2.0]

Run:  python reward_engine.py
      python reward_engine.py --dry-run
      python reward_engine.py --days 30
"""

import os, json, sqlite3, datetime, argparse
from typing import Optional

DB_PATH = os.path.join(os.getcwd(), 'database.sqlite')

EMA_ALPHA   = 0.15
WEIGHT_MIN  = 0.3
WEIGHT_MAX  = 2.0
MIN_SAMPLES = 3

LOSS_MULTIPLIER      = 1.5
STOP_LOSS_MULTIPLIER = 2.0
NEUTRAL_REWARD       = -0.05


def _compute_reward(return_pct: float, horizon_days: int, outcome: str) -> float:
    base = (return_pct / max(horizon_days, 1)) * 10
    if outcome == 'WIN':
        return base
    if outcome == 'LOSS':
        return base * LOSS_MULTIPLIER
    if outcome == 'STOP_LOSS':
        return base * STOP_LOSS_MULTIPLIER
    return NEUTRAL_REWARD


def _parse_signal_types(signals_json: Optional[str]) -> list[str]:
    try:
        return [s['type'] for s in json.loads(signals_json or '[]')
                if isinstance(s, dict) and 'type' in s]
    except Exception:
        return []


def _get_sector(conn: sqlite3.Connection, symbol: str) -> str:
    row = conn.execute(
        "SELECT sector FROM nse_stocks WHERE symbol = ?", (symbol,)
    ).fetchone()
    return (row[0] or 'OTHER') if row else 'OTHER'


def _get_regime(conn: sqlite3.Connection, symbol: str, date: str) -> str:
    row = conn.execute(
        "SELECT nifty_regime FROM technical_signals WHERE symbol = ? AND date = ?",
        (symbol, date),
    ).fetchone()
    return (row[0] or 'SIDEWAYS') if row else 'SIDEWAYS'


def _get_current_weight(
    conn: sqlite3.Connection, signal_type: str, regime: str, sector: str
) -> tuple[float, int]:
    row = conn.execute("""
        SELECT weight, sample_count FROM signal_type_weights
        WHERE signal_type = ? AND regime = ? AND sector = ?
    """, (signal_type, regime, sector)).fetchone()
    return (row[0], row[1]) if row else (1.0, 0)


def _upsert_weight(
    conn: sqlite3.Connection, signal_type: str, regime: str, sector: str,
    new_weight: float, sample_count: int,
):
    now = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO signal_type_weights
            (signal_type, regime, sector, weight, sample_count, last_updated)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(signal_type, regime, sector) DO UPDATE SET
            weight=excluded.weight,
            sample_count=excluded.sample_count,
            last_updated=excluded.last_updated
    """, (signal_type, regime, sector, round(new_weight, 6), sample_count, now))


def update_weights(
    conn: sqlite3.Connection,
    days: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, int]:
    query = """
        SELECT symbol, signal_date, horizon_days, return_pct, outcome, signals_json
        FROM signal_outcomes
        WHERE outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND return_pct IS NOT NULL
    """
    params: tuple = ()
    if days:
        cutoff = (datetime.datetime.now() - datetime.timedelta(days=days)).strftime('%Y-%m-%d')
        query += " AND signal_date >= ?"
        params = (cutoff,)

    rows = conn.execute(query, params).fetchall()
    if not rows:
        print("[RewardEngine] No resolved outcomes found.")
        return {'processed': 0, 'updated': 0}

    print(f"[RewardEngine] Processing {len(rows)} resolved outcomes...")

    reward_map: dict[tuple, list[float]] = {}

    for symbol, signal_date, horizon_days, return_pct, outcome, signals_json in rows:
        reward    = _compute_reward(float(return_pct), int(horizon_days), outcome)
        regime    = _get_regime(conn, symbol, signal_date)
        sector    = _get_sector(conn, symbol)
        sig_types = _parse_signal_types(signals_json)

        for st in sig_types:
            key = (st, regime, sector)
            reward_map.setdefault(key, []).append(reward)

    updated = 0
    for (signal_type, regime, sector), rewards in reward_map.items():
        if len(rewards) < MIN_SAMPLES:
            continue
        avg_reward               = sum(rewards) / len(rewards)
        old_weight, sample_count = _get_current_weight(conn, signal_type, regime, sector)
        new_weight               = old_weight * (1 - EMA_ALPHA) + avg_reward * EMA_ALPHA
        new_weight               = max(WEIGHT_MIN, min(WEIGHT_MAX, new_weight))
        new_count                = sample_count + len(rewards)

        if dry_run:
            print(f"  [DRY] {signal_type}|{regime}|{sector}: "
                  f"{old_weight:.4f} → {new_weight:.4f} (n={len(rewards)})")
            continue

        _upsert_weight(conn, signal_type, regime, sector, new_weight, new_count)
        updated += 1

    if not dry_run:
        conn.commit()

    print(f"[RewardEngine] Updated {updated} signal_type_weights rows.")
    return {'processed': len(rows), 'updated': updated}


def run(days: Optional[int] = None, dry_run: bool = False):
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"[RewardEngine] DB not found: {DB_PATH}. Run from project root.")
    conn = sqlite3.connect(DB_PATH)
    try:
        update_weights(conn, days=days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--days',    type=int, default=None)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(days=args.days, dry_run=args.dry_run)
