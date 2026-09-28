"""Adjusted, quality-flagged price panels.

Corporate-action adjustment is derived from the exchange's own data: on an ex-date NSE
publishes PREV_CLOSE already adjusted, so factor_d = prev_close_d / close_{previous session
the instrument traded}. That catches splits, bonuses, rights and any other base-price
adjustment NSE made, with no dependency on a vendor corporate-actions feed.

Suspect bars are FLAGGED, never deleted, and excluded from the tradeable universe on that
date (legacy: one +127,900% RELIANCE bar produced an 850%-annualised phantom edge).
"""
from __future__ import annotations

import datetime as dt
from dataclasses import dataclass

import numpy as np
import pandas as pd
import psycopg

from bharat_alpha.db import read_df, upsert

ADJ_REL_TOL = 0.002          # ignore prev_close/close drift under 0.2% (tick rounding)
ADJ_ABS_TOL = 0.051          # … or under ~one old tick
MAX_ABS_DAILY_MOVE = 0.60    # |adjusted close/prev_close - 1| above this is physically implausible for NSE cash


def derive_adjustments(conn: psycopg.Connection, start: dt.date | None = None) -> int:
    q = """
    WITH b AS (
      -- Only the IMMEDIATELY preceding bar can anchor an inference, and only if it is itself
      -- trustworthy: after a bad print, the last good close is two sessions old and the gap
      -- to prev_close is an ordinary price move, not a corporate action.
      SELECT instrument_id, trade_date, prev_close, is_suspect,
             LAG(close) OVER w AS last_close, LAG(is_suspect) OVER w AS last_suspect
      FROM alpha.daily_bar
      WINDOW w AS (PARTITION BY instrument_id ORDER BY trade_date)
    )
    SELECT instrument_id, trade_date, prev_close, last_close FROM b
    WHERE NOT last_suspect AND NOT is_suspect AND last_close IS NOT NULL AND prev_close IS NOT NULL AND last_close > 0 AND prev_close > 0
      AND ABS(prev_close - last_close) > %(abs)s AND ABS(prev_close / last_close - 1) > %(rel)s
      AND (%(start)s::date IS NULL OR trade_date >= %(start)s::date)
    """
    df = read_df(conn, q, {"abs": ADJ_ABS_TOL, "rel": ADJ_REL_TOL, "start": start})
    rows = [{"instrument_id": int(r.instrument_id), "ex_date": r.trade_date,
             "factor": float(r.prev_close / r.last_close), "source": "nse_prev_close"}
            for r in df.itertuples()]
    return upsert(conn, "alpha.adjustment", rows, key=("instrument_id", "ex_date"))


def flag_suspect_bars(conn: psycopg.Connection, start: dt.date | None = None) -> int:
    """Re-evaluates the flag on every bar from `start` (idempotent; clears stale flags too)."""
    q = """
    UPDATE alpha.daily_bar b SET is_suspect = s.bad, suspect_reason = s.reason
    FROM (
      SELECT instrument_id, trade_date,
        (reason IS NOT NULL) AS bad, reason
      FROM (
        SELECT instrument_id, trade_date,
          CASE
            WHEN close IS NULL OR close <= 0 OR open IS NULL OR open <= 0 THEN 'nonpositive_or_missing_price'
            WHEN high < low THEN 'high_below_low'
            WHEN close > high * 1.0005 OR close < low * 0.9995 THEN 'close_outside_range'
            WHEN open > high * 1.0005 OR open < low * 0.9995 THEN 'open_outside_range'
            WHEN prev_close > 0 AND ABS(close / prev_close - 1) > %(mx)s THEN 'implausible_move'
            ELSE NULL
          END AS reason
        FROM alpha.daily_bar
        WHERE (%(start)s::date IS NULL OR trade_date >= %(start)s::date)
      ) x
    ) s
    WHERE b.instrument_id = s.instrument_id AND b.trade_date = s.trade_date
      AND (b.is_suspect IS DISTINCT FROM s.bad OR b.suspect_reason IS DISTINCT FROM s.reason)
    """
    with conn.cursor() as cur:
        cur.execute(q, {"mx": MAX_ABS_DAILY_MOVE, "start": start})
        return cur.rowcount


@dataclass
class Panel:
    """Wide (date x instrument) frames on the exchange's trading calendar. Prices are
    back-adjusted; NaN where the instrument did not trade or the bar is suspect."""
    open: pd.DataFrame
    high: pd.DataFrame
    low: pd.DataFrame
    close: pd.DataFrame
    raw_close: pd.DataFrame     # unadjusted, for price-level filters (₹ floor)
    vwap: pd.DataFrame
    volume: pd.DataFrame
    turnover: pd.DataFrame
    deliv_pct: pd.DataFrame
    traded: pd.DataFrame        # bool: a (non-suspect) bar exists
    series: pd.DataFrame        # object: exchange series code

    @property
    def dates(self) -> pd.DatetimeIndex:
        return self.close.index


def load_panel(conn: psycopg.Connection, start: dt.date, end: dt.date) -> Panel:
    days = read_df(conn, "SELECT trade_date FROM alpha.trading_day WHERE trade_date BETWEEN %s AND %s ORDER BY 1",
                   (start, end))
    idx = pd.DatetimeIndex(pd.to_datetime(days["trade_date"]), name="date")
    bars = read_df(conn, """
        SELECT instrument_id, trade_date, series, open, high, low, close, vwap, volume, turnover_inr, deliv_pct,
               is_suspect
        FROM alpha.daily_bar WHERE trade_date BETWEEN %s AND %s""", (start, end))
    adj = read_df(conn, "SELECT instrument_id, ex_date, factor FROM alpha.adjustment WHERE ex_date > %s", (start,))
    if bars.empty:
        raise ValueError(f"no bars between {start} and {end}")
    bars["trade_date"] = pd.to_datetime(bars["trade_date"])
    # Back-adjustment multiplier for bar t = product of factors with ex_date > t (and <= end,
    # so a panel ending at `end` never uses an adjustment that was unknowable at `end`).
    mult = pd.Series(1.0, index=bars.index)
    if not adj.empty:
        adj["ex_date"] = pd.to_datetime(adj["ex_date"])
        adj = adj[adj["ex_date"] <= pd.Timestamp(end)]
        for iid, g in adj.groupby("instrument_id"):
            m = bars["instrument_id"] == iid
            if not m.any():
                continue
            td = bars.loc[m, "trade_date"].to_numpy()
            ex = g["ex_date"].to_numpy()
            f = g["factor"].to_numpy()
            # for each bar, multiply factors whose ex_date is after the bar date
            mult.loc[m] = [float(np.prod(f[ex > t])) for t in td]
    good = ~bars["is_suspect"].astype(bool)

    def wide(col: str, adjust: bool = False, only_good: bool = True) -> pd.DataFrame:
        v = bars[col].astype(float) * (mult if adjust else 1.0)
        if only_good:
            v = v.where(good)
        w = pd.DataFrame({"d": bars["trade_date"], "i": bars["instrument_id"], "v": v}).pivot(index="d", columns="i", values="v")
        return w.reindex(idx)

    vol_adj = bars["volume"].astype(float) / mult     # share counts scale inversely to price
    volume = pd.DataFrame({"d": bars["trade_date"], "i": bars["instrument_id"], "v": vol_adj.where(good)}).pivot(
        index="d", columns="i", values="v").reindex(idx)
    series = bars.pivot(index="trade_date", columns="instrument_id", values="series").reindex(idx)
    traded = wide("close").notna()
    return Panel(
        open=wide("open", True), high=wide("high", True), low=wide("low", True), close=wide("close", True),
        raw_close=wide("close"), vwap=wide("vwap", True), volume=volume, turnover=wide("turnover_inr"), deliv_pct=wide("deliv_pct"),
        traded=traded, series=series,
    )
