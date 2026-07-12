#!/usr/bin/env python3
"""
Intraday recommendation outcome tracker — same-day paper-trade backtest.

For each intraday recommendation (entry/target/stop) on a date, simulate a long paper trade against
that date's OHLC and record whether it would have been profitable:
  - gap through target/stop at open -> fill at open
  - target hit intraday             -> WIN  (exit at target)
  - stop hit intraday               -> LOSS (exit at stop)
  - both hit (ambiguous on a daily bar) -> conservatively assume the STOP filled first
  - neither                         -> exit at close (WIN/LOSS/NEUTRAL by sign)

Writes intraday_recommendation_outcomes. Run after market close, once the day's bar is in
stock_ohlcv. Feeds the accuracy metrics + the strategy learner.

Run:  python intraday_outcome_resolver.py [--date YYYY-MM-DD]
"""
import argparse
import json
from datetime import date

from db_compat import connect

NEUTRAL_BAND = 0.2  # |pnl%| below this at a close-exit = NEUTRAL


def paper_trade(entry, tgt, stop, o, hi, lo, cl):
    """Pure same-day long paper trade. Returns (exit_price, exit_reason, pnl_pct, outcome)."""
    if not entry or entry <= 0:
        return None, None, None, None
    if o >= tgt:
        exit_p, reason = o, "TARGET_GAP"
    elif o <= stop:
        exit_p, reason = o, "STOP_GAP"
    elif hi >= tgt and lo <= stop:
        exit_p, reason = stop, "STOP"          # ambiguous on a daily bar → conservative
    elif hi >= tgt:
        exit_p, reason = tgt, "TARGET"
    elif lo <= stop:
        exit_p, reason = stop, "STOP"
    else:
        exit_p, reason = cl, "CLOSE"
    pnl = (exit_p - entry) / entry * 100.0
    if reason.startswith("TARGET") or pnl > NEUTRAL_BAND:
        outcome = "WIN"
    elif reason.startswith("STOP") or pnl < -NEUTRAL_BAND:
        outcome = "LOSS"
    else:
        outcome = "NEUTRAL"
    return round(exit_p, 2), reason, round(pnl, 3), outcome


def resolve(conn, d: str) -> dict:
    recs = conn.execute(
        "SELECT symbol, entry_price, target_1, stop_loss FROM intraday_recommendations "
        "WHERE computed_at = ? AND entry_price IS NOT NULL AND target_1 IS NOT NULL "
        "AND stop_loss IS NOT NULL", (d,)
    ).fetchall()
    if not recs:
        return {"date": d, "resolved": 0, "note": "no tradeable recs"}

    syms = [r["symbol"] for r in recs]
    ph = ",".join("?" for _ in syms)
    bars = conn.execute(
        f"SELECT symbol, open, high, low, close FROM stock_ohlcv "
        f"WHERE date = ? AND symbol IN ({ph})", (d, *syms)
    ).fetchall()
    ohlc = {b["symbol"]: b for b in bars}

    n = wins = losses = 0
    pnl_sum = 0.0
    for r in recs:
        b = ohlc.get(r["symbol"])
        if not b:
            continue
        exit_p, reason, pnl, outcome = paper_trade(
            float(r["entry_price"]), float(r["target_1"]), float(r["stop_loss"]),
            float(b["open"]), float(b["high"]), float(b["low"]), float(b["close"]))
        if exit_p is None:
            continue
        conn.execute(
            """INSERT INTO intraday_recommendation_outcomes
               (symbol, computed_at, entry_price, target_1, stop_loss, day_high, day_low,
                day_close, exit_price, exit_reason, pnl_pct, outcome, resolved_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
               ON CONFLICT(symbol, computed_at) DO UPDATE SET
                 day_high=excluded.day_high, day_low=excluded.day_low, day_close=excluded.day_close,
                 exit_price=excluded.exit_price, exit_reason=excluded.exit_reason,
                 pnl_pct=excluded.pnl_pct, outcome=excluded.outcome, resolved_at=CURRENT_TIMESTAMP""",
            (r["symbol"], d, float(r["entry_price"]), float(r["target_1"]), float(r["stop_loss"]),
             float(b["high"]), float(b["low"]), float(b["close"]), exit_p, reason, pnl, outcome))
        n += 1
        pnl_sum += pnl
        wins += outcome == "WIN"
        losses += outcome == "LOSS"
    conn.commit()
    return {"date": d, "resolved": n, "wins": wins, "losses": losses,
            "win_rate": round(wins / n * 100, 1) if n else 0.0,
            "avg_pnl_pct": round(pnl_sum / n, 3) if n else 0.0}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date.today().isoformat())
    args = ap.parse_args()
    print(json.dumps(resolve(connect(), args.date)))
