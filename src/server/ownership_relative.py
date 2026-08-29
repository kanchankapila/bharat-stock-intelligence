"""
Cross-Sectional Ownership-Flow Feature Engine
=============================================
The ownership fetchers give each stock an *absolute* MF flow (mf_net_share_chg_pct). Absolute
flow is dominated by market-wide waves — when MFs are buying everything, every stock looks
"accumulated". What discriminates is flow *relative to peers on the same day*: is this stock
being bought more than its sector, more than the universe? That is the same idea as
relative_strength.py, applied to institutional flow instead of price.

For each (symbol, date) already present in technical_signals it writes:
  mf_flow_vs_sector   stock mf_net_share_chg_pct minus its sector-average that day
  mf_flow_rank        universe percentile rank of mf_net_share_chg_pct that day (0=worst,1=best)

Everything is same-day cross-sectional — no look-ahead. It reads only the point-in-time
mf_net_share_chg_pct already stamped on technical_signals (bounded by the disclosure floor in
mf_stock_holdings_fetcher.py), so it inherits that anti-leakage discipline.

Run:  python ownership_relative.py
      python ownership_relative.py --date today
"""

import polars as pl
import argparse
import datetime

import pandas as pd

from db_compat import read_df, executemany, connect, translate
from as_of import logical_trading_date

MIN_UNIVERSE = 20     # need a reasonable cross-section on a day before a rank is meaningful
MIN_SECTOR_SIZE = 5   # minimum stocks in a sector before its average flow is trustworthy


def ensure_schema() -> None:
    for col in ("mf_flow_vs_sector", "mf_flow_rank"):
        try:
            conn = connect()
            conn.execute(translate(f"ALTER TABLE technical_signals ADD COLUMN {col} REAL"))
            conn.commit()
            conn.close()
            print(f"[OWN] Added column technical_signals.{col}")
        except Exception:
            try:
                conn.rollback()
                conn.close()
            except Exception:
                pass


def build_ownership_features(rows: pd.DataFrame) -> pd.DataFrame:
    """rows: long frame (symbol, date, mf_flow[, sector]). Returns long frame with
    mf_flow_vs_sector and mf_flow_rank. Rows without an mf_flow are dropped up front."""
    cols = ["symbol", "date", "mf_flow_vs_sector", "mf_flow_rank"]
    if rows.empty or "mf_flow" not in rows.columns:
        return pd.DataFrame(columns=cols)

    df = rows.dropna(subset=["mf_flow"]).copy()
    if df.empty:
        return pd.DataFrame(columns=cols)

    # Universe percentile rank per day; days with too few names are left NaN (unfair to rank).
    counts = df.groupby("date")["mf_flow"].transform("count")
    df["mf_flow_rank"] = df.groupby("date")["mf_flow"].rank(pct=True)
    df.loc[counts < MIN_UNIVERSE, "mf_flow_rank"] = pd.NA

    # Sector-demeaned flow: stock flow minus its sector average that day (min sector size).
    if "sector" in df.columns:
        sec = df.dropna(subset=["sector"])
        grp = sec.groupby(["date", "sector"])["mf_flow"]
        sector_avg = grp.transform("mean")
        sector_n = grp.transform("count")
        vs = sec["mf_flow"] - sector_avg
        vs = vs.where(sector_n >= MIN_SECTOR_SIZE, other=pd.NA)
        df.loc[vs.index, "mf_flow_vs_sector"] = vs
    if "mf_flow_vs_sector" not in df.columns:
        df["mf_flow_vs_sector"] = pd.NA

    out = df[cols]
    return out.dropna(subset=["mf_flow_vs_sector", "mf_flow_rank"], how="all")


def run(only_date: str | None = None) -> int:
    ensure_schema()

    rows = read_df(
        "SELECT ts.symbol, ts.date, ts.mf_net_share_chg_pct AS mf_flow, ns.sector "
        "FROM technical_signals ts "
        "LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol "
        "WHERE ts.mf_net_share_chg_pct IS NOT NULL"
    )
    if rows.empty:
        print("[OWN] No ownership flow on technical_signals yet.")
        return 0

    rows["date"] = pd.to_datetime(rows["date"]).dt.strftime("%Y-%m-%d")
    feats = build_ownership_features(rows)
    if only_date:
        # logical_trading_date(), not date.today() (2026-08-01) -- not currently reachable in
        # production (queues.ts calls this with no --date arg), but `--date today` is this
        # script's own documented usage pattern, and ml-daily-ops's step chain regularly
        # finishes after midnight IST -- see as_of.logical_trading_date's docstring.
        target = logical_trading_date() if only_date == "today" else only_date
        feats = feats[feats["date"] == target]
    if feats.empty:
        print("[OWN] No ownership-relative features to write.")
        return 0

    def _fval(v):
        return None if pd.isna(v) else float(v)

    params = [
        (_fval(r.mf_flow_vs_sector), _fval(r.mf_flow_rank), r.symbol, r.date)
        for r in feats.itertuples(index=False)
    ]
    n = executemany(
        "UPDATE technical_signals "
        "SET mf_flow_vs_sector = ?, mf_flow_rank = ? "
        "WHERE symbol = ? AND date = ?",
        params,
    )
    sector_written = feats["mf_flow_vs_sector"].notna().sum()
    print(
        f"[OWN] Updated ownership-relative flow on {n} technical_signals rows "
        f"({len(feats)} symbol-dates); {sector_written} have sector-relative flow."
    )
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cross-sectional ownership-flow engine")
    parser.add_argument("--date", help="If 'today', only update today's rows")
    args = parser.parse_args()
    run(only_date=args.date)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
