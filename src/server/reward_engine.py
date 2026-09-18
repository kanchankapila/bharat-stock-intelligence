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

import json, datetime, argparse
from typing import Optional

from db_compat import connect, ConnWrapper

EMA_ALPHA   = 0.15
WEIGHT_MIN  = 0.3
WEIGHT_MAX  = 2.0
MIN_SAMPLES = 3
# Default look-back when --days is not given. The EMA is meant to track *recent* performance;
# scanning the full outcomes history every run re-blends the same old rows repeatedly (and hung
# a dry-run >150s). A bounded window keeps the cron fast and the weights fresh.
DEFAULT_WINDOW_DAYS = 180

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


def _d10(x) -> str:
    """Normalise a signal_date to a 'YYYY-MM-DD' key. signal_outcomes.signal_date is already
    a date string; unified_signals.signal_date is a timestamptz — [:10] handles both."""
    return str(x)[:10]


def _load_sector_map(conn: ConnWrapper) -> dict[str, str]:
    """symbol -> sector, loaded once (was one SELECT per outcome row → N+1)."""
    rows = conn.execute("SELECT symbol, sector FROM nse_stocks").fetchall()
    return {r[0]: (r[1] or 'OTHER') for r in rows}


def _load_regime_map(conn: ConnWrapper, cutoff: str) -> dict[tuple[str, str], str]:
    """(symbol, 'YYYY-MM-DD') -> nifty_regime for the window, loaded once (was one SELECT per
    outcome row → N+1). Bounded by the same cutoff as the outcomes query."""
    rows = conn.execute(
        "SELECT symbol, date, nifty_regime FROM technical_signals WHERE date >= ?",
        (cutoff,),
    ).fetchall()
    return {(r[0], _d10(r[1])): (r[2] or 'SIDEWAYS') for r in rows}


def _get_current_weight(
    conn: ConnWrapper, signal_type: str, regime: str, sector: str
) -> tuple[float, int]:
    row = conn.execute("""
        SELECT weight, sample_count FROM signal_type_weights
        WHERE signal_type = ? AND regime = ? AND sector = ?
    """, (signal_type, regime, sector)).fetchone()
    return (row[0], row[1]) if row else (1.0, 0)


def _upsert_weight(
    conn: ConnWrapper, signal_type: str, regime: str, sector: str,
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
    # Append-only daily trail (idempotent per day) so a historical technical-signal rescan
    # can read weights as they stood on that scan date -- see loadLearnedWeights in
    # technicalSignalsService.ts. signal_type_weights itself is overwrite-in-place.
    today = datetime.date.today().isoformat()
    conn.execute("""
        INSERT INTO signal_type_weights_history
            (snapshot_date, signal_type, regime, sector, weight, sample_count)
        VALUES (?,?,?,?,?,?)
        ON CONFLICT(snapshot_date, signal_type, regime, sector) DO UPDATE SET
            weight=excluded.weight,
            sample_count=excluded.sample_count
    """, (today, signal_type, regime, sector, round(new_weight, 6), sample_count))


def update_weights(
    conn: ConnWrapper,
    days: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, int]:
    window = DEFAULT_WINDOW_DAYS if days is None else days
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=window)).strftime('%Y-%m-%d')

    # signal_outcomes ONLY. This function learns a weight per technical PATTERN TYPE
    # (RSI_DIVERGENCE, GOLDEN_CROSS, BB_COMPRESSION, ...) parsed out of signals_json, and
    # signal_outcomes is the only table that carries those patterns.
    #
    # This used to UNION in unified_signal_outcomes "for AI/QUANT", selecting NULL AS
    # signals_json. Those rows could never contribute: _parse_signal_types(None) -> [], so every
    # one was counted in `processed` and then discarded at the accumulate step below. It was not
    # a fixable gap but a category error -- an AI or screener signal has no RSI_DIVERGENCE-style
    # type to weight, and unified_signal_outcomes has no column that could supply one. Removed
    # 2026-08-12 after confirming per-source learning already has its own correct home:
    # update_source_weights() below reads unified_signal_outcomes, groups by
    # (signal_source, regime, sector) and writes signal_source_weights -- live and populated
    # (218 rows across 6 sources). Nothing stopped being learned from; `processed` merely stopped
    # overstating what this function had actually used.
    query = """
        SELECT symbol, signal_date, horizon_days, return_pct, outcome, signals_json
        FROM signal_outcomes
        WHERE outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND return_pct IS NOT NULL
          AND signal_date >= ?
          AND signal_source = 'technical'
    """
    rows = conn.execute(query, (cutoff,)).fetchall()
    if not rows:
        print("[RewardEngine] No resolved outcomes found.")
        return {'processed': 0, 'updated': 0}

    print(f"[RewardEngine] Processing {len(rows)} resolved outcomes (window={window}d)...")

    # Batch-load the regime + sector lookups once, up front (was one SELECT each PER row → N+1
    # over the full outcomes history, which hung a dry-run >150s).
    sector_map = _load_sector_map(conn)
    regime_map = _load_regime_map(conn, cutoff)

    reward_map: dict[tuple, list[float]] = {}

    for symbol, signal_date, horizon_days, return_pct, outcome, signals_json in rows:
        reward    = _compute_reward(float(return_pct), int(horizon_days), outcome)
        regime    = regime_map.get((symbol, _d10(signal_date)), 'SIDEWAYS')
        sector    = sector_map.get(symbol, 'OTHER')
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
                  # ASCII '->' deliberately: this is the only non-ASCII char that reaches
                  # stdout, and on Windows a redirected stdout defaults to cp1252, so U+2192
                  # raised UnicodeEncodeError and killed the whole run. --dry-run was therefore
                  # unusable anywhere its output was piped or logged, which is every scheduled
                  # context. The comments in this file keep their arrows; only printed text matters.
                  f"{old_weight:.4f} -> {new_weight:.4f} (n={len(rewards)})")
            continue

        _upsert_weight(conn, signal_type, regime, sector, new_weight, new_count)
        updated += 1

    if not dry_run:
        conn.commit()

    print(f"[RewardEngine] Updated {updated} signal_type_weights rows.")
    return {'processed': len(rows), 'updated': updated}


def update_source_weights(
    conn: ConnWrapper,
    days: Optional[int] = None,
    dry_run: bool = False,
) -> dict[str, int]:
    """
    PHASE 3.6: Update per-source reward weights for multi-source learning
    Tracks performance metrics per signal source (AI, technical, quant, news)
    """
    window = DEFAULT_WINDOW_DAYS if days is None else days
    cutoff = (datetime.datetime.now() - datetime.timedelta(days=window)).strftime('%Y-%m-%d')
    query = """
        SELECT uso.signal_source, uso.outcome, uso.return_pct, uso.horizon_days,
               us.signal_date, us.symbol
        FROM unified_signal_outcomes uso
        JOIN unified_signals us ON uso.unified_signal_id = us.id
        WHERE uso.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND uso.return_pct IS NOT NULL
          AND uso.signal_source IS NOT NULL
          AND us.signal_date >= ?
    """
    rows = conn.execute(query, (cutoff,)).fetchall()
    if not rows:
        print("[RewardEngine] No unified signal outcomes found for source tracking.")
        return {'processed': 0, 'updated': 0}

    print(f"[RewardEngine] Processing {len(rows)} unified outcomes for source weights (window={window}d)...")

    # Batch-load regime + sector once (was one SELECT each PER row → N+1).
    sector_map = _load_sector_map(conn)
    regime_map = _load_regime_map(conn, cutoff)

    # Organize by (source, regime, sector)
    source_stats: dict[tuple, dict] = {}

    for signal_source, outcome, return_pct, horizon_days, signal_date, symbol in rows:
        regime = regime_map.get((symbol, _d10(signal_date)), 'SIDEWAYS')
        sector = sector_map.get(symbol, 'OTHER')
        key = (signal_source or 'unknown', regime, sector)

        if key not in source_stats:
            source_stats[key] = {
                'total': 0,
                'wins': 0,
                'losses': 0,
                'returns': [],
                'rewards': [],
            }

        source_stats[key]['total'] += 1
        reward = _compute_reward(float(return_pct), int(horizon_days), outcome)
        source_stats[key]['rewards'].append(reward)
        source_stats[key]['returns'].append(float(return_pct))

        if outcome == 'WIN':
            source_stats[key]['wins'] += 1
        elif outcome in ('LOSS', 'STOP_LOSS'):
            source_stats[key]['losses'] += 1

    updated = 0
    for (signal_source, regime, sector), stats in source_stats.items():
        if stats['total'] < MIN_SAMPLES:
            continue

        # win_rate stored as a 0-1 fraction (was incorrectly stored as 0-100 percentage,
        # which made it incomparable with every other win_rate column in the schema).
        win_rate = (stats['wins'] / stats['total']) if stats['total'] > 0 else 0
        avg_return = sum(stats['returns']) / len(stats['returns']) if stats['returns'] else 0
        avg_reward = sum(stats['rewards']) / len(stats['rewards']) if stats['rewards'] else 0

        # Calculate Sharpe ratio (simplified: reward/volatility)
        if len(stats['rewards']) > 1:
            variance = sum((r - avg_reward) ** 2 for r in stats['rewards']) / len(stats['rewards'])
            sharpe = avg_reward / (variance ** 0.5) if variance > 0 else 0
        else:
            sharpe = 0

        # Target performance multiplier: reward sources that beat 50% win-rate and have
        # positive risk-adjusted reward; penalise the rest. Centred at 1.0, clamped [0.3, 2.0].
        # Previously this was `1.0 + sharpe*0.1` which sat at ~1.0 for everything (no learning).
        target_multiplier = max(0.3, min(2.0, 1.0 + (win_rate - 0.5) * 1.5 + sharpe * 0.1))

        if not dry_run:
            now = datetime.datetime.now().isoformat()
            conn.execute("""
                INSERT INTO signal_source_weights
                    (signal_source, regime, sector, win_rate, avg_return_pct,
                     total_signals, total_wins, total_losses, avg_sharpe_ratio,
                     weight_multiplier, last_updated)
                VALUES (?,?,?,?,?,?,?,?,?,?,?)
                ON CONFLICT(signal_source, regime, sector) DO UPDATE SET
                    win_rate = excluded.win_rate,
                    avg_return_pct = excluded.avg_return_pct,
                    total_signals = excluded.total_signals,
                    total_wins = excluded.total_wins,
                    total_losses = excluded.total_losses,
                    avg_sharpe_ratio = excluded.avg_sharpe_ratio,
                    -- EMA-smooth toward the freshly computed target (excluded.weight_multiplier).
                    -- The table-qualified weight_multiplier is the existing stored value;
                    -- Postgres requires the qualification (bare name is ambiguous against
                    -- excluded) and SQLite accepts it too. Previously this referenced the
                    -- stale avg_sharpe_ratio column, so it never converged.
                    weight_multiplier = ROUND(
                        signal_source_weights.weight_multiplier * 0.85
                        + excluded.weight_multiplier * 0.15, 4),
                    last_updated = excluded.last_updated
            """, (
                signal_source,
                regime,
                sector,
                round(win_rate, 4),
                round(avg_return, 4),
                stats['total'],
                stats['wins'],
                stats['losses'],
                round(sharpe, 4),
                round(target_multiplier, 4),
                now,
            ))
            updated += 1
        else:
            print(f"  [DRY] {signal_source}|{regime}|{sector}: "
                  f"WinRate={win_rate*100:.1f}%, AvgReturn={avg_return:.2f}%, "
                  f"Sharpe={sharpe:.4f}, Mult={target_multiplier:.3f}")

    if not dry_run:
        conn.commit()

    print(f"[RewardEngine] Updated {updated} signal_source_weights rows (Phase 3.6)")
    return {'processed': len(rows), 'updated': updated}


def run(days: Optional[int] = None, dry_run: bool = False):
    conn = connect()
    try:
        # Run traditional weight updates
        update_weights(conn, days=days, dry_run=dry_run)
        # PHASE 3.6: Run source-aware weight updates
        update_source_weights(conn, days=days, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--days',    type=int, default=None)
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(days=args.days, dry_run=args.dry_run)
