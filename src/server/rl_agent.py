"""
RL Meta-Controller (Tabular Q-Learning)
========================================
State:  (nifty_regime × sector_bucket × score_bucket) = 54 discrete states
Action: AGGRESSIVE | CONSERVATIVE | BALANCED | SECTOR_FOCUSED
Reward: trade_return_pct - nifty_return_pct  (alpha)

Q-update: Q(s,a) <- Q(s,a) + alpha * [r + gamma * max_a' Q(s',a') - Q(s,a)]

Modes:
  --update   : run daily Q-learning update from resolved episodes
  --inspect  : print current Q-table and policy per state
  --dry-run  : print updates without writing

Used by scoring_engine.py: call get_policy(conn, state_key) to get action,
then get_multipliers(action) to get per-signal-type score multipliers.
"""

import datetime, argparse, random
from typing import Optional

from db_compat import connect, use_postgres, ConnWrapper

ALPHA        = 0.10
GAMMA        = 0.85
EPSILON_INIT = 0.30
EPSILON_MIN  = 0.05
EPSILON_DECAY = 0.985

REGIMES       = ['BULL', 'SIDEWAYS', 'BEAR']
SCORE_BUCKETS = ['LOW', 'MED', 'HIGH']
SECTOR_MAP    = {
    'information technology': 'IT',
    'it':                      'IT',
    'technology':              'IT',
    'banking':                 'BANK',
    'bank':                    'BANK',
    'financial services':      'BANK',
    'pharmaceuticals':         'PHARMA',
    'pharma':                  'PHARMA',
    'healthcare':              'PHARMA',
    'automobile':              'AUTO',
    'auto':                    'AUTO',
    'automobiles':             'AUTO',
    'financials':              'BANK',
    'energy':                  'ENERGY',
    'oil':                     'ENERGY',
    'oil & gas':               'ENERGY',
    'power':                   'ENERGY',
    'infrastructure':          'INFRA',
    'capital goods':           'INFRA',
    'ports':                   'INFRA',
    'logistics':               'INFRA',
    'construction':            'INFRA',
    'cement':                  'INFRA',
    'metals':                  'METALS',
    'metal':                   'METALS',
    'steel':                   'METALS',
    'mining':                  'METALS',
    'consumer':                'CONSUMER',
    'consumer goods':          'CONSUMER',
    'fmcg':                    'CONSUMER',
    'retail':                  'CONSUMER',
    'telecom':                 'TELECOM',
    'telecommunications':      'TELECOM',
    'realty':                  'REALTY',
    'real estate':             'REALTY',
    'chemicals':               'CHEMICALS',
    'fertilizers':             'CHEMICALS',
    'textiles':                'TEXTILES',
    'media':                   'MEDIA',
    'fdi':                     'OTHER',
}

ACTIONS = ['AGGRESSIVE', 'CONSERVATIVE', 'BALANCED', 'SECTOR_FOCUSED']

_MULTIPLIERS: dict[str, dict[str, float]] = {
    'AGGRESSIVE': {
        'RSI_DIVERGENCE':      1.5,
        'RESISTANCE_BREAKOUT': 1.5,
        'WEEK_52_BREAKOUT':    1.5,
        'MACD_CROSSOVER':      1.5,
        'EMA_BULL_STACK':      1.5,
        'OVERSOLD_RECOVERY':   0.7,
        'BB_COMPRESSION':      0.7,
    },
    'CONSERVATIVE': {
        'RSI_DIVERGENCE':      0.8,
        'HIDDEN_DIVERGENCE':   0.8,
        'RESISTANCE_BREAKOUT': 0.8,
        'MACD_CROSSOVER':      0.8,
        'BB_COMPRESSION':      0.8,
        'GOLDEN_CROSS':        0.8,
        'OVERSOLD_RECOVERY':   0.8,
        'EMA_BULL_STACK':      0.8,
        'WEEK_52_BREAKOUT':    0.8,
        'BULLISH_ENGULFING':   0.8,
        'SUPERTREND_CROSS':    0.8,
        'NR7_COMPRESSION':     0.8,
        'VOLUME_ACCUMULATION': 0.8,
        'NEAR_52W_HIGH':       0.8,
        'CONSECUTIVE_STRENGTH':0.8,
        'ATR_CONTRACTION':     0.8,
        'PCR_EXTREME':         0.8,
    },
    'BALANCED': {},
    'SECTOR_FOCUSED': {
        'RSI_DIVERGENCE':      1.4,
        'EMA_BULL_STACK':      1.4,
        'GOLDEN_CROSS':        1.4,
        'BB_COMPRESSION':      0.8,
        'ATR_CONTRACTION':     0.8,
    },
}


def get_sector_bucket(sector: Optional[str]) -> str:
    if not sector:
        return 'OTHER'
    return SECTOR_MAP.get(sector.strip().lower(), 'OTHER')


def get_score_bucket(score: int) -> str:
    if score <= 5:
        return 'LOW'
    if score <= 7:
        return 'MED'
    return 'HIGH'


def get_state_key(regime: str, sector_or_bucket: str, score: int,
                  vix_bucket: str = 'LOW', fii_dir: str = 'BUY') -> str:
    regime_clean = regime if regime in REGIMES else 'SIDEWAYS'
    known_buckets = {'IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'INFRA', 'METALS',
                     'CONSUMER', 'TELECOM', 'REALTY', 'CHEMICALS', 'TEXTILES', 'MEDIA', 'OTHER'}
    sector_bucket = sector_or_bucket if sector_or_bucket in known_buckets else get_sector_bucket(sector_or_bucket)
    vix_clean = vix_bucket if vix_bucket in ('HIGH', 'LOW') else 'LOW'
    fii_clean = fii_dir    if fii_dir    in ('BUY', 'SELL') else 'BUY'
    return f"{regime_clean}_{sector_bucket}_{get_score_bucket(score)}_{vix_clean}_{fii_clean}"


def get_q(conn: ConnWrapper, state_key: str, action: str) -> float:
    row = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=? AND action=?",
        (state_key, action),
    ).fetchone()
    return float(row[0]) if row else 0.0


def get_q_for_update(conn: ConnWrapper, state_key: str, action: str) -> float:
    """Same as get_q, but on Postgres takes a row lock held until the caller's next
    commit/rollback — use immediately before a get→compute→set_q sequence so two concurrent
    invocations touching the same (state_key, action) serialize instead of one silently
    clobbering the other's update. SQLite has no row-level FOR UPDATE; its writer-serializing
    file lock across the whole update transaction already prevents the same interleaving.
    Gated on isinstance(conn, ConnWrapper) rather than the bare use_postgres() env flag —
    callers (including this module's own test suite) can pass a raw sqlite3.Connection
    directly regardless of what USE_POSTGRES says, and FOR UPDATE is invalid SQLite syntax."""
    if isinstance(conn, ConnWrapper) and use_postgres():
        row = conn.execute(
            "SELECT q_value FROM rl_q_table WHERE state_key=? AND action=? FOR UPDATE",
            (state_key, action),
        ).fetchone()
        return float(row[0]) if row else 0.0
    return get_q(conn, state_key, action)


def set_q(conn: ConnWrapper, state_key: str, action: str, value: float):
    now = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO rl_q_table (state_key, action, q_value, visit_count, last_updated)
        VALUES (?,?,?,1,?)
        ON CONFLICT(state_key, action) DO UPDATE SET
            q_value=excluded.q_value,
            visit_count=rl_q_table.visit_count+1,
            last_updated=excluded.last_updated
    """, (state_key, action, round(value, 6), now))


def get_max_q(conn: ConnWrapper, state_key: str) -> float:
    rows = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=?", (state_key,)
    ).fetchall()
    return max((float(r[0]) for r in rows), default=0.0)


def q_update(old_q: float, reward: float, next_max_q: float,
             alpha: float = ALPHA, gamma: float = GAMMA) -> float:
    return old_q + alpha * (reward + gamma * next_max_q - old_q)


def get_policy(conn: ConnWrapper, state_key: str,
               epsilon: float = 0.0) -> str:
    if random.random() < epsilon:
        return random.choice(ACTIONS)
    q_values = {a: get_q(conn, state_key, a) for a in ACTIONS}
    return max(q_values, key=lambda a: q_values[a])


def get_multipliers(action: str) -> dict[str, float]:
    return dict(_MULTIPLIERS.get(action, {}))


def log_episode(conn: ConnWrapper, date: str, state_key: str,
                action: str, epsilon: float):
    conn.execute("""
        INSERT INTO rl_episodes (date, state_key, action_taken, epsilon)
        VALUES (?,?,?,?)
    """, (date, state_key, action, round(epsilon, 4)))
    conn.commit()


def _load_epsilon(conn: ConnWrapper) -> float:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='rl_epsilon'"
    ).fetchone()
    return float(row[0]) if row else EPSILON_INIT


def _save_epsilon(conn: ConnWrapper, epsilon: float):
    conn.execute("""
        INSERT INTO app_settings (key, value, "updatedAt")
        VALUES ('rl_epsilon', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, "updatedAt"=CURRENT_TIMESTAMP
    """, (str(round(epsilon, 6)),))


def _get_vix_bucket(conn: ConnWrapper, as_of_date: str) -> str:
    """Returns 'HIGH' if India VIX > 18 on or near as_of_date, else 'LOW'."""
    try:
        d = datetime.date.fromisoformat(as_of_date[:10])
        row = conn.execute("""
            SELECT close FROM macro_asset_prices
            WHERE symbol='INDIAVIX' AND date<=?
            ORDER BY date DESC LIMIT 1
        """, (d,)).fetchone()
        if row and float(row[0] if isinstance(row, (list, tuple)) else row['close']) > 18:
            return 'HIGH'
    except Exception:
        conn.rollback()  # clear aborted-txn state so next query isn't poisoned
    return 'LOW'


def _get_fii_direction(conn: ConnWrapper, as_of_date: str) -> str:
    """Returns 'BUY' if 3-day FII net > 0 ending as_of_date, else 'SELL'."""
    try:
        d = datetime.date.fromisoformat(as_of_date[:10])
        cutoff = d - datetime.timedelta(days=5)
        row = conn.execute("""
            SELECT SUM(fii_net) AS net FROM fii_dii_flow
            WHERE date <= ? AND date > ?
        """, (d, cutoff)).fetchone()
        net = row[0] if isinstance(row, (list, tuple)) else (row['net'] if row else None)
        if net is not None and float(net) > 0:
            return 'BUY'
    except Exception:
        conn.rollback()  # clear aborted-txn state so next query isn't poisoned
    return 'SELL'


def _get_nifty_return(conn: ConnWrapper, date: str) -> float:
    # stock_ohlcv.date is a DATE column on Postgres -> bind a date object, not a string (rule #6).
    date_d = datetime.date.fromisoformat(date)
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date = ?
        ORDER BY date DESC LIMIT 1
    """, (date_d,)).fetchone()
    prev = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date < ?
        ORDER BY date DESC LIMIT 1
    """, (date_d,)).fetchone()
    if not row or not prev:
        return 0.0
    return (float(row[0]) - float(prev[0])) / float(prev[0]) * 100


def _get_nifty_horizon_return(conn: ConnWrapper, sig_date: str,
                               horizon_days: int = 15) -> float:
    """Nifty % return from sig_date to sig_date + horizon_days (the live trade window)."""
    # stock_ohlcv.date is a DATE column on Postgres -> bind date objects (rule #6).
    sig_d = datetime.date.fromisoformat(sig_date)
    end_d = sig_d + datetime.timedelta(days=horizon_days + 7)
    rows = conn.execute("""
        SELECT date, close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date BETWEEN ? AND ?
        ORDER BY date ASC
    """, (sig_d, end_d)).fetchall()
    if len(rows) < 2:
        return 0.0
    start_close = float(rows[0][1])   # first available close at or after entry
    target_end = (sig_d + datetime.timedelta(days=horizon_days)).isoformat()
    # find the last available close at or before the intended exit date. r_date is a date
    # object on PG / 'YYYY-MM-DD' text on SQLite -> normalize to str for the comparison.
    end_close = float(rows[-1][1])
    for r_date, r_close in reversed(rows):
        if str(r_date)[:10] <= target_end:
            end_close = float(r_close)
            break
    return (end_close - start_close) / start_close * 100


def _get_next_state_key(conn: ConnWrapper, state_key: str,
                         sig_date: str, horizon_days: int = 15) -> str:
    """State at trade resolution (sig_date + horizon_days)."""
    resolution = (
        datetime.date.fromisoformat(sig_date) + datetime.timedelta(days=horizon_days)
    ).isoformat()
    row = conn.execute("""
        SELECT regime FROM market_regimes WHERE date <= ? ORDER BY date DESC LIMIT 1
    """, (resolution,)).fetchone()
    if not row:
        return state_key  # no regime data: keep current state
    next_regime = row[0] if row[0] in REGIMES else 'SIDEWAYS'
    parts = state_key.split('_')
    if len(parts) < 3:
        return state_key  # malformed key — return unchanged
    parts[0] = next_regime
    return '_'.join(parts)


def daily_update(conn: ConnWrapper, dry_run: bool = False,
                 horizon_days: int = 15) -> dict[str, int]:
    # Episodes from `horizon_days` ago now have resolved signal_outcomes
    target_date = (
        datetime.date.today() - datetime.timedelta(days=horizon_days)
    ).isoformat()

    episodes = conn.execute("""
        SELECT id, date, state_key, action_taken
        FROM rl_episodes
        WHERE date = ? AND reward IS NULL
    """, (target_date,)).fetchall()

    if not episodes:
        print("[RLAgent] No episodes to update today.")
        return {'episodes': 0, 'updated': 0}

    print(f"[RLAgent] Updating {len(episodes)} episodes...")
    epsilon = _load_epsilon(conn)
    updated = 0

    for ep_id, ep_date, state_key, action in episodes:
        parts  = state_key.split('_')
        regime = parts[0] if parts else 'SIDEWAYS'

        outcomes = conn.execute("""
            SELECT so.return_pct, so.outcome FROM signal_outcomes so
            JOIN technical_signals ts ON ts.symbol=so.symbol AND ts.date=so.signal_date
            WHERE so.signal_date = ?
              AND so.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
              AND ts.nifty_regime = ?
              AND so.signal_source = 'technical'
        """, (ep_date, regime)).fetchall()

        if not outcomes:
            continue

        nifty_ret  = _get_nifty_horizon_return(conn, ep_date, horizon_days=horizon_days)
        # Apply 1.5× penalty to STOP_LOSS returns so hitting a stop is penalised
        # more heavily than a plain LOSS of similar magnitude (same logic as backfill).
        weighted = [float(r) * (1.5 if o == 'STOP_LOSS' else 1.0) for r, o in outcomes]
        avg_return = sum(weighted) / len(weighted)
        reward     = avg_return - nifty_ret

        next_state = _get_next_state_key(conn, state_key, ep_date, horizon_days=horizon_days)
        next_max   = get_max_q(conn, next_state)
        old_q      = get_q_for_update(conn, state_key, action)
        new_q      = q_update(old_q, reward, next_max)

        if dry_run:
            print(f"  [DRY] state={state_key} action={action} "
                  f"reward={reward:.3f} Q: {old_q:.4f}->{new_q:.4f}")
            updated += 1
            continue

        set_q(conn, state_key, action, new_q)
        conn.execute("UPDATE rl_episodes SET reward=? WHERE id=?",
                     (round(reward, 4), ep_id))
        updated += 1

    if updated > 0:
        new_epsilon = max(EPSILON_MIN, epsilon * EPSILON_DECAY)
        if not dry_run:
            _save_epsilon(conn, new_epsilon)
    else:
        new_epsilon = epsilon
    if not dry_run:
        conn.commit()

    print(f"[RLAgent] Updated {updated}/{len(episodes)} episodes. "
          f"epsilon={epsilon:.4f}->{new_epsilon:.4f}")
    return {'episodes': len(episodes), 'updated': updated}


def inspect_policy(conn: ConnWrapper):
    print("\nCurrent RL Policy (best action per state):\n")
    print(f"{'State':<46} {'Action':<18} {'Q-value':>8}")
    print("-" * 76)
    for regime in REGIMES:
        for sector in ['IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'INFRA', 'METALS', 'CONSUMER', 'TELECOM', 'REALTY', 'CHEMICALS', 'TEXTILES', 'MEDIA', 'OTHER']:
            for bucket in SCORE_BUCKETS:
                for vix in ('LOW', 'HIGH'):
                    for fii in ('BUY', 'SELL'):
                        sk     = f"{regime}_{sector}_{bucket}_{vix}_{fii}"
                        action = get_policy(conn, sk, epsilon=0.0)
                        best_q = get_q(conn, sk, action)
                        print(f"{sk:<46} {action:<18} {best_q:>8.4f}")


def backfill_episodes(conn: ConnWrapper, lookback_days: int = 180, dry_run: bool = False) -> dict:
    """Construct synthetic RL episodes from resolved signal_outcomes + run Q-update on each."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat()

    rows = conn.execute("""
        SELECT so.symbol, so.signal_date, so.return_pct, so.outcome,
               so.signal_score, ts.nifty_regime, ns.sector
        FROM signal_outcomes so
        LEFT JOIN technical_signals ts
               ON ts.symbol = so.symbol AND ts.date = so.signal_date
        LEFT JOIN nse_stocks ns ON ns.symbol = so.symbol
        WHERE so.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
          AND so.signal_date >= ?
          AND so.return_pct IS NOT NULL
          AND so.signal_source = 'technical'
        ORDER BY so.signal_date ASC
    """, (cutoff,)).fetchall()

    if not rows:
        print("[RLAgent] No resolved outcomes to backfill from.")
        return {'rows': 0, 'episodes_created': 0, 'q_updates': 0}

    epsilon = _load_epsilon(conn)
    episodes_created = 0
    q_updates = 0

    for sym, sig_date, ret_pct, outcome, sig_score, regime, sector in rows:
        try:
            regime    = regime or 'SIDEWAYS'
            sig_score = sig_score or 5
            sector    = sector or 'OTHER'
            vix_b = _get_vix_bucket(conn, sig_date)
            fii_d = _get_fii_direction(conn, sig_date)
            state_key = get_state_key(regime, sector, sig_score, vix_b, fii_d)

            # Use the policy that had been learned up to this point (offline Q-learning):
            # process rows chronologically so earlier backfill rows inform later ones.
            # epsilon > 0 retains exploration so the early Q-table (all zeros) doesn't
            # collapse everything to ACTIONS[0] — same epsilon decay as online updates.
            action = get_policy(conn, state_key, epsilon=epsilon)

            nifty_ret = _get_nifty_horizon_return(conn, sig_date, horizon_days=15)
            reward    = float(ret_pct) - nifty_ret
            if outcome == 'STOP_LOSS':
                reward *= 1.5

            try:
                conn.execute("""
                    INSERT INTO rl_episodes (date, state_key, action_taken, reward, epsilon)
                    VALUES (?, ?, ?, ?, ?)
                    ON CONFLICT DO NOTHING
                """, (sig_date, state_key, action, round(reward, 4), round(epsilon, 4)))
                episodes_created += 1
            except Exception:
                conn.rollback()

            next_state = _get_next_state_key(conn, state_key, sig_date, horizon_days=15)
            next_max   = get_max_q(conn, next_state)
            old_q      = get_q_for_update(conn, state_key, action)
            new_q      = q_update(old_q, reward, next_max)

            if dry_run:
                print(f"  [DRY] {sig_date} {state_key} {action} r={reward:.3f} Q:{old_q:.4f}->{new_q:.4f}")
            else:
                set_q(conn, state_key, action, new_q)
            q_updates += 1
        except Exception as _row_err:
            conn.rollback()  # clear any failed-txn state before next row

    if not dry_run:
        conn.commit()

    print(f"[RLAgent] Backfill complete: {len(rows)} outcomes -> {episodes_created} episodes, {q_updates} Q-updates")
    return {'rows': len(rows), 'episodes_created': episodes_created, 'q_updates': q_updates}


def run(mode: str = 'update', dry_run: bool = False, lookback: int = 180):
    conn = connect()
    try:
        if mode == 'inspect':
            inspect_policy(conn)
        elif mode == 'backfill':
            backfill_episodes(conn, lookback_days=lookback, dry_run=dry_run)
        else:
            daily_update(conn, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--update',   dest='mode', action='store_const', const='update', default='update')
    parser.add_argument('--inspect',  dest='mode', action='store_const', const='inspect')
    parser.add_argument('--backfill', dest='mode', action='store_const', const='backfill')
    parser.add_argument('--lookback', type=int, default=180, help='Days of history for backfill')
    parser.add_argument('--dry-run',  action='store_true')
    args = parser.parse_args()
    run(mode=args.mode, dry_run=args.dry_run, lookback=getattr(args, 'lookback', 180))
