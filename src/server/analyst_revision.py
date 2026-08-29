"""
Analyst Estimate Revision Momentum Engine
==========================================
Analyst *estimate revisions* — how much the EPS and price-target consensus shifted over the
past 90 days — are the single most consistently rewarded alpha factor in the academic and
practitioner quant literature (Zacks Earnings Estimate Revisions, Hawkins et al. 2004,
Jegadeesh & Kim 2006, AQR's "Quality minus Junk").  The mechanism is structural:

  1. Sell-side analysts are anchored and revise slowly, so an upgrade cycle persists for
     weeks after the first upward revision.
  2. Institutional mandates force portfolio managers to buy when consensus raises a stock
     to their benchmark weight — creating predictable, multi-week demand.
  3. EPS revisions lead price by 4–12 weeks on average (Zacks), giving a confirmed,
     lag-safe entry signal that technical signals alone cannot see.

This engine computes three revision metrics from `analyst_estimates_history` and writes
them onto `technical_signals` so `ml_ensemble.py` can consume them via its existing join:

  eps_revision_3m_pct    — (current_eps_est - eps_est_90d_ago) / |eps_est_90d_ago| * 100
  target_revision_3m_pct — (current_target  - target_90d_ago)  / |target_90d_ago|  * 100
  analyst_count_chg      — current_n_analysts - n_analysts_90d_ago
                           (new coverage initiations are a reliably bullish leading signal)

Look-ahead safety: the "90-day-ago" snapshot is the most recent snapshot with as_of_date ≤
(most_recent_date − 90 days + 14 day tolerance), so no future information leaks in.

Run:
    python analyst_revision.py                # all symbols
    python analyst_revision.py --symbol INFY  # single symbol (debug / backfill)
"""
import polars as pl

import argparse
import datetime
from typing import Optional

import pandas as pd

from db_compat import execute, read_df, executemany
from as_of import logical_trading_date

# ± tolerance for "snapshot closest to 90 days ago" (days)
REVISION_WINDOW_DAYS = 90
TOLERANCE_DAYS = 14


# ─── Schema bootstrap ─────────────────────────────────────────────────────────

_NEW_COLS = [
    ("eps_revision_3m_pct",    "REAL"),
    ("target_revision_3m_pct", "REAL"),
    ("analyst_count_chg",      "INTEGER"),
]


def ensure_schema() -> None:
    """Add the three new columns to technical_signals if they don't already exist.
    Each ALTER TABLE is wrapped in its own try/except so a partial schema (e.g.
    only one column missing) is handled cleanly without blocking other columns."""
    for col, dtype in _NEW_COLS:
        try:
            execute(f"ALTER TABLE technical_signals ADD COLUMN {col} {dtype}")
        except Exception:
            # Column already exists — this is the normal path after first run.
            pass


# ─── Core computation ─────────────────────────────────────────────────────────

def _pct_change(current: float, prior: float) -> Optional[float]:
    """Percent change relative to |prior|. Returns None if either value is
    missing/zero (avoids division-by-zero and zero-denominator distortions)."""
    if current is None or prior is None:
        return None
    if prior == 0.0:
        return None
    return (current - prior) / abs(prior) * 100.0


def compute_revisions(hist: pd.DataFrame) -> pd.DataFrame:
    """Given the full `analyst_estimates_history` frame (all symbols), compute
    revision metrics and return a frame with columns:
        symbol, eps_revision_3m_pct, target_revision_3m_pct, analyst_count_chg

    Algorithm per symbol:
      1. Find most-recent snapshot date.
      2. Target lookback date = most_recent - 90 days.
      3. Accept any snapshot within [target - 14d, target + 14d] (tolerance window).
         Pick the one closest to target_lookback.
      4. Compute metrics; skip a metric if either endpoint value is missing/zero.
    """
    if hist.empty:
        return pd.DataFrame(columns=["symbol", "eps_revision_3m_pct",
                                     "target_revision_3m_pct", "analyst_count_chg"])

    hist = hist.copy()
    hist["as_of_date"] = pd.to_datetime(hist["as_of_date"])

    results = []
    for symbol, g in hist.groupby("symbol"):
        g = g.sort_values("as_of_date")
        latest = g.iloc[-1]
        most_recent_date = latest["as_of_date"]

        target_lookback = most_recent_date - pd.Timedelta(days=REVISION_WINDOW_DAYS)
        lo = target_lookback - pd.Timedelta(days=TOLERANCE_DAYS)
        hi = target_lookback + pd.Timedelta(days=TOLERANCE_DAYS)

        candidates = g[(g["as_of_date"] >= lo) & (g["as_of_date"] <= hi)]
        if candidates.empty:
            # No prior snapshot within tolerance → skip all metrics
            continue

        # Closest to the target lookback date
        idx = (candidates["as_of_date"] - target_lookback).abs().idxmin()
        prior = candidates.loc[idx]

        eps_rev = _pct_change(
            _float(latest["eps_est_next"]),
            _float(prior["eps_est_next"]),
        )
        tgt_rev = _pct_change(
            _float(latest["target_mean"]),
            _float(prior["target_mean"]),
        )
        n_chg = None
        cur_n = _int(latest["n_analysts"])
        pri_n = _int(prior["n_analysts"])
        if cur_n is not None and pri_n is not None:
            n_chg = cur_n - pri_n

        results.append({
            "symbol":                symbol,
            "eps_revision_3m_pct":   eps_rev,
            "target_revision_3m_pct": tgt_rev,
            "analyst_count_chg":     n_chg,
        })

    return pd.DataFrame(results)


def _float(val) -> Optional[float]:
    try:
        v = float(val)
        return v if pd.notna(v) else None
    except (TypeError, ValueError):
        return None


def _int(val) -> Optional[int]:
    try:
        v = int(val)
        return v if pd.notna(v) else None
    except (TypeError, ValueError):
        return None


# ─── Write-back ───────────────────────────────────────────────────────────────

# date = ? guard (2026-07-19) instead of MAX(date) -- see bse_event_classifier.py's
# run_daily docstring for why matching the latest row isn't the same as matching today's row.
_UPDATE_SQL = """
UPDATE technical_signals
SET
    eps_revision_3m_pct    = COALESCE(?, eps_revision_3m_pct),
    target_revision_3m_pct = COALESCE(?, target_revision_3m_pct),
    analyst_count_chg      = COALESCE(?, analyst_count_chg)
WHERE symbol = ?
  AND date = ?
"""


def write_revisions(revisions: pd.DataFrame) -> tuple[int, int]:
    """Upsert revision metrics onto the most-recent technical_signals row per symbol.
    Returns (n_updated, n_skipped)."""
    if revisions.empty:
        return 0, 0

    # logical_trading_date(), not date.today() (2026-08-01) -- this fetcher runs inside
    # ml-daily-ops, whose step chain regularly finishes after midnight IST; a raw wall-clock
    # date silently targets a day with no grid row yet. See as_of.logical_trading_date's
    # docstring for the incident.
    today = logical_trading_date()
    params = []
    skipped = 0
    for r in revisions.itertuples(index=False):
        # If ALL three metrics are None, nothing to write — count as skipped
        if r.eps_revision_3m_pct is None and r.target_revision_3m_pct is None and r.analyst_count_chg is None:
            skipped += 1
            continue
        params.append((
            r.eps_revision_3m_pct,
            r.target_revision_3m_pct,
            r.analyst_count_chg,
            r.symbol,
            today,
        ))

    if not params:
        return 0, skipped

    n = executemany(_UPDATE_SQL, params)
    return n, skipped


# ─── Entry point ──────────────────────────────────────────────────────────────

def run(only_symbol: Optional[str] = None) -> None:
    ensure_schema()

    where = ""
    query_params: list = []
    if only_symbol:
        where = "WHERE symbol = ?"
        query_params = [only_symbol.upper()]

    hist = read_df(
        f"SELECT symbol, as_of_date, n_analysts, eps_est_next, target_mean "
        f"FROM analyst_estimates_history {where} "
        f"ORDER BY symbol, as_of_date",
        query_params,
    )

    if hist.empty:
        print("[AnalystRevision] No data in analyst_estimates_history"
              + (f" for {only_symbol}" if only_symbol else "") + ". Nothing to do.")
        return

    n_input_symbols = hist["symbol"].nunique()
    revisions = compute_revisions(hist)

    # Symbols that had history but no qualifying prior snapshot
    n_computed = len(revisions)
    n_skipped_history = n_input_symbols - n_computed

    n_updated, n_skipped_nulls = write_revisions(revisions)
    total_skipped = n_skipped_history + n_skipped_nulls

    print(
        f"[AnalystRevision] Done. "
        f"{n_updated} symbols updated, "
        f"{total_skipped} skipped "
        f"({n_skipped_history} insufficient history, {n_skipped_nulls} all-null metrics)."
    )


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Analyst estimate revision momentum → technical_signals"
    )
    parser.add_argument(
        "--symbol",
        metavar="SYM",
        help="Process only this NSE symbol (e.g. INFY). Omit to process all.",
    )
    args = parser.parse_args()
    run(only_symbol=args.symbol)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
