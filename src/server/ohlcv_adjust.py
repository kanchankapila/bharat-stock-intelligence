#!/usr/bin/env python3
"""
Split/bonus adjustment factors for raw NSE bhavcopy prices.

WHY THIS EXISTS
---------------
`nse_bhavcopy_fetcher.py` gave us the point-in-time traded universe (nse_universe_history,
3.24M rows back to 2021), which closed the *tradability* half of the survivorship problem --
backtester.filter_to_traded_universe() already uses it. The *price* half stayed blocked: the
~306 genuinely-delisted companies have no rows in stock_ohlcv at all, so a backtest still
cannot trade them, and simply unioning bhavcopy prices in would reintroduce the mixed
adjustment-basis seam the 2026-07-30 audit flagged -- bhavcopy is RAW while stock_ohlcv is
split-adjusted, so every split would read as a real gap-down.

This module removes that blocker WITHOUT needing a corporate-actions feed. The `corporate_actions`
table was checked and is unusable for it: 353 rows, dividends and results only, no splits or
bonuses, spanning six weeks (2026-06-30..2026-08-13).

THE MECHANISM
-------------
NSE's bhavcopy PREV_CLOSE is the RAW previous close -- the exchange does NOT adjust it on an
ex-date. Verified against known splits: NESTLEIND's 1:10 on 2024-01-05 shows
prev_close=27116.4 alongside close=2666.4, and IRCTC's 1:5 on 2021-10-28 shows
prev_close=4130.15 with close=913.5. So the corporate action appears as a discontinuity
*within a single row*:

    factor(t) = close(t) / prev_close(t)

which is ~1.0 on an ordinary day and ~the action's ratio on an ex-date (NESTLEIND: 0.0983,
i.e. 1/10 plus that day's small real return).

Comparing within one row is what makes this robust: there is no dependence on the previous
row, so trading gaps, delistings and sessions missing from the table cannot produce phantom
events. (An earlier version of this module compared prev_close(t) against close(t-1) on the
assumption that PREV_CLOSE was adjusted. That assumption is false -- it made every real split
invisible while surfacing large clusters of artifacts on dates following a missing session.
It was caught only by testing against a known split, which is why the live test below pins
NESTLEIND and IRCTC explicitly.)

Back-adjusting a historical bar then means multiplying it by the product of every factor that
occurred AFTER it, which puts the whole series on today's share basis -- the same convention
stock_ohlcv already uses (`adjustment_basis='split_only'`).

GUARDS (these are the load-bearing part -- a spurious factor corrupts a whole series)
-------------------------------------------------------------------------------------
1. THE RANGE TEST, which is what separates a split from a crash. On an ex-date the whole
   session trades on the new basis, so open/high/low all move with close: NESTLEIND's
   high/prev_close was 0.1016 against a close/prev_close of 0.0983. On a genuine 20% fall the
   high stays up near the previous close (BANDHANBNK 2026-07-22: close/prev 0.8308 but
   high/prev 0.9205). Without this, any circuit-limit move that happens to land on a clean
   ratio is read as a split -- AASTHA closed at exactly 0.8000 of its previous close, a
   textbook 1:4 bonus ratio, with high/prev = 1.0334 proving it was just a bad day.
2. A price floor. On a sub-rupee stock the tick is a large fraction of the price, so rounding
   alone manufactures convincing ratios (BLUECHIP 0.90 -> 2.15 = "2.3889").
3. The factor must land within RATIO_TOL of a real corporate-action ratio -- small integers
   only. Allowing denominators up to ~50 makes the rational grid so dense that a 2% tolerance
   matches essentially any number, which is not a guard at all.
4. Deviations under DEADBAND are ordinary price movement, not corporate actions.

Anything that fails is left unadjusted rather than guessed at, and reported, so a missed
corporate action shows up as a known gap instead of a silent wrong price.

Run:
  python ohlcv_adjust.py --report            # what would be detected, writes nothing
  python ohlcv_adjust.py --persist           # write ohlcv_adjustment_factors
"""

import polars as pl
import argparse
import sys
from datetime import date
from fractions import Fraction

from db_compat import connect, ConnWrapper

# Below this price, tick rounding dominates and a "ratio" is not evidence of anything.
MIN_PRICE = 5.0
# A prev_close/close discontinuity smaller than this is NOT treated as a corporate action.
#
# This is set at 15%, not at rounding noise, on purpose. The comparison assumes the previous
# ROW is the previous SESSION, and that assumption breaks whenever a session is missing from
# the table -- in which case the "factor" is just a real multi-day price move. That is not
# hypothetical: nse_universe_history was found to be missing NSE's live Union Budget session
# on Sunday 2026-02-01 entirely (the fetcher skipped weekends; now fixed), which made several
# hundred symbols show a bogus 0.93-1.08 "ratio" on the following Monday.
#
# No real corporate action is that small -- the least aggressive common ones are a 5:4 bonus
# (0.80) or 6:5 (0.833) -- so this band separates the two cleanly and makes the detector
# robust to a missing session from ANY cause, not just the one already fixed.
DEADBAND = 0.15
# How close to a clean corporate-action ratio the observed factor must land.
RATIO_TOL = 0.025

# Real Indian split/bonus/consolidation ratios are small integers. The extras cover
# penny-stock consolidations (1:100) and gold-ETF style splits (1:1000).
_SMALL = list(range(1, 11))
_EXTRA = [20, 25, 50, 100, 1000]


def _plausible_ratios():
    """Clean corporate-action ratios, excluding any that fall inside the DEADBAND.

    The two families are built SEPARATELY on purpose. The large denominators exist only for
    deep splits and consolidations (1:100, 1:1000), so they are combined with 1 alone --
    crossing them with every numerator invents ratios no company has ever declared and makes
    the grid so dense the snap stops filtering anything. That bug was live: 9/25 = 0.36 and
    7/20 = 0.35 were both accepted as "clean", leaving no gap between 1/3 and 2/5 at all.

    A ratio inside the deadband is dropped too -- unreachable by construction, and keeping it
    would let a near-1.0 artifact snap onto e.g. 10/9.
    """
    vals = set()
    # Bonus / small-split ratios: p:q with both small (1/2, 2/3, 3/4, 5/6, 3/8, ...).
    for p in _SMALL:
        for q in _SMALL:
            vals.add(float(Fraction(p, q)))
    # Deep splits and consolidations: 1/k and k/1 only.
    for k in _SMALL + _EXTRA:
        vals.add(float(Fraction(1, k)))
        vals.add(float(k))
    return sorted(f for f in vals
                  if 0.0005 <= f <= 2000 and abs(f - 1.0) > DEADBAND)


PLAUSIBLE = _plausible_ratios()


def snap_to_ratio(factor: float, tol: float = RATIO_TOL):
    """Return the clean corporate-action ratio this factor represents, or None.

    Snapping (rather than using the raw quotient) means a real 1:10 split is applied as
    exactly 0.1 instead of 0.1001, so repeated adjustments don't accumulate drift.
    """
    if factor is None or factor <= 0:
        return None
    best, best_err = None, None
    for r in PLAUSIBLE:
        err = abs(factor - r) / r
        if best_err is None or err < best_err:
            best, best_err = r, err
    if best_err is not None and best_err <= tol:
        return best
    return None


def detect_adjustment_events(rows) -> tuple[list, list]:
    """Find corporate-action factors in one symbol's bars.

    `rows` is an iterable of (date, prev_close, open, high, low, close). Every test is WITHIN a
    single row, so trading gaps and missing sessions cannot fabricate events.

    Returns (accepted, rejected); accepted factors are SNAPPED to the clean ratio so repeated
    adjustments don't accumulate drift, and rejections are reported rather than silently
    dropped so a genuinely missed action stays visible.
    """
    accepted, rejected = [], []
    for row in rows:
        d = row[0]
        try:
            vals = [float(x) if x is not None else None for x in row[1:6]]
        except (TypeError, ValueError):
            continue
        prev_close, open_, high, low, close = vals
        if not prev_close or not close or prev_close <= 0 or close <= 0:
            continue

        raw = close / prev_close
        if abs(raw - 1.0) <= DEADBAND:
            continue

        if prev_close < MIN_PRICE or close < MIN_PRICE:
            rejected.append((d, raw, 'below_price_floor'))
            continue

        # CIRCUIT-LOCK TEST. A stock locked at its price band trades at a single price all
        # day (open == high == low == close), and that price is exactly prev_close x the band
        # -- 1.20 or 0.80 at the 20% limit, which are also perfectly plausible corporate-action
        # ratios (6:5 consolidation, 1:4 bonus). Such a day passes the range test below, since
        # the whole "range" is on the new level by construction. Before this guard, 1.2 was the
        # single most common detected "ratio" in the entire history (99 events) with 0.8 close
        # behind -- i.e. the detector was mostly finding circuit locks.
        # A genuine ex-date trades in a real range (NESTLEIND high 2754 vs low 2642.45;
        # IRCTC 983 vs 810), so requiring a non-degenerate range separates them cleanly.
        if high is not None and low is not None and high <= low:
            rejected.append((d, raw, 'circuit_locked_zero_range'))
            continue

        # THE RANGE TEST. On an ex-date the entire session trades on the new basis; on a
        # merely-large move the day's extreme stays near the previous close.
        if raw < 1.0:
            if high is None or high / prev_close > 1.0 - DEADBAND:
                rejected.append((d, raw, 'range_touches_old_basis'))
                continue
        else:
            if low is None or low / prev_close < 1.0 + DEADBAND:
                rejected.append((d, raw, 'range_touches_old_basis'))
                continue

        # Snap off the OPEN, not the close. Both sit on the new basis, but the open carries
        # only the opening gap while the close carries the whole session's real return -- and
        # that difference decides whether a real action is recognised. IRCTC's 1:5 rose 10.6%
        # on its ex-date, so close/prev_close is 0.2212 (missing 1/5 by more than any safe
        # tolerance) while open/prev_close is 0.1978, a 1.1% miss. NESTLEIND: 0.1016 vs 0.1.
        basis = (open_ / prev_close) if (open_ and open_ > 0) else raw
        snapped = snap_to_ratio(basis)
        if snapped is None:
            rejected.append((d, basis, 'not_a_clean_ratio'))
        else:
            accepted.append((d, snapped))
    return accepted, rejected


def cumulative_factor_map(events: list, dates: list) -> dict:
    """{date: multiplier} putting every bar on the LATEST share basis.

    A bar dated d is multiplied by the product of all factors with ex_date > d. Bars on or
    after the final event get 1.0. Walking backwards keeps this O(n) and, critically, means
    the most recent bars are never touched -- so today's prices always match the exchange.
    """
    if not dates:
        return {}
    ev = sorted(events, key=lambda e: e[0])
    out, running, i = {}, 1.0, len(ev) - 1
    for d in sorted(dates, reverse=True):
        while i >= 0 and ev[i][0] > d:
            running *= ev[i][1]
            i -= 1
        out[d] = running
    return out


def adjust_symbol(rows) -> dict:
    """{date: multiplier} for one symbol's (date, prev_close, open, high, low, close) rows."""
    accepted, _ = detect_adjustment_events(rows)
    if not accepted:
        return {}
    return cumulative_factor_map(accepted, [r[0] for r in rows])


# NOTE -- a same-date "cluster" guard used to live here and was REMOVED deliberately.
#
# It made sense against the old cross-row method, where a session missing from the table
# produced a whole market's worth of phantom events on the following date. The within-row
# method cannot do that: prev_close and close come from the same row, so a missing session is
# invisible to it, and a market-wide crash is caught by the range test instead.
#
# Left in place it was actively harmful. India sees roughly 700 corporate actions a year over
# ~250 sessions -- about 3 per day -- so several unrelated companies sharing an ex-date is the
# NORMAL base rate, not an anomaly. The guard was silently discarding real ones: IRCTC's 1:5
# on 2021-10-28 was detected correctly at exactly 0.2 and then thrown away because four other
# companies happened to have actions the same day.

# ── authoritative cross-validation (2026-08-07) ─────────────────────────────
#
# mc_corporate_actions_fetcher.py closed the gap this module's own docstring named as the
# reason it had to reverse-derive ratios in the first place ("the corporate_actions table was
# checked and is unusable for it ... no splits or bonuses" -- true of that table, but that
# table was never meant to carry deep history; see the new fetcher's docstring). This section
# is deliberately ADDITIVE, not a replacement for detect_adjustment_events(): the guards above
# are the load-bearing, already-proven-correct part of this module, and an authoritative feed
# can itself be wrong (a bad scId resolution, a malformed row) -- so an authoritative event is
# only ever used to FILL a genuine gap the heuristic left, never to silently override an
# existing heuristic-detected factor. A disagreement between the two is reported, exactly like
# a rejected heuristic event, not auto-resolved either way.

DATE_WINDOW_DAYS = 5  # ex-date vs record-date / weekend slack between the two sources


def cross_validate_with_mc_actions(conn: ConnWrapper, persist: bool = False) -> dict:
    """Compare `stock_corporate_action_history`'s authoritative bonus/split ratios against
    `ohlcv_adjustment_factors`, the heuristic detector's output.

    Three outcomes per authoritative (symbol, ex-date, ratio) event:
      - confirmed: an existing heuristic factor within RATIO_TOL sits within DATE_WINDOW_DAYS
        of the authoritative date. No write.
      - filled: NO heuristic factor exists for that symbol anywhere in the window -- a genuine
        gap (the price-ratio detector's guards rejected it, or bhavcopy was missing the
        session). Inserted with source='mc_corporate_action' when persist=True, so
        backtester.load_bhavcopy_adjusted() picks it up.
      - disagreement: a heuristic factor DOES exist in the window but its value doesn't match
        the authoritative one -- NEVER auto-resolved (either side could be the one that's
        wrong; overwriting risks double-adjusting a bar that the heuristic's own factor was
        already correctly applied to). Reported only, matching this module's stated philosophy
        of reporting an uncertain case rather than guessing.
    """
    mc_events = conn.execute(
        "SELECT symbol, record_date, ratio_factor, ratio_text, action_type "
        "FROM stock_corporate_action_history "
        "WHERE action_type IN ('bonus','split') AND ratio_factor IS NOT NULL "
        "AND record_date IS NOT NULL"
    ).fetchall()
    existing = conn.execute("SELECT symbol, ex_date, factor FROM ohlcv_adjustment_factors").fetchall()

    by_symbol: dict[str, list[tuple[str, float]]] = {}
    for r in existing:
        by_symbol.setdefault(r[0], []).append((r[1], r[2]))

    confirmed, filled, disagreement = [], [], []
    for row in mc_events:
        sym, rdate_s, factor, ratio_text, atype = row[0], row[1], row[2], row[3], row[4]
        try:
            rdate = date.fromisoformat(str(rdate_s)[:10])
            factor = float(factor)
        except (TypeError, ValueError):
            continue

        nearby = []
        for ex_date_s, ex_factor in by_symbol.get(sym, []):
            try:
                ex_date = date.fromisoformat(str(ex_date_s)[:10])
            except (TypeError, ValueError):
                continue
            if abs((ex_date - rdate).days) <= DATE_WINDOW_DAYS:
                nearby.append((ex_date_s, ex_factor))

        close = [ (d, f) for d, f in nearby
                  if f is not None and f > 0 and abs(float(f) - factor) / factor <= RATIO_TOL ]
        if close:
            confirmed.append((sym, rdate_s, atype, factor, ratio_text))
        elif nearby:
            disagreement.append((sym, rdate_s, atype, factor, ratio_text, nearby))
        else:
            filled.append((sym, rdate_s, atype, factor, ratio_text))

    if persist and filled:
        ensure_schema(conn)
        for sym, d, atype, factor, ratio_text in filled:
            conn.execute(
                "INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor, source) "
                "VALUES (?,?,?,'mc_corporate_action') "
                "ON CONFLICT (symbol, ex_date) DO UPDATE SET "
                "factor=excluded.factor, source=excluded.source",
                (sym, d, factor),
            )
        conn.commit()

    return {'confirmed': confirmed, 'filled': filled, 'disagreement': disagreement}


# ── persistence ──────────────────────────────────────────────────────────────

def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS ohlcv_adjustment_factors (
            symbol   TEXT NOT NULL,
            ex_date  TEXT NOT NULL,
            factor   REAL NOT NULL,
            source   TEXT DEFAULT 'bhavcopy_prev_close',
            PRIMARY KEY (symbol, ex_date)
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_oaf_symbol ON ohlcv_adjustment_factors (symbol)")
    conn.commit()


def scan(conn: ConnWrapper, persist: bool = False) -> dict:
    rows = conn.execute(
        "SELECT symbol, date, prev_close, open, high, low, close FROM nse_universe_history "
        "WHERE series IN ('EQ','BE') ORDER BY symbol, date"
    ).fetchall()

    by_symbol = {}
    for r in rows:
        # db_compat.Row is a dict subclass -- it supports int and name keys but NOT slicing.
        by_symbol.setdefault(r[0], []).append((r[1], r[2], r[3], r[4], r[5], r[6]))

    all_accepted, all_rejected = [], []
    for sym, srows in by_symbol.items():
        acc, rej = detect_adjustment_events(srows)
        all_accepted += [(sym, d, f) for d, f in acc]
        all_rejected += [(sym, d, f, why) for d, f, why in rej]


    if persist and all_accepted:
        ensure_schema(conn)
        for sym, d, f in all_accepted:
            conn.execute(
                "INSERT INTO ohlcv_adjustment_factors (symbol, ex_date, factor) VALUES (?,?,?) "
                "ON CONFLICT (symbol, ex_date) DO UPDATE SET factor=excluded.factor",
                (sym, d, f),
            )
        conn.commit()

    return {
        'symbols_scanned': len(by_symbol),
        'accepted': all_accepted,
        'rejected': all_rejected,
    }


def main():
    ap = argparse.ArgumentParser(description="Detect split/bonus factors from bhavcopy prev_close")
    ap.add_argument('--persist', action='store_true', help='write ohlcv_adjustment_factors')
    ap.add_argument('--report', action='store_true', help='print detail, write nothing')
    ap.add_argument('--cross-validate', action='store_true',
                     help='compare against stock_corporate_action_history (mc_corporate_actions_fetcher.py)')
    args = ap.parse_args()

    conn = connect()
    if args.cross_validate:
        res = cross_validate_with_mc_actions(conn, persist=args.persist)
        print(f"[OhlcvAdjust] cross-validate: {len(res['confirmed'])} confirmed, "
              f"{len(res['filled'])} filled, {len(res['disagreement'])} disagreement")
        if args.report:
            print("\n-- filled (heuristic had nothing here) --")
            for sym, d, atype, f, txt in sorted(res['filled'], key=lambda x: x[1]):
                print(f"   {sym:14s} {d}  {atype:6s} {txt or '':8s} x{f:g}")
            print("\n-- disagreement (needs manual review, neither side auto-changed) --")
            for sym, d, atype, f, txt, nearby in sorted(res['disagreement'], key=lambda x: x[1]):
                print(f"   {sym:14s} {d}  {atype:6s} {txt or '':8s} authoritative=x{f:g}  heuristic={nearby}")
        if args.persist:
            print(f"[OhlcvAdjust] persisted {len(res['filled'])} authoritative-sourced factors")
        return 0

    res = scan(conn, persist=args.persist)
    print(f"[OhlcvAdjust] scanned {res['symbols_scanned']} symbols")
    print(f"[OhlcvAdjust] accepted {len(res['accepted'])} adjustment events, "
          f"rejected {len(res['rejected'])}")
    if args.report:
        print("\n-- accepted --")
        for sym, d, f in sorted(res['accepted'], key=lambda x: x[1]):
            print(f"   {sym:14s} {d}  x{f:g}")
        print("\n-- rejected (left unadjusted, reported rather than guessed) --")
        for sym, d, f, why in sorted(res['rejected'], key=lambda x: x[1]):
            print(f"   {sym:14s} {d}  raw={f:.4f}  {why}")
    if args.persist:
        print("[OhlcvAdjust] persisted to ohlcv_adjustment_factors")
    return 0


if __name__ == '__main__':
    sys.exit(main())

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
