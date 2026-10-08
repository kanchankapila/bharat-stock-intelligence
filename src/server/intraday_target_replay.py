"""Cost-aware what-if for the intraday target distance (AF-20261008-03). Read-only.

`intraday_recommendation_outcomes` stores each trade's day high / low / close, so the target can
be re-placed at a multiple of its published distance and the day re-graded: the stop is tested
first when a day touches both (the day bars carry no ordering), cost is the platform round trip.
It reproduces the stored outcomes before it is trusted for a what-if (see measurement.md).

    python src/server/intraday_target_replay.py
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from outcome_resolver import ROUND_TRIP_COST_PCT  # noqa: E402

MULTS = (1.0, 0.75, 0.5, 0.4, 0.3, 0.25)


def replay_trade(row, mult, cost=ROUND_TRIP_COST_PCT):
    """row: (direction, entry, target, stop, day_high, day_low, day_close). Returns (kind, net %)."""
    side, e, t, s, hi, lo, cl = row
    long = str(side).upper() == 'LONG'
    sign = 1 if long else -1
    tgt = e * (1 + sign * abs(t - e) / e * mult)
    stop_hit = lo <= s if long else hi >= s
    tgt_hit = hi >= tgt if long else lo <= tgt
    if stop_hit:
        return 'STOP', sign * (s - e) / e * 100 - cost
    if tgt_hit:
        return 'TARGET', sign * (tgt - e) / e * 100 - cost
    return 'CLOSE', sign * (cl - e) / e * 100 - cost


def summarise(rows, side, mult, cost=ROUND_TRIP_COST_PCT):
    res = [replay_trade(r, mult, cost) for r in rows if str(r[0]).upper() == side]
    n = len(res)
    if not n:
        return {'n': 0, 'target': 0.0, 'stop': 0.0, 'net': 0.0}
    return {'n': n,
            'target': 100.0 * sum(k == 'TARGET' for k, _ in res) / n,
            'stop': 100.0 * sum(k == 'STOP' for k, _ in res) / n,
            'net': sum(r for _, r in res) / n}


def main():
    from db_compat import connect
    conn = connect()
    try:
        rows = conn.execute("""
            SELECT direction, entry_price, target_1, stop_loss, day_high, day_low, day_close
            FROM intraday_recommendation_outcomes
            WHERE entry_price > 0 AND target_1 > 0 AND stop_loss > 0 AND day_high > 0 AND day_low > 0
        """).fetchall()
    finally:
        conn.close()
    for side in ('LONG', 'SHORT'):
        for m in MULTS:
            r = summarise(rows, side, m)
            print(f"{side:5s} target x{m:<4} n={r['n']} target={r['target']:5.1f}% "
                  f"stop={r['stop']:5.1f}% net={r['net']:+.3f}%")


if __name__ == '__main__':
    main()
