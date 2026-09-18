#!/usr/bin/env python3
"""
Intraday strategy learner — reverse-engineers which signals precede profitable intraday trades.

Joins resolved paper-trade outcomes (intraday_recommendation_outcomes) back to the signals present
on each recommendation (breakout, news, regime, screener breadth, conviction) and computes, per
signal bucket, the paper-trade win rate and its LIFT over the base win rate — i.e. which setups
actually pay here, learned from realized outcomes rather than assumed.

Writes intraday_strategy_lifts and, with enough trades, shadow candidate weights to
app_settings.intraday_candidate_weights. These in-sample bucket statistics do NOT validate a
new trading policy. The scheduled learner must never overwrite intraday_learned_weights;
promotion requires independent, cost-aware comparison of stored candidate/incumbent decisions.

Run:  python intraday_strategy_learner.py [--days 60]
"""
import argparse
import json
from datetime import date, timedelta

from db_compat import connect

MIN_TRADES = 100        # minimum for a shadow candidate, NOT evidence for promotion
MIN_BUCKET = 15         # ignore buckets thinner than this when learning weights


def _bucket_rows(rows):
    """Yield (dimension, bucket, is_win, pnl) for every signal dimension of each outcome row."""
    for r in rows:
        win = 1 if r["outcome"] == "WIN" else 0
        pnl = float(r["pnl_pct"] or 0)

        bo = r["breakout_score"]
        yield "breakout", ("high" if bo is not None and bo >= 60 else "low" if bo is not None else "none"), win, pnl

        nw = r["news_sentiment"]
        yield "news", ("positive" if nw is not None and nw > 0.2 else "negative" if nw is not None and nw < -0.2 else "neutral"), win, pnl

        yield "regime", (r["intraday_regime"] or "NEUTRAL"), win, pnl

        bull = int(r["bullish_count"] or 0)
        yield "screener_breadth", ("multi" if bull >= 2 else "single" if bull == 1 else "none"), win, pnl

        yield "conviction", (r["conviction_level"] or "?"), win, pnl


def run(conn=None, days: int = 60) -> dict:
    conn = conn or connect()
    cutoff = (date.today() - timedelta(days=days)).isoformat()
    # Match the resolver's first eligible LONG cycle, never the mutable latest-cycle
    # recommendation. Later regime/news values were unavailable at the resolved entry.
    # Short-side outcomes are deliberately separate; unresolved rows are not losses.
    rows = conn.execute(
        """SELECT o.outcome, o.pnl_pct, r.breakout_score, r.news_sentiment, r.intraday_regime,
                  r.bullish_count, r.conviction_level
           FROM intraday_recommendation_outcomes o
            JOIN intraday_recommendations_history r
              ON r.symbol = o.symbol AND r.computed_at = o.computed_at
             AND r.classification IN ('Buy', 'Strong Buy')
             AND r.entry_price IS NOT NULL AND r.target_1 IS NOT NULL AND r.stop_loss IS NOT NULL
             AND r.cycle_at = (
                 SELECT MIN(h.cycle_at) FROM intraday_recommendations_history h
                 WHERE h.symbol = o.symbol AND h.computed_at = o.computed_at
                   AND h.classification IN ('Buy', 'Strong Buy')
                   AND h.entry_price IS NOT NULL AND h.target_1 IS NOT NULL AND h.stop_loss IS NOT NULL
             )
            WHERE o.computed_at >= ? AND o.direction = 'LONG'
              AND o.outcome IN ('WIN', 'LOSS')""", (cutoff,)
    ).fetchall()

    total = len(rows)
    if total == 0:
        print(json.dumps({"trades": 0, "note": "no resolved intraday outcomes yet — learner idle"}))
        return {"trades": 0}

    base_win = sum(1 for r in rows if r["outcome"] == "WIN") / total

    # Aggregate per (dimension, bucket).
    agg = {}
    for dim, bucket, win, pnl in _bucket_rows(rows):
        a = agg.setdefault((dim, bucket), {"n": 0, "wins": 0, "pnl": 0.0})
        a["n"] += 1
        a["wins"] += win
        a["pnl"] += pnl

    today = date.today().isoformat()
    cur = conn.cursor()
    lifts = {}  # dimension -> {bucket: lift}
    for (dim, bucket), a in agg.items():
        wr = a["wins"] / a["n"]
        lift = wr / base_win if base_win > 0 else 1.0
        avg_pnl = a["pnl"] / a["n"]
        cur.execute(
            """INSERT INTO intraday_strategy_lifts (as_of, dimension, bucket, n, wins, win_rate, lift, avg_pnl)
               VALUES (?,?,?,?,?,?,?,?)
               ON CONFLICT(as_of, dimension, bucket) DO UPDATE SET
                 n=excluded.n, wins=excluded.wins, win_rate=excluded.win_rate,
                 lift=excluded.lift, avg_pnl=excluded.avg_pnl""",
            (today, dim, bucket, a["n"], a["wins"], round(wr, 4), round(lift, 3), round(avg_pnl, 3)))
        if a["n"] >= MIN_BUCKET:
            lifts.setdefault(dim, {})[bucket] = lift
    conn.commit()

    # In-sample lift proposes a candidate; it cannot authorize a live-policy change.
    # Keep the incumbent untouched until a separate prospective comparison supports promotion.
    published = False
    candidate_written = False
    if total >= MIN_TRADES:
        bo_lift = (lifts.get("breakout", {}).get("high", 1.0))
        nw_lift = (lifts.get("news", {}).get("positive", 1.0))
        w_breakout = max(0.25, min(0.65, 0.45 * bo_lift))
        w_screener = max(0.35, 1.0 - w_breakout)
        news_tilt = max(0.05, min(0.30, 0.15 * nw_lift))
        conn.execute(
            """INSERT INTO app_settings(key, value) VALUES('intraday_candidate_weights', ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (json.dumps({"W_BREAKOUT": round(w_breakout, 3), "W_SCREENER": round(w_screener, 3),
                         "NEWS_TILT_WEIGHT": round(news_tilt, 3), "base_win": round(base_win, 3),
                         "trades": total, "as_of": today,
                         "status": "SHADOW_ONLY", "validation": "IN_SAMPLE_ONLY"}),))
        conn.commit()
        candidate_written = True

    # Print the strongest learned edges (the "what actually worked" readout).
    top = sorted(
        ((d, b, agg[(d, b)]["n"], agg[(d, b)]["wins"] / agg[(d, b)]["n"] / base_win if base_win else 1.0)
         for (d, b) in agg if agg[(d, b)]["n"] >= MIN_BUCKET),
        key=lambda x: x[3], reverse=True)[:6]
    print(json.dumps({
        "trades": total, "base_win_rate": round(base_win * 100, 1),
        "weights_published": published,
        "candidate_written": candidate_written,
        "promotion_blocked_reason": "Independent cost-aware policy validation required",
        "top_edges": [{"dimension": d, "bucket": b, "n": n, "lift": round(l, 2)} for d, b, n, l in top],
    }))
    return {"trades": total, "published": published, "candidate_written": candidate_written}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    args = ap.parse_args()
    run(days=args.days)
