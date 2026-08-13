"""Live intraday version of screener_combo_finder.py's validated tier-1 finding.

Reverse-engineered 2026-08-13 from the signal-accuracy-review of that day's top gainers:
the single filters (gap_down, top_loser alone) are negative/noise (matches this session's
factor_backtest.py gap_down/gap_up results, both t<-3 net of costs), but the triple
combination -- gapped down AND opened at the day's low AND currently among the day's
biggest losers, i.e. a capitulation/panic day -- rebounds the NEXT session significantly:
424 days, spread +0.5258%/day net of 15bps costs, t=3.58, p=0.0004, clears Bonferroni across
the 41-combination search space (`python screener_combo_finder.py --tier1`). See
measurement.md.

This reuses that EXACT definition (GAP_THRESHOLD, TOP_PCT, has_range/open_eq_low logic --
imported, not re-derived, so a future retune of the validated thresholds updates both the
live scan and the backtest that proved them) but computes it INTRADAY, from today's running
session, instead of EOD: gap vs yesterday's close is known at the open; "opened at the low"
and "top loser" both use the running high/low/last-price seen so far today, not the final
bar -- the point is to catch the setup AS it forms, the same way today's live screener caught
MOREPENLAB/PRECWIRE within 15 minutes of open.

Writes matches into the EXISTING live_screener_appearances table under filter_key
'todayCapitulation', linked to a NEW live_screener_runs row -- no schema change, and every
existing consumer of that table (screener_combo_finder.py's own tier2, the Intraday Edge tab)
picks this filter up for free.

Scheduled: chained into queues.ts's processLiveScreenerCollect, same 15-min/market-hours
cadence as the NiftyTrader collector it sits next to.

USAGE
    python live_capitulation_screener.py            # scans, writes matches
    python live_capitulation_screener.py --dry-run   # scans, prints only
"""
from __future__ import annotations

import argparse
import datetime

from db_compat import connect, read_df
from screener_combo_finder import GAP_THRESHOLD, TOP_PCT, MIN_ADTV, MIN_PRICE

FILTER_KEY = "todayCapitulation"


def compute_matches(df) -> list[dict]:
    """Pure: df needs columns [symbol, day_open, day_low, day_high, last_price, prev_close,
    day_volume, adtv]. Split out from scan() so this can be tested without a DB -- same
    pattern as compute_tier1_precursors in screener_combo_finder.py. Filters/thresholds are
    imported from there, not redefined, so a retune updates both the live scan and the
    backtest that validated it."""
    df = df[(df["adtv"].fillna(0) >= MIN_ADTV) & (df["prev_close"] >= MIN_PRICE)]
    if df.empty:
        return []

    gap_pct = (df["day_open"] - df["prev_close"]) / df["prev_close"].replace(0, float("nan"))
    has_range = (df["day_high"] - df["day_low"]) >= 0.005 * df["day_open"]
    open_eq_low = has_range & ((df["day_open"] - df["day_low"]) <= 0.001 * df["day_open"])
    gap_down = gap_pct <= -GAP_THRESHOLD

    today_ret = (df["last_price"] - df["prev_close"]) / df["prev_close"].replace(0, float("nan"))
    # Same-universe cross-sectional rank as compute_tier1_precursors' `rank` -- pct=True,
    # ascending, so the bottom TOP_PCT (biggest losers) get the lowest percentiles.
    rank = today_ret.rank(pct=True)
    top_loser = rank <= TOP_PCT

    match = df[gap_down.fillna(False) & open_eq_low.fillna(False) & top_loser.fillna(False)]
    return [
        {"symbol": r.symbol, "price": float(r.last_price),
         "change_per": float(today_ret[i] * 100), "volume": int(r.day_volume or 0)}
        for i, r in match.iterrows()
    ]


def scan() -> list[dict]:
    """Returns matching rows: [{symbol, price, change_per, volume}, ...]."""
    today = datetime.date.today().isoformat()

    prev_close = read_df(
        "SELECT symbol, close AS prev_close FROM stock_ohlcv "
        "WHERE date = (SELECT MAX(date) FROM stock_ohlcv WHERE date < ?) AND is_suspect = 0",
        (today,),
    )
    if prev_close.empty:
        print("[LiveCapitulation] no prior-close row -- not a trading day yet, or no data.")
        return []

    lookback_start = (datetime.date.today() - datetime.timedelta(days=30)).isoformat()
    liq = read_df(
        "SELECT symbol, AVG(close * volume) AS adtv FROM stock_ohlcv "
        "WHERE date > ? AND date <= ? AND is_suspect = 0 "
        "GROUP BY symbol",
        (lookback_start, today),
    )

    today_bars = read_df(
        "SELECT symbol, MIN(open) FILTER (WHERE datetime = (SELECT MIN(datetime) FROM intraday_ohlcv i2 "
        "WHERE i2.symbol = intraday_ohlcv.symbol AND i2.datetime >= ? AND i2.open IS NOT NULL)) AS day_open, "
        "MIN(low) AS day_low, MAX(high) AS day_high, "
        "(ARRAY_AGG(close ORDER BY datetime DESC) FILTER (WHERE close IS NOT NULL))[1] AS last_price, "
        "SUM(volume) AS day_volume "
        "FROM intraday_ohlcv WHERE datetime >= ? AND close IS NOT NULL "
        "GROUP BY symbol",
        (today, today),
    )
    if today_bars.empty:
        print("[LiveCapitulation] no intraday bars yet today.")
        return []

    df = (today_bars.merge(prev_close, on="symbol", how="inner")
                     .merge(liq, on="symbol", how="left"))
    return compute_matches(df)


def run(dry_run: bool = False) -> int:
    matches = scan()
    print(f"[LiveCapitulation] {len(matches)} symbol(s) matched '{FILTER_KEY}' as of "
          f"{datetime.datetime.now(datetime.UTC).isoformat()}")
    for m in matches:
        print(f"    {m['symbol']:12s} {m['change_per']:+.2f}%  price={m['price']}")

    if dry_run or not matches:
        return len(matches)

    con = connect()
    ts = datetime.datetime.now(datetime.UTC).isoformat()
    run_row = con.execute(
        "INSERT INTO live_screener_runs (timestamp, filters_completed, total_filters, status, error_log) "
        "VALUES (?, 1, 1, 'SUCCESS', '') RETURNING id",
        (ts,),
    ).fetchone()
    run_id = run_row["id"]
    for m in matches:
        con.execute(
            "INSERT INTO live_screener_appearances (run_id, symbol, filter_key, price, change_per, volume) "
            "VALUES (?, ?, ?, ?, ?, ?)",
            (run_id, m["symbol"], FILTER_KEY, m["price"], m["change_per"], m["volume"]),
        )
    con.commit()
    print(f"[LiveCapitulation] wrote {len(matches)} row(s) under run_id={run_id}")
    return len(matches)


if __name__ == "__main__":
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--dry-run", action="store_true")
    a = ap.parse_args()
    run(dry_run=a.dry_run)
