#!/usr/bin/env python3
"""
Earnings Beat Feature Engine
=============================
Reads stock_earnings_beats (populated by earnings_surprise_fetcher.py) and
writes three features into technical_signals for today's date:

  eps_beat_last_q    : beat score of the most recent quarter  (+1 / 0 / -1)
  eps_beat_streak_4q : consecutive beats in the last 4 quarters (0-4)
  eps_miss_streak_4q : consecutive misses in the last 4 quarters (0-4)

Interpretation:
  eps_beat_last_q > 0  → last print beat consensus → bullish quality signal
  eps_beat_streak_4q   → sustained execution quality (4 = highest conviction)
  eps_miss_streak_4q   → deteriorating guidance credibility (4 = avoid)

Run: python earnings_beat_features.py
     python earnings_beat_features.py --date 2026-06-25
"""

import os
import sys
import argparse
import datetime

from sqlalchemy import text

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from db_compat import get_engine, use_postgres


def compute_beat_features(conn, as_of: str) -> list[dict]:
    """
    For each symbol with recent beat history, compute the three features
    using quarters up to `as_of` (prevents look-ahead from future quarters).
    """
    rows = conn.execute(text("""
        SELECT symbol, quarter_date, beat_score
        FROM stock_earnings_beats
        WHERE quarter_date <= :as_of
        ORDER BY symbol, quarter_date DESC
    """), {"as_of": as_of}).fetchall()

    if not rows:
        return []

    # Group into per-symbol list (already ordered DESC by quarter_date)
    from collections import defaultdict
    by_sym: dict[str, list[int]] = defaultdict(list)
    for sym, _, beat_score in rows:
        by_sym[sym].append(int(beat_score))

    results = []
    for sym, scores in by_sym.items():
        # Most recent quarter
        eps_beat_last_q = scores[0]

        # Consecutive beat streak (last 4 quarters)
        beat_streak = 0
        for s in scores[:4]:
            if s > 0:
                beat_streak += 1
            else:
                break

        # Consecutive miss streak (last 4 quarters)
        miss_streak = 0
        for s in scores[:4]:
            if s < 0:
                miss_streak += 1
            else:
                break

        results.append({
            "symbol": sym,
            "eps_beat_last_q": eps_beat_last_q,
            "eps_beat_streak_4q": beat_streak,
            "eps_miss_streak_4q": miss_streak,
        })

    return results


def write_features(conn, date_str: str, features: list[dict]) -> int:
    if not features:
        return 0
    updated = 0
    for f in features:
        if use_postgres:
            r = conn.execute(text("""
                UPDATE technical_signals
                SET eps_beat_last_q    = :bl,
                    eps_beat_streak_4q = :bs,
                    eps_miss_streak_4q = :ms
                WHERE symbol = :sym AND date = :dt
            """), {"bl": f["eps_beat_last_q"], "bs": f["eps_beat_streak_4q"],
                   "ms": f["eps_miss_streak_4q"], "sym": f["symbol"], "dt": date_str})
            updated += r.rowcount
        else:
            r = conn.execute(text("""
                UPDATE technical_signals
                SET eps_beat_last_q    = :bl,
                    eps_beat_streak_4q = :bs,
                    eps_miss_streak_4q = :ms
                WHERE symbol = :sym AND date = :dt
            """), {"bl": f["eps_beat_last_q"], "bs": f["eps_beat_streak_4q"],
                   "ms": f["eps_miss_streak_4q"], "sym": f["symbol"], "dt": date_str})
            updated += r.rowcount
    conn.commit()
    return updated


def run(date_str: str | None = None) -> None:
    if date_str is None:
        date_str = datetime.date.today().isoformat()
    engine = get_engine()
    with engine.connect() as conn:
        features = compute_beat_features(conn, as_of=date_str)
        n = write_features(conn, date_str, features)
        print(f"[EARNINGS-FEAT] {date_str}: computed {len(features)} symbols, updated {n} technical_signals rows")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Earnings beat feature engine")
    parser.add_argument("--date", default=None, help="Signal date (YYYY-MM-DD, default today)")
    args = parser.parse_args()
    run(date_str=args.date)
