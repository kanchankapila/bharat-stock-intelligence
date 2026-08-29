import polars as pl
"""
Historical Volatility Feature Engine
=====================================
Computes HV (Historical Volatility) at four windows from daily OHLCV close prices and
writes the results onto the most-recent technical_signals row per symbol.

Features written to technical_signals:

  hv_10d       -- 10-day annualised HV in % terms (std of daily log-returns × √252 × 100).
                  Short-horizon realised vol; spikes on news/earnings, reverts fast.
                  Signal: if hv_10d >> hv_30d, the stock is in a volatility expansion.

  hv_20d       -- 20-day annualised HV. The "standard" realised-vol window used by most
                  options desks as the baseline for IV vs HV comparison. Comparable to the
                  1-month ATM option tenor.

  hv_30d       -- 30-day annualised HV. Smoothed medium-horizon realised vol; less sensitive
                  to a single spike day than hv_10d.

  hv_60d       -- 60-day annualised HV. Closest to the 2-month option tenor; captures
                  regime-level volatility (earnings cycle, sector rotation) without excessive
                  short-term noise.

  iv_hv_ratio  -- iv_rank / hv_20d.  Values > 1 indicate that implied vol (options premium)
                  is elevated relative to recent realised vol — options are "overpriced"
                  vs. what the stock has actually done. Values < 1 = options are cheap
                  vs. recent moves. Useful for credit-spread vs. debit-spread decisions.
                  Note: iv_rank is on a 0-1 scale; hv_20d is a %. The ratio is a unitless
                  relative signal, not a percentage comparison — interpret directionally.

Algorithm:
  1. Pull stock_ohlcv for the last 420 days (enough for 60-day HV with buffer), filtering
     is_suspect = 0.
  2. For each symbol, compute daily log-returns = log(close_t / close_t-1).
  3. Rolling std at each window W, then annualise: std(W) * sqrt(252) * 100.
  4. iv_hv_ratio = iv_rank (from the most-recent technical_signals row) / hv_20d.
  5. UPDATE the MOST RECENT technical_signals row per symbol only — does not rewrite history.

Run:  python hv_features.py
      python hv_features.py --date 2026-06-25   (filter: only update if max(ts.date)==target)
      python hv_features.py --symbol INFY        (process a single stock)
"""

import argparse
import datetime
import math

import numpy as np
import pandas as pd

from db_compat import connect, read_df, executemany

LOOKBACK_DAYS = 420          # enough for 60-day HV with a generous buffer
HV_WINDOWS = (10, 20, 30, 60)
ANNUALISE = math.sqrt(252) * 100   # multiply raw daily-return std by this → annualised HV %


# ── Schema ────────────────────────────────────────────────────────────────────

def ensure_schema(con) -> None:
    """Add new HV columns to technical_signals. Each ALTER is wrapped in its own
    try/except so a pre-existing column does not abort the transaction for the others."""
    cur = con.cursor()
    new_cols = [
        ("hv_10d",      "REAL"),
        ("hv_20d",      "REAL"),
        ("hv_30d",      "REAL"),
        ("hv_60d",      "REAL"),
        ("iv_hv_ratio", "REAL"),
    ]
    for col, dtype in new_cols:
        try:
            cur.execute(f"ALTER TABLE technical_signals ADD COLUMN {col} {dtype}")
            con.commit()
        except Exception:
            con.rollback()


# ── HV computation ────────────────────────────────────────────────────────────

def build_hv_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """Given a long OHLCV frame (symbol, date, close), return a long frame of
    (symbol, hv_10d, hv_20d, hv_30d, hv_60d) with ONE row per symbol — the most-recent
    available HV value (i.e. the last date for which all windows are computable)."""
    if ohlcv.empty:
        return pd.DataFrame(columns=["symbol", "hv_10d", "hv_20d", "hv_30d", "hv_60d"])

    ohlcv = ohlcv.copy()
    ohlcv["date"] = pd.to_datetime(ohlcv["date"])
    ohlcv = ohlcv.sort_values(["symbol", "date"])

    records = []
    for symbol, g in ohlcv.groupby("symbol", sort=False):
        g = g.sort_values("date").reset_index(drop=True)
        if len(g) < 2:
            continue
        log_rets = np.log(g["close"] / g["close"].shift(1))
        row: dict = {"symbol": symbol}
        for w in HV_WINDOWS:
            hv_series = log_rets.rolling(w, min_periods=w).std() * ANNUALISE
            last_val = hv_series.dropna().iloc[-1] if hv_series.dropna().shape[0] > 0 else None
            row[f"hv_{w}d"] = float(last_val) if last_val is not None and not math.isnan(last_val) else None
        records.append(row)

    if not records:
        return pd.DataFrame(columns=["symbol", "hv_10d", "hv_20d", "hv_30d", "hv_60d"])
    return pd.DataFrame(records)


# ── Main run ──────────────────────────────────────────────────────────────────

def run(only_date: str | None = None, only_symbol: str | None = None) -> int:
    """Compute HV features and write onto the most-recent technical_signals row per symbol.
    Returns the number of rows updated."""

    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()

    # Fixed 2026-07-30 (Finding #67, full-stack audit): the OHLCV read had a lower date
    # bound but no upper one -- the write side correctly filtered which symbols/dates got
    # updated for a --date backfill, but the HV values themselves were computed from OHLCV
    # through TODAY regardless of the target date, leaking future realized volatility into
    # a historical technical_signals row whenever --date targeted the past. Resolve the
    # target date up front (same "today" normalization the write-side filter below already
    # does) and bound the read with it too.
    upper_bound = (
        datetime.date.today().isoformat() if not only_date or only_date == "today"
        else only_date
    )

    base_sql = (
        "SELECT symbol, date, close FROM stock_ohlcv "
        "WHERE date >= ? AND date <= ? AND COALESCE(is_suspect, 0) = 0"
    )
    params: tuple = (cutoff, upper_bound)
    if only_symbol:
        base_sql += " AND symbol = ?"
        params = (cutoff, upper_bound, only_symbol.upper())
    base_sql += " ORDER BY symbol, date"

    ohlcv = read_df(base_sql, params)
    if ohlcv.empty:
        print("[HVFeatures] No OHLCV data found — nothing to compute.")
        return 0

    feats = build_hv_features(ohlcv)
    if feats.empty:
        print("[HVFeatures] No HV features computed.")
        return 0

    # Fetch current iv_rank from technical_signals (most-recent row per symbol)
    iv_sql = (
        "SELECT symbol, iv_rank FROM technical_signals "
        "WHERE date = (SELECT MAX(date) FROM technical_signals ts2 WHERE ts2.symbol = technical_signals.symbol)"
    )
    if only_symbol:
        iv_sql += " AND symbol = ?"
        iv_df = read_df(iv_sql, (only_symbol.upper(),))
    else:
        iv_df = read_df(iv_sql)

    iv_map: dict[str, float | None] = {}
    if not iv_df.empty:
        for r in iv_df.itertuples(index=False):
            iv_map[r.symbol] = float(r.iv_rank) if r.iv_rank is not None and not (isinstance(r.iv_rank, float) and math.isnan(r.iv_rank)) else None

    # Compute iv_hv_ratio
    feats["iv_hv_ratio"] = feats.apply(
        lambda row: (
            round(iv_map[row["symbol"]] / row["hv_20d"], 4)
            if row["symbol"] in iv_map
            and iv_map[row["symbol"]] is not None
            and row["hv_20d"] is not None
            and row["hv_20d"] > 0
            else None
        ),
        axis=1,
    )

    # Ensure schema columns exist
    with connect() as con:
        ensure_schema(con)

    # Filter to symbols that have a technical_signals row to update
    ts_df = read_df("SELECT symbol, MAX(date) AS max_date FROM technical_signals GROUP BY symbol")
    if ts_df.empty:
        print("[HVFeatures] technical_signals is empty — nothing to update.")
        return 0

    ts_map: dict[str, str] = {r.symbol: str(r.max_date) for r in ts_df.itertuples(index=False)}
    if only_date:
        target_date = datetime.date.today().isoformat() if only_date == "today" else only_date
        # Only update symbols whose most-recent technical_signals row matches target date
        ts_map = {sym: d for sym, d in ts_map.items() if d == target_date}
        if not ts_map:
            print(f"[HVFeatures] No technical_signals rows with date={target_date}.")
            return 0

    feats = feats[feats["symbol"].isin(ts_map)].copy()
    if feats.empty:
        print("[HVFeatures] No HV features match existing technical_signals symbols.")
        return 0

    update_sql = (
        "UPDATE technical_signals "
        "SET hv_10d = ?, hv_20d = ?, hv_30d = ?, hv_60d = ?, iv_hv_ratio = ? "
        "WHERE symbol = ? AND date = ("
        "  SELECT MAX(date) FROM technical_signals WHERE symbol = ?"
        ")"
    )

    def _f(v):
        return float(v) if v is not None else None

    update_params = [
        (
            _f(r.hv_10d),
            _f(r.hv_20d),
            _f(r.hv_30d),
            _f(r.hv_60d),
            _f(r.iv_hv_ratio),
            r.symbol,
            r.symbol,
        )
        for r in feats.itertuples(index=False)
        if r.symbol in ts_map
    ]

    if not update_params:
        print("[HVFeatures] No rows to update after filtering.")
        return 0

    n = executemany(update_sql, update_params)
    print(f"[HVFeatures] Done. {n} symbols updated.")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Historical Volatility feature engine")
    parser.add_argument(
        "--date",
        help="Optional YYYY-MM-DD (or 'today'). Only update symbols whose most-recent "
             "technical_signals row falls on this date.",
    )
    parser.add_argument(
        "--symbol",
        help="Optional NSE symbol (e.g. INFY). Process only this stock.",
    )
    args = parser.parse_args()
    run(only_date=args.date, only_symbol=args.symbol)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
