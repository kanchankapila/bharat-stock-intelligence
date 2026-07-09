#!/usr/bin/env python3
"""
Rolling Risk Metrics Engine
===========================
Computes per-stock Beta, Sortino Ratio, and VaR(95%) against Nifty 50.

This augments the TypeScript quantScoringWorker.ts which already computes
Sharpe, Max Drawdown, and Volatility. This engine adds the missing metrics:
  - Beta (1Y rolling, 252-day + 126-day windows)
  - Sortino Ratio (penalizes only downside deviation, uses actual RBI repo rate)
  - VaR 95% (historical 5th-percentile of rolling 252-day daily returns)

Results are written to the existing quant_scores table (new columns added via
migration in db.ts), so the TypeScript layer reads a single source of truth.
No new table needed — no new score producer created.

Usage:
  python risk_metrics_engine.py                  # run all symbols
  python risk_metrics_engine.py --symbol RELIANCE # single symbol
  python risk_metrics_engine.py --test            # validate on 10 stocks
"""

import argparse
import datetime
import sys
from typing import Optional

import numpy as np
import pandas as pd

from db_compat import connect, read_df, execute, query_one


# ── Constants ─────────────────────────────────────────────────────────────────

NIFTY_SYMBOL       = "NIFTY50"
DEFAULT_RISK_FREE  = 0.065   # Fallback: 6.5% (typical RBI repo range)
WINDOW_LONG        = 252     # 1-year rolling
WINDOW_SHORT       = 126     # 6-month rolling (for beta stability check)
MIN_DAYS           = 63      # Minimum rows needed to compute any metric


# ── Helpers ───────────────────────────────────────────────────────────────────

def _get_rbi_repo_rate() -> float:
    """Read the latest RBI repo rate from macro_asset_prices. Falls back to 6.5%."""
    try:
        row = query_one(
            "SELECT close FROM macro_asset_prices WHERE symbol='RBI_REPO_RATE' "
            "ORDER BY date DESC LIMIT 1"
        )
        if row and row[0] is not None:
            rate = float(row[0])
            # Stored as percentage (e.g. 6.5) — convert to decimal
            return rate / 100.0 if rate > 1.0 else rate
    except Exception:
        pass
    return DEFAULT_RISK_FREE


def _daily_returns(prices: pd.Series) -> pd.Series:
    """Simple daily log returns."""
    return np.log(prices / prices.shift(1)).dropna()


def _beta(stock_ret: pd.Series, bench_ret: pd.Series, window: int) -> Optional[float]:
    """Rolling Beta over `window` days. Returns None if insufficient data."""
    s = stock_ret.iloc[-window:]
    b = bench_ret.reindex(s.index).dropna()
    s = s.reindex(b.index)
    if len(s) < MIN_DAYS:
        return None
    cov   = np.cov(s, b)[0, 1]
    var_b = np.var(b, ddof=1)
    return float(cov / var_b) if var_b > 0 else None


def _sortino(returns: pd.Series, risk_free_daily: float, window: int) -> Optional[float]:
    """Sortino ratio over `window` days. Downside deviation is the RMS of MAR-shortfall
    across the FULL window (zero for non-losing days), per the standard Sortino
    definition -- dividing by only the count of losing days understates downside risk
    and inflates the ratio."""
    r = returns.iloc[-window:]
    if len(r) < MIN_DAYS:
        return None
    excess = r - risk_free_daily
    if (excess < 0).sum() < 5:
        return None
    downside_dev = float(np.sqrt(np.mean(np.minimum(excess, 0) ** 2))) * np.sqrt(WINDOW_LONG)
    ann_excess   = float(excess.mean()) * WINDOW_LONG
    return float(ann_excess / downside_dev) if downside_dev > 0 else None


def _var95(returns: pd.Series, window: int) -> Optional[float]:
    """Historical VaR 95% as a percentage (positive = loss). e.g. 3.2 means daily -3.2%."""
    r = returns.iloc[-window:]
    if len(r) < MIN_DAYS:
        return None
    return float(-np.percentile(r, 5) * 100)


# ── Main engine ───────────────────────────────────────────────────────────────

def run(symbol: Optional[str] = None, window_days: int = WINDOW_LONG, test: bool = False) -> dict:
    """
    Compute and write Beta, Sortino, VaR95 for one or all symbols.

    Returns a summary dict {processed, skipped, errors}.
    """
    print(f"[RiskMetrics] Starting — symbol={'all' if symbol is None else symbol}, window={window_days}d")
    risk_free_annual = _get_rbi_repo_rate()
    risk_free_daily  = risk_free_annual / WINDOW_LONG
    print(f"[RiskMetrics] Risk-free rate: {risk_free_annual*100:.2f}% p.a. (source: macro_asset_prices/fallback)")

    # Load Nifty benchmark
    nifty_df = read_df(
        "SELECT date, close FROM stock_ohlcv WHERE symbol=? ORDER BY date ASC",
        (NIFTY_SYMBOL,)
    )
    if nifty_df.empty:
        print(f"[RiskMetrics] ERROR: No NIFTY50 data found in stock_ohlcv. Aborting.")
        return {"processed": 0, "skipped": 0, "errors": 1}

    nifty_df["date"] = pd.to_datetime(nifty_df["date"])
    nifty_df = nifty_df.set_index("date").sort_index()
    nifty_ret = _daily_returns(nifty_df["close"])

    # Fetch list of symbols to process
    if symbol:
        symbols = [symbol]
    else:
        conn = connect()
        rows = conn.execute("SELECT DISTINCT symbol FROM stock_ohlcv WHERE symbol != ?", (NIFTY_SYMBOL,)).fetchall()
        conn.close()
        symbols = [r[0] for r in rows]
        if test:
            symbols = symbols[:10]

    print(f"[RiskMetrics] Processing {len(symbols)} symbols...")

    processed = skipped = errors = 0
    update_rows = []

    for sym in symbols:
        try:
            df = read_df(
                "SELECT date, close FROM stock_ohlcv WHERE symbol=? AND close>0 ORDER BY date ASC",
                (sym,)
            )
            if df.empty or len(df) < MIN_DAYS:
                skipped += 1
                continue

            df["date"] = pd.to_datetime(df["date"])
            df = df.set_index("date").sort_index()
            stock_ret = _daily_returns(df["close"])

            # Align benchmark to this stock's date range
            bench = nifty_ret.reindex(stock_ret.index).ffill()

            beta_1y  = _beta(stock_ret, bench, WINDOW_LONG)
            beta_6m  = _beta(stock_ret, bench, WINDOW_SHORT)
            sortino  = _sortino(stock_ret, risk_free_daily, window_days)
            var95    = _var95(stock_ret, window_days)

            update_rows.append((beta_1y, beta_6m, sortino, var95, sym))
            processed += 1

        except Exception as e:
            print(f"[RiskMetrics] ERROR {sym}: {e}")
            errors += 1

    # Batch write — update only the new columns in quant_scores
    if update_rows:
        conn = connect()
        try:
            conn.executemany(
                """UPDATE quant_scores
                   SET beta_1y=?, beta_6m=?, sortino_ratio=?, var_95=?,
                       last_computed=CURRENT_TIMESTAMP
                   WHERE symbol=?""",
                update_rows
            )
            conn.commit()
        finally:
            conn.close()

    print(f"[RiskMetrics] Done — processed={processed}, skipped={skipped}, errors={errors}")
    return {"processed": processed, "skipped": skipped, "errors": errors}


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Rolling Risk Metrics Engine")
    parser.add_argument("--symbol", help="Process a single symbol (default: all)")
    parser.add_argument("--window", type=int, default=WINDOW_LONG, help="Rolling window in days (default: 252)")
    parser.add_argument("--test", action="store_true", help="Run on first 10 symbols only")
    args = parser.parse_args()
    result = run(symbol=args.symbol, window_days=args.window, test=args.test)
    print(f"[RiskMetrics] Result: {result}")
