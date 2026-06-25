#!/usr/bin/env python3
"""
Earnings Beat Feature Engine
=============================
Reads stock_earnings_beats (populated by earnings_surprise_fetcher.py) and
writes five features into technical_signals for today's date:

  eps_beat_last_q         : beat score of the most recent period  (+1 / 0 / -1)
  eps_beat_streak_4q      : consecutive beats in the last 4 periods (0-4)
  eps_miss_streak_4q      : consecutive misses in the last 4 periods (0-4)
  eps_surprise_last_yr    : actual surprise % for the most recent annual period (REAL)
  eps_estimate_dispersion : analyst disagreement for most recent annual period:
                            (eps_high − eps_low) / eps_avg  (0 = tight consensus)

Interpretation:
  eps_surprise_last_yr > 0  → EPS beat consensus → quality management signal
  eps_estimate_dispersion   → high = high uncertainty; low = tight analyst consensus
  eps_beat_streak_4q        → sustained execution quality (4 = highest conviction)
  eps_miss_streak_4q        → deteriorating guidance credibility (4 = avoid)

Run: python earnings_beat_features.py
     python earnings_beat_features.py --date 2026-06-25
"""

import os
import sys
import argparse
import datetime
from collections import defaultdict

from sqlalchemy import text

sys.path.append(os.path.dirname(os.path.abspath(__file__)))
from db_compat import get_engine, use_postgres


def compute_beat_features(conn, as_of: str) -> list[dict]:
    """
    Compute all five features per symbol using data up to `as_of` (no look-ahead).
    Annual rows contribute surprise_pct and estimate_dispersion; all rows feed streaks.
    """
    rows = conn.execute(text("""
        SELECT symbol, quarter_date, period_type, beat_score, surprise_pct,
               eps_avg, eps_high, eps_low
        FROM stock_earnings_beats
        WHERE quarter_date <= :as_of
        ORDER BY symbol, quarter_date DESC
    """), {"as_of": as_of}).fetchall()

    if not rows:
        return []

    # Group by symbol; each value is list of row dicts (already DESC by quarter_date)
    by_sym: dict[str, list[dict]] = defaultdict(list)
    for sym, qd, ptype, bscore, spct, eavg, ehi, elo in rows:
        by_sym[sym].append({
            "period_type": ptype,
            "beat_score":  int(bscore) if bscore is not None else 0,
            "surprise_pct": float(spct) if spct is not None else None,
            "eps_avg":  float(eavg) if eavg else None,
            "eps_high": float(ehi) if ehi else None,
            "eps_low":  float(elo) if elo else None,
        })

    results = []
    for sym, periods in by_sym.items():
        scores = [p["beat_score"] for p in periods]

        eps_beat_last_q = scores[0]

        beat_streak = 0
        for s in scores[:4]:
            if s > 0: beat_streak += 1
            else: break

        miss_streak = 0
        for s in scores[:4]:
            if s < 0: miss_streak += 1
            else: break

        # Annual-only features
        annual = [p for p in periods if p["period_type"] == "annual"]
        eps_surprise_last_yr = None
        eps_estimate_dispersion = None
        if annual:
            most_recent = annual[0]
            eps_surprise_last_yr = most_recent["surprise_pct"]
            if (most_recent["eps_avg"] and most_recent["eps_avg"] != 0
                    and most_recent["eps_high"] is not None
                    and most_recent["eps_low"] is not None):
                eps_estimate_dispersion = round(
                    (most_recent["eps_high"] - most_recent["eps_low"])
                    / abs(most_recent["eps_avg"]), 4
                )

        results.append({
            "symbol":                   sym,
            "eps_beat_last_q":          eps_beat_last_q,
            "eps_beat_streak_4q":       beat_streak,
            "eps_miss_streak_4q":       miss_streak,
            "eps_surprise_last_yr":     eps_surprise_last_yr,
            "eps_estimate_dispersion":  eps_estimate_dispersion,
        })

    return results


def write_features(conn, date_str: str, features: list[dict]) -> int:
    updated = 0
    for f in features:
        r = conn.execute(text("""
            UPDATE technical_signals
            SET eps_beat_last_q         = :bl,
                eps_beat_streak_4q      = :bs,
                eps_miss_streak_4q      = :ms,
                eps_surprise_last_yr    = :sl,
                eps_estimate_dispersion = :ed
            WHERE symbol = :sym AND date = :dt
        """), {
            "bl":  f["eps_beat_last_q"],
            "bs":  f["eps_beat_streak_4q"],
            "ms":  f["eps_miss_streak_4q"],
            "sl":  f["eps_surprise_last_yr"],
            "ed":  f["eps_estimate_dispersion"],
            "sym": f["symbol"],
            "dt":  date_str,
        })
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
        print(f"[EARNINGS-FEAT] {date_str}: computed {len(features)} symbols, "
              f"updated {n} technical_signals rows")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Earnings beat feature engine")
    parser.add_argument("--date", default=None, help="Signal date (YYYY-MM-DD, default today)")
    args = parser.parse_args()
    run(date_str=args.date)
