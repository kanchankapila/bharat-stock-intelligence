#!/usr/bin/env python3
"""
Intraday strategy learner — reverse-engineers which signals precede profitable intraday trades.

Joins resolved paper-trade outcomes (intraday_recommendation_outcomes) back to the signals present
on each recommendation (breakout, news, regime, screener breadth, conviction) and computes, per
signal bucket, the paper-trade win rate and its LIFT over the base win rate — i.e. which setups
actually pay here, learned from realized outcomes rather than assumed.

Writes intraday_strategy_lifts. Once enough trades have accumulated (MIN_TRADES) it also publishes
learned blend weights to app_settings.intraday_learned_weights so intraday_ranker leans harder on
whatever is actually working — the loop that lets the strategy improve over time.

Run:  python intraday_strategy_learner.py [--days 60]
"""
import polars as pl
from workflow_orchestrator import WorkflowDAG, TaskNode
import argparse
import json
from datetime import date, timedelta

from db_compat import connect

MIN_TRADES = 100        # don't publish learned weights until the sample is meaningful
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
    # LONG only (o.direction filter, added 2026-08 alongside the Sell-side emission gate): a
    # symbol/day can now have both a LONG and a SHORT outcome row, and without this filter the
    # join would return both against the SAME intraday_recommendations row, silently doubling
    # that symbol/day's weight and conflating "this signal preceded a good long" with "this
    # signal preceded a good short" under one bucket -- two different bets this codebase treats
    # as unrelated (see intraday_ranker.py's EMISSION_GATE_SETTING_SHORT docstring). Learning
    # short-side signal lifts separately is real future work, not silently folded in here.
    rows = conn.execute(
        """SELECT o.outcome, o.pnl_pct, r.breakout_score, r.news_sentiment, r.intraday_regime,
                  r.bullish_count, r.conviction_level
           FROM intraday_recommendation_outcomes o
           JOIN intraday_recommendations r ON r.symbol = o.symbol AND r.computed_at = o.computed_at
           WHERE o.computed_at >= ? AND o.direction = 'LONG'""", (cutoff,)
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

    # Publish learned blend weights once the sample is meaningful. Scale each component's default
    # weight by how much its "favourable" bucket beats the base rate (clamped so no single signal
    # can dominate). Falls back silently to the ranker defaults until then.
    published = False
    if total >= MIN_TRADES:
        bo_lift = (lifts.get("breakout", {}).get("high", 1.0))
        nw_lift = (lifts.get("news", {}).get("positive", 1.0))
        w_breakout = max(0.25, min(0.65, 0.45 * bo_lift))
        w_screener = max(0.35, 1.0 - w_breakout)
        news_tilt = max(0.05, min(0.30, 0.15 * nw_lift))
        conn.execute(
            """INSERT INTO app_settings(key, value) VALUES('intraday_learned_weights', ?)
               ON CONFLICT(key) DO UPDATE SET value=excluded.value""",
            (json.dumps({"W_BREAKOUT": round(w_breakout, 3), "W_SCREENER": round(w_screener, 3),
                         "NEWS_TILT_WEIGHT": round(news_tilt, 3), "base_win": round(base_win, 3),
                         "trades": total, "as_of": today}),))
        conn.commit()
        published = True

    # Print the strongest learned edges (the "what actually worked" readout).
    top = sorted(
        ((d, b, agg[(d, b)]["n"], agg[(d, b)]["wins"] / agg[(d, b)]["n"] / base_win if base_win else 1.0)
         for (d, b) in agg if agg[(d, b)]["n"] >= MIN_BUCKET),
        key=lambda x: x[3], reverse=True)[:6]
    print(json.dumps({
        "trades": total, "base_win_rate": round(base_win * 100, 1),
        "weights_published": published,
        "top_edges": [{"dimension": d, "bucket": b, "n": n, "lift": round(l, 2)} for d, b, n, l in top],
    }))
    return {"trades": total, "published": published}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--days", type=int, default=60)
    args = ap.parse_args()
    run(days=args.days)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector math."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
