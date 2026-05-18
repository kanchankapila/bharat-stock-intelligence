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

import os, sqlite3, datetime, argparse, random
from typing import Optional

DB_PATH   = os.path.join(os.getcwd(), 'database.sqlite')

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
    'energy':                  'ENERGY',
    'oil':                     'ENERGY',
    'power':                   'ENERGY',
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


def get_state_key(regime: str, sector_or_bucket: str, score: int) -> str:
    regime_clean = regime if regime in REGIMES else 'SIDEWAYS'
    if sector_or_bucket in ('IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'OTHER'):
        sector_bucket = sector_or_bucket
    else:
        sector_bucket = get_sector_bucket(sector_or_bucket)
    if score <= 5:
        score_bucket = 'LOW'
    elif score <= 7:
        score_bucket = 'MED'
    else:
        score_bucket = 'HIGH'
    return f"{regime_clean}_{sector_bucket}_{score_bucket}"


def get_q(conn: sqlite3.Connection, state_key: str, action: str) -> float:
    row = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=? AND action=?",
        (state_key, action),
    ).fetchone()
    return float(row[0]) if row else 0.0


def set_q(conn: sqlite3.Connection, state_key: str, action: str, value: float):
    now = datetime.datetime.now().isoformat()
    conn.execute("""
        INSERT INTO rl_q_table (state_key, action, q_value, visit_count, last_updated)
        VALUES (?,?,?,1,?)
        ON CONFLICT(state_key, action) DO UPDATE SET
            q_value=excluded.q_value,
            visit_count=visit_count+1,
            last_updated=excluded.last_updated
    """, (state_key, action, round(value, 6), now))


def get_max_q(conn: sqlite3.Connection, state_key: str) -> float:
    rows = conn.execute(
        "SELECT q_value FROM rl_q_table WHERE state_key=?", (state_key,)
    ).fetchall()
    return max((float(r[0]) for r in rows), default=0.0)


def q_update(old_q: float, reward: float, next_max_q: float,
             alpha: float = ALPHA, gamma: float = GAMMA) -> float:
    return old_q + alpha * (reward + gamma * next_max_q - old_q)


def get_policy(conn: sqlite3.Connection, state_key: str,
               epsilon: float = 0.0) -> str:
    if random.random() < epsilon:
        return random.choice(ACTIONS)
    q_values = {a: get_q(conn, state_key, a) for a in ACTIONS}
    return max(q_values, key=lambda a: q_values[a])


def get_multipliers(action: str) -> dict[str, float]:
    return dict(_MULTIPLIERS.get(action, {}))


def log_episode(conn: sqlite3.Connection, date: str, state_key: str,
                action: str, epsilon: float):
    conn.execute("""
        INSERT INTO rl_episodes (date, state_key, action_taken, epsilon)
        VALUES (?,?,?,?)
    """, (date, state_key, action, round(epsilon, 4)))
    conn.commit()


def _load_epsilon(conn: sqlite3.Connection) -> float:
    row = conn.execute(
        "SELECT value FROM app_settings WHERE key='rl_epsilon'"
    ).fetchone()
    return float(row[0]) if row else EPSILON_INIT


def _save_epsilon(conn: sqlite3.Connection, epsilon: float):
    conn.execute("""
        INSERT INTO app_settings (key, value, updatedAt)
        VALUES ('rl_epsilon', ?, CURRENT_TIMESTAMP)
        ON CONFLICT(key) DO UPDATE SET value=excluded.value, updatedAt=CURRENT_TIMESTAMP
    """, (str(round(epsilon, 6)),))


def _get_nifty_return(conn: sqlite3.Connection, date: str) -> float:
    row = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date = ?
        ORDER BY date DESC LIMIT 1
    """, (date,)).fetchone()
    prev = conn.execute("""
        SELECT close FROM stock_ohlcv
        WHERE symbol IN ('NIFTY50','NIFTY','^NSEI')
          AND date < ?
        ORDER BY date DESC LIMIT 1
    """, (date,)).fetchone()
    if not row or not prev:
        return 0.0
    return (float(row[0]) - float(prev[0])) / float(prev[0]) * 100


def daily_update(conn: sqlite3.Connection, dry_run: bool = False) -> dict[str, int]:
    today = datetime.date.today().isoformat()

    episodes = conn.execute("""
        SELECT id, date, state_key, action_taken
        FROM rl_episodes
        WHERE date = ? AND reward IS NULL
    """, (today,)).fetchall()

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
            SELECT so.return_pct FROM signal_outcomes so
            JOIN technical_signals ts ON ts.symbol=so.symbol AND ts.date=so.signal_date
            WHERE so.signal_date = ?
              AND so.outcome IN ('WIN','LOSS','NEUTRAL','STOP_LOSS')
              AND ts.nifty_regime = ?
        """, (ep_date, regime)).fetchall()

        if not outcomes:
            continue

        nifty_ret  = _get_nifty_return(conn, ep_date)
        avg_return = sum(float(r[0]) for r in outcomes) / len(outcomes)
        reward     = avg_return - nifty_ret

        next_state = state_key
        next_max   = get_max_q(conn, next_state)
        old_q      = get_q(conn, state_key, action)
        new_q      = q_update(old_q, reward, next_max)

        if dry_run:
            print(f"  [DRY] state={state_key} action={action} "
                  f"reward={reward:.3f} Q: {old_q:.4f}→{new_q:.4f}")
            updated += 1
            continue

        set_q(conn, state_key, action, new_q)
        conn.execute("UPDATE rl_episodes SET reward=? WHERE id=?",
                     (round(reward, 4), ep_id))
        updated += 1

    new_epsilon = max(EPSILON_MIN, epsilon * EPSILON_DECAY)
    if not dry_run:
        _save_epsilon(conn, new_epsilon)
        conn.commit()

    print(f"[RLAgent] Updated {updated}/{len(episodes)} episodes. "
          f"epsilon={epsilon:.4f}→{new_epsilon:.4f}")
    return {'episodes': len(episodes), 'updated': updated}


def inspect_policy(conn: sqlite3.Connection):
    print("\nCurrent RL Policy (best action per state):\n")
    print(f"{'State':<30} {'Action':<18} {'Q-value':>8}")
    print("-" * 60)
    for regime in REGIMES:
        for sector in ['IT', 'BANK', 'PHARMA', 'AUTO', 'ENERGY', 'OTHER']:
            for bucket in SCORE_BUCKETS:
                sk     = f"{regime}_{sector}_{bucket}"
                action = get_policy(conn, sk, epsilon=0.0)
                best_q = get_q(conn, sk, action)
                print(f"{sk:<30} {action:<18} {best_q:>8.4f}")


def run(mode: str = 'update', dry_run: bool = False):
    if not os.path.exists(DB_PATH):
        raise FileNotFoundError(f"[RLAgent] DB not found: {DB_PATH}. Run from project root.")
    conn = sqlite3.connect(DB_PATH)
    try:
        if mode == 'inspect':
            inspect_policy(conn)
        else:
            daily_update(conn, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--update',  dest='mode', action='store_const', const='update',
                        default='update')
    parser.add_argument('--inspect', dest='mode', action='store_const', const='inspect')
    parser.add_argument('--dry-run', action='store_true')
    args = parser.parse_args()
    run(mode=args.mode, dry_run=args.dry_run)
