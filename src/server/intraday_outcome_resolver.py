#!/usr/bin/env python3
"""
Intraday recommendation outcome tracker — same-day paper-trade backtest on 15-minute bars.

For each intraday Buy/Strong-Buy (LONG) and Sell/Strong-Sell (SHORT) recommendation, simulate a
paper trade using ONLY the bars that occurred AFTER the signal was generated:

  entry              -> the OPEN of the first 15m bar strictly after the signal's cycle_at
  stop hit           -> LOSS (exit at stop)
  target hit         -> WIN  (exit at target)
  both in one bar    -> ambiguous within a 15m bar; conservatively assume the STOP filled first
  neither            -> exit at the session's last bar close (square-off)

Both directions are resolved and gated independently (see intraday_ranker.py's
EMISSION_GATE_SETTING_SHORT) -- a long-side edge existing says nothing about the short side,
which is a structurally different bet (fading strength vs. riding a validated reversal).

Writes intraday_recommendation_outcomes, keyed (symbol, computed_at, direction). Run after
market close, once the day's 15m bars are in intraday_ohlcv. Feeds the accuracy metrics + the
strategy learner.

WHY THIS READS intraday_ohlcv AND NOT stock_ohlcv (2026-07-31 audit)
--------------------------------------------------------------------
This resolver used to grade intraday signals against the DAILY bar from stock_ohlcv, comparing
the signal's entry/target/stop to that day's open/high/low. Those figures span 09:15 to close —
they include price action from BEFORE the signal existed. Two concrete consequences, both
measured live:

  * The daily OPEN was compared against a target computed off a price the stock reached hours
    later, manufacturing "gap" exits that were never trades: 122 STOP_GAP rows averaging
    -9.54% and 42 TARGET_GAP rows averaging +5.21%. There is no such thing as a gap on an
    intraday signal — the position is opened and closed inside one session.
  * high/low covered the whole session, so a target or stop could be recorded as "hit" by a
    move that happened before entry.

Everything downstream (the reported win rate, intraday_strategy_lifts, the accuracy metrics)
inherited the error. The 15m bars needed to do it correctly were already being collected.

Entry price: the signal's stored entry_price is the CMP at signal time, which is not a price
anyone can fill at once the signal has been computed and dispatched. We fill at the next bar's
open and re-derive target/stop as the same PERCENTAGE distances the signal intended, so what is
measured is the strategy's risk geometry rather than the incidental gap between signal and fill.

Run:  python intraday_outcome_resolver.py [--date YYYY-MM-DD]
"""
import argparse
import json
from datetime import date, datetime, timedelta, timezone

from db_compat import connect

NEUTRAL_BAND = 0.2  # |pnl%| below this at a close-exit = NEUTRAL

# Execution-cost model. Previously paper_trade() compared pure price levels with no cost at
# all, so the reported win-rate/avg-PnL was the best case, not the realistic one -- every
# other backtest path in this codebase (backtester.py) models slippage + commission.
# Intraday equity costs are lower than the positional/delivery round-trip backtester.py
# assumes (commission_bps=40/leg there): no STT on the intraday buy leg, only ~2.5bps STT on
# the sell leg, and intraday brokerage is typically flat/lower than delivery. These are
# deliberately conservative estimates (better to slightly overstate cost than understate it),
# not a precise broker-specific figure.
INTRADAY_SLIPPAGE_BPS = 10     # entry fill worse than the bar open by this much
INTRADAY_COMMISSION_BPS = 20   # charged on both entry and exit notional

_IST = timezone(timedelta(hours=5, minutes=30))
BAR_MINUTES = 15


def _parse_ts(value) -> datetime | None:
    """cycle_at / intraday_ohlcv.datetime arrive as either naive-UTC text (SQLite and the
    TEXT columns Postgres inherited from the SQLite schema) or as tz-aware datetimes
    (Postgres timestamptz). Normalise both to aware UTC so they are comparable."""
    if value is None:
        return None
    if isinstance(value, datetime):
        dt = value
    else:
        s = str(value).strip().replace(" ", "T")
        if s.endswith("Z"):
            s = s[:-1] + "+00:00"
        try:
            dt = datetime.fromisoformat(s)
        except ValueError:
            return None
    return dt.replace(tzinfo=timezone.utc) if dt.tzinfo is None else dt.astimezone(timezone.utc)


def _on_grid(dt: datetime) -> bool:
    """Reject the synthetic 'last price' quotes both vendors append to their history arrays
    stamped at request time rather than on the bar grid (zero volume, open==high==low==close).
    intraday_fetcher.py drops these at write time now, but ~2M already exist in the compressed
    hypertable and are not being backfilled out."""
    ist = dt.astimezone(_IST)
    return ist.second == 0 and ist.minute % BAR_MINUTES == 0


def paper_trade(entry, tgt, stop, bars, direction="LONG"):
    """Pure same-day paper trade over the post-entry bar sequence, long or short.

    `bars` is a chronological list of (open, high, low, close) for every 15m bar from the
    entry bar onward; bars[0] is the entry bar, and stop/target are only tested from bars[1]
    (a level cannot be "hit" by the same bar whose open filled the order without knowing the
    intra-bar path).

    direction='LONG': tgt is above entry, stop below -- profit when price rises.
    direction='SHORT': tgt is below entry, stop above -- profit when price falls. Slippage
    still fills WORSE than the bar open for whichever side you're entering (a lower price for
    a short sell, not a higher one).

    Returns (exit_price, exit_reason, pnl_pct, outcome). exit_price/exit_reason reflect the
    raw price level touched (an objective fact about what happened); pnl_pct/outcome are net
    of the cost model above.
    """
    if not entry or entry <= 0 or not bars:
        return None, None, None, None

    if direction == "SHORT":
        fill = entry * (1 - INTRADAY_SLIPPAGE_BPS / 10_000)  # sell slightly worse than the bar open
    else:
        fill = entry * (1 + INTRADAY_SLIPPAGE_BPS / 10_000)  # buy slightly worse than the bar open
    exit_p, reason = bars[-1][3], "CLOSE"
    for _o, hi, lo, _c in bars[1:]:
        if direction == "SHORT":
            if hi is not None and hi >= stop:
                exit_p, reason = stop, "STOP"  # stop wins ties: path within a 15m bar is unknown
                break
            if lo is not None and lo <= tgt:
                exit_p, reason = tgt, "TARGET"
                break
        else:
            if lo is not None and lo <= stop:
                exit_p, reason = stop, "STOP"
                break
            if hi is not None and hi >= tgt:
                exit_p, reason = tgt, "TARGET"
                break

    if direction == "SHORT":
        gross_pnl_pct = (fill - exit_p) / fill * 100.0  # profit when exit is BELOW the fill
    else:
        gross_pnl_pct = (exit_p - fill) / fill * 100.0
    cost_pct = 2 * INTRADAY_COMMISSION_BPS / 100.0  # entry leg + exit leg, in %
    pnl = gross_pnl_pct - cost_pct

    # Outcome is driven purely by net (cost-adjusted) pnl vs. NEUTRAL_BAND, not by which price
    # level was touched -- a target that barely clears costs is not a win.
    if pnl > NEUTRAL_BAND:
        outcome = "WIN"
    elif pnl < -NEUTRAL_BAND:
        outcome = "LOSS"
    else:
        outcome = "NEUTRAL"
    return round(exit_p, 2), reason, round(pnl, 3), outcome


_DIRECTION_CLASSIFICATIONS = {
    "LONG": ("Strong Buy", "Buy"),
    "SHORT": ("Strong Sell", "Sell"),
}


def _load_recs(conn, d: str, direction: str):
    """First Buy/Strong-Buy (direction='LONG') or Sell/Strong-Sell (direction='SHORT') cycle of
    the day per symbol, from the append-only history table. A symbol can have both a first-LONG
    and a first-SHORT cycle on the same day (e.g. it flips from bullish to bearish intraday) --
    each direction is resolved independently.

    intraday_recommendations is overwrite-in-place per (symbol, day), so paper-trading "the
    latest recommendation" structurally biased the evaluated entry toward whatever the LAST
    15-min cycle of the day looked like -- often near the close with no time left to reach
    target. The history table carries cycle_at, which is also what makes an honest
    post-signal-only simulation possible at all.
    """
    cls_a, cls_b = _DIRECTION_CLASSIFICATIONS[direction]
    rows = conn.execute(
        """SELECT h.symbol, h.cycle_at, h.entry_price, h.target_1, h.stop_loss
           FROM intraday_recommendations_history h
           WHERE h.computed_at = ? AND h.classification IN (?, ?)
             AND h.entry_price IS NOT NULL AND h.target_1 IS NOT NULL AND h.stop_loss IS NOT NULL
             AND h.cycle_at = (
                 SELECT MIN(h2.cycle_at) FROM intraday_recommendations_history h2
                 WHERE h2.symbol = h.symbol AND h2.computed_at = h.computed_at
                   AND h2.classification IN (?, ?)
                   AND h2.entry_price IS NOT NULL AND h2.target_1 IS NOT NULL
                   AND h2.stop_loss IS NOT NULL
             )""", (d, cls_a, cls_b, cls_a, cls_b)
    ).fetchall()
    return [dict(r) for r in rows]


def _load_bars(conn, d: str, syms: list) -> dict:
    """{symbol: [(ts, open, high, low, close), ...]} for `d`, on-grid bars only, ascending."""
    if not syms:
        return {}
    ph = ",".join("?" for _ in syms)
    start = datetime.fromisoformat(d).replace(tzinfo=_IST)
    end = start + timedelta(days=1)
    rows = conn.execute(
        f"""SELECT symbol, datetime, open, high, low, close
            FROM intraday_ohlcv
            WHERE interval = '15m' AND datetime >= ? AND datetime < ?
              AND symbol IN ({ph})
            ORDER BY symbol, datetime""",
        (start.isoformat(), end.isoformat(), *syms)
    ).fetchall()
    out: dict = {}
    for r in rows:
        ts = _parse_ts(r["datetime"])
        if ts is None or not _on_grid(ts):
            continue
        if r["open"] is None or r["close"] is None:
            continue
        out.setdefault(r["symbol"], []).append(
            (ts, float(r["open"]), float(r["high"]) if r["high"] is not None else None,
             float(r["low"]) if r["low"] is not None else None, float(r["close"])))
    for s in out:
        out[s].sort(key=lambda b: b[0])
    return out


def _resolve_direction(conn, d: str, direction: str) -> dict:
    """Resolve one direction's ('LONG' or 'SHORT') recs for date d. Returns the same shape as
    resolve() plus the list of symbols actually resolved, for that direction's purge step."""
    recs = _load_recs(conn, d, direction)
    if not recs:
        return {"resolved": 0, "wins": 0, "losses": 0, "skipped_no_bars": 0,
                "skipped_no_entry_bar": 0, "pnl_sum": 0.0, "resolved_syms": []}

    syms = sorted({r["symbol"] for r in recs})
    bars_by_sym = _load_bars(conn, d, syms)
    if not bars_by_sym:
        return {"resolved": 0, "wins": 0, "losses": 0, "skipped_no_bars": len(recs),
                "skipped_no_entry_bar": 0, "pnl_sum": 0.0, "resolved_syms": []}

    n = wins = losses = 0
    pnl_sum = 0.0
    skipped_no_bars = skipped_no_entry = 0
    resolved_syms: list = []
    for r in recs:
        series = bars_by_sym.get(r["symbol"])
        if not series:
            skipped_no_bars += 1
            continue
        cycle = _parse_ts(r["cycle_at"])
        # Entry is the first bar that OPENS after the signal was produced. A bar already in
        # progress at cycle_at cannot be entered at its open.
        fwd = [b for b in series if cycle is None or b[0] > cycle]
        if not fwd:
            skipped_no_entry += 1   # signal fired after the last bar of the session
            continue

        signal_entry = float(r["entry_price"])
        if signal_entry <= 0:
            continue
        actual_entry = fwd[0][1]
        # Preserve the signal's intended risk geometry against the price actually fillable.
        # LONG: target above entry, stop below. SHORT: target below entry, stop above --
        # tgt_pct/stop_pct are the SAME sign convention (both positive distances) either way,
        # just applied on opposite sides of actual_entry.
        if direction == "SHORT":
            tgt_pct = (signal_entry - float(r["target_1"])) / signal_entry
            stop_pct = (float(r["stop_loss"]) - signal_entry) / signal_entry
            tgt = actual_entry * (1 - tgt_pct)
            stop = actual_entry * (1 + stop_pct)
        else:
            tgt_pct = (float(r["target_1"]) - signal_entry) / signal_entry
            stop_pct = (signal_entry - float(r["stop_loss"])) / signal_entry
            tgt = actual_entry * (1 + tgt_pct)
            stop = actual_entry * (1 - stop_pct)

        ohlc = [(b[1], b[2], b[3], b[4]) for b in fwd]
        exit_p, reason, pnl, outcome = paper_trade(actual_entry, tgt, stop, ohlc, direction)
        if exit_p is None:
            continue

        # day_high/day_low/day_close are the POST-ENTRY session extremes, not the whole day's.
        # The old whole-day values were the look-ahead bug; these are what actually explains
        # the exit.
        post_high = max((b[2] for b in fwd if b[2] is not None), default=actual_entry)
        post_low = min((b[3] for b in fwd if b[3] is not None), default=actual_entry)
        conn.execute(
            """INSERT INTO intraday_recommendation_outcomes
               (symbol, computed_at, direction, entry_price, target_1, stop_loss, day_high, day_low,
                day_close, exit_price, exit_reason, pnl_pct, outcome, resolved_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)
               ON CONFLICT(symbol, computed_at, direction) DO UPDATE SET
                 entry_price=excluded.entry_price, target_1=excluded.target_1,
                 stop_loss=excluded.stop_loss,
                 day_high=excluded.day_high, day_low=excluded.day_low, day_close=excluded.day_close,
                 exit_price=excluded.exit_price, exit_reason=excluded.exit_reason,
                 pnl_pct=excluded.pnl_pct, outcome=excluded.outcome, resolved_at=CURRENT_TIMESTAMP""",
            (r["symbol"], d, direction, round(actual_entry, 2), round(tgt, 2), round(stop, 2),
             round(post_high, 2), round(post_low, 2), round(fwd[-1][4], 2),
             exit_p, reason, pnl, outcome))
        n += 1
        resolved_syms.append(r["symbol"])
        pnl_sum += pnl
        wins += outcome == "WIN"
        losses += outcome == "LOSS"

    return {"resolved": n, "wins": wins, "losses": losses, "skipped_no_bars": skipped_no_bars,
            "skipped_no_entry_bar": skipped_no_entry, "pnl_sum": pnl_sum, "resolved_syms": resolved_syms}


def resolve(conn, d: str) -> dict:
    long_res = _resolve_direction(conn, d, "LONG")
    short_res = _resolve_direction(conn, d, "SHORT")

    n = long_res["resolved"] + short_res["resolved"]
    if n == 0:
        # Distinguish "nothing to grade" from "had recs but no bars to grade them against" --
        # the latter needs intraday_fetcher.py to have run first, not a code fix.
        no_bars = long_res["skipped_no_bars"] > 0 or short_res["skipped_no_bars"] > 0
        note = "no 15m bars for this date -- run intraday_fetcher.py first" if no_bars else "no tradeable recs"
        return {"date": d, "resolved": 0, "note": note}

    # Drop any outcome row for this date+direction that this run did NOT produce. Without this,
    # rows written by the pre-2026-07-31 daily-bar implementation survive re-resolution whenever
    # a symbol can no longer be graded (e.g. its 15m bars are missing), leaving look-ahead-
    # contaminated records -- including several at pnl_pct = -100.04 from phantom STOP_GAP
    # exits -- silently mixed in with honest ones for the strategy learner to consume. Purged
    # independently per direction, same conservative rule as before: skip the purge entirely
    # for a direction that resolved nothing this run, rather than risk wiping real prior rows.
    purged = 0
    for direction, res in (("LONG", long_res), ("SHORT", short_res)):
        resolved_syms = res["resolved_syms"]
        if not resolved_syms:
            continue
        ph = ",".join("?" for _ in resolved_syms)
        cur = conn.execute(
            f"DELETE FROM intraday_recommendation_outcomes "
            f"WHERE computed_at = ? AND direction = ? AND symbol NOT IN ({ph})",
            (d, direction, *resolved_syms))
        purged += cur.rowcount if cur.rowcount and cur.rowcount > 0 else 0
    conn.commit()

    wins = long_res["wins"] + short_res["wins"]
    losses = long_res["losses"] + short_res["losses"]
    pnl_sum = long_res["pnl_sum"] + short_res["pnl_sum"]
    return {"date": d, "resolved": n, "resolved_long": long_res["resolved"],
            "resolved_short": short_res["resolved"], "wins": wins, "losses": losses,
            "skipped_no_bars": long_res["skipped_no_bars"] + short_res["skipped_no_bars"],
            "skipped_no_entry_bar": long_res["skipped_no_entry_bar"] + short_res["skipped_no_entry_bar"],
            "purged_stale": purged,
            "win_rate": round(wins / n * 100, 1) if n else 0.0,
            "avg_pnl_pct": round(pnl_sum / n, 3) if n else 0.0}


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--date", default=date.today().isoformat())
    args = ap.parse_args()
    print(json.dumps(resolve(connect(), args.date)))
