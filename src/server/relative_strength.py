"""
Cross-Sectional Relative-Strength Feature Engine
=================================================
The ensemble's momentum is absolute (sector_ret_5d/21d). Cross-sectional rank — where a
stock's trailing return sits *relative to the whole universe on the same day* — is the most
robust equity-momentum factor (Jegadeesh-Titman / AQR). It is fully derivable from
stock_ohlcv, no new feed.

For each (symbol, date) it writes the universe percentile rank of the 21-day and 63-day
return into technical_signals.rs_rank_21d / rs_rank_63d (0=worst, 1=best). The 63-day return
is skip-month adjusted (t-63 to t-21, excluding the most recent ~month) per Jegadeesh-Titman
-- see SKIP_MONTH_DAYS below for why. ml_ensemble joins them via the existing
technical_signals join.

Run:  python relative_strength.py
      python relative_strength.py --date today
"""

import argparse
import datetime

import pandas as pd

from db_compat import read_df, executemany, connect, translate
from as_of import logical_trading_date

LOOKBACK_DAYS = 420   # enough to cover a 63-day return plus buffer
RET_WINDOWS = (21, 63)
MIN_UNIVERSE = 20     # need a reasonable cross-section before a rank is meaningful
MIN_SECTOR_SIZE = 5   # minimum stocks in a sector before computing sector avg

# Fixed 2026-07-30 (Finding #25, full-stack audit): the 63-day window was plain trailing
# return (wide.pct_change(63)) with no skip-month treatment -- Jegadeesh-Titman (1993)
# cross-sectional momentum specifically excludes the most recent month because short-term
# reversal is a distinct, opposite-signed effect that dilutes (and can invert) the momentum
# signal in exactly the window it's most sensitive to. multi_factor_scorer.py already
# implements this correctly (12M-minus-1M) but for a completely different, unscheduled
# horizon -- rather than wire a whole new unscheduled engine into unified_ranker.py's
# regime-weighted engine_maps (a much larger, higher-risk change to the canonical ranker),
# this applies the same skip-month principle directly to relative_strength.py's own 63-day
# window, scaled to its horizon: return from (t-63) to (t-21) instead of (t-63) to (t). The
# 21-day window is left as pure short-horizon momentum -- it's too short to sensibly "skip a
# month" from (there'd be nothing left), and it's a distinct, intentionally-short signal, not
# an under-cooked version of the 63-day one.
SKIP_MONTH_DAYS = 21


def _windowed_return(wide: pd.DataFrame, w: int) -> pd.DataFrame:
    """Cross-sectional trailing return over window `w`, skip-month-adjusted for the 63-day
    window (return from t-w to t-SKIP_MONTH_DAYS, excluding the most recent ~month)."""
    if w > SKIP_MONTH_DAYS:
        return wide.shift(SKIP_MONTH_DAYS).pct_change(w - SKIP_MONTH_DAYS)
    return wide.pct_change(w)


def ensure_schema() -> None:
    """Add rs_vs_sector_21d / rs_vs_sector_63d columns to technical_signals if missing."""
    for col in ("rs_vs_sector_21d", "rs_vs_sector_63d"):
        try:
            conn = connect()
            conn.execute(translate(f"ALTER TABLE technical_signals ADD COLUMN {col} REAL"))
            conn.commit()
            conn.close()
            print(f"[RS] Added column technical_signals.{col}")
        except Exception:
            try:
                conn.rollback()
                conn.close()
            except Exception:
                pass


def cross_sectional_rank(returns: pd.DataFrame, min_universe: int = MIN_UNIVERSE) -> pd.DataFrame:
    """Percentile-rank each row (a date) across columns (symbols). `returns` is a
    dates×symbols frame of trailing returns. Returns the same shape in [0,1]; rows with
    fewer than `min_universe` non-NaN names are left NaN (too thin to rank fairly)."""
    counts = returns.notna().sum(axis=1)
    ranked = returns.rank(axis=1, pct=True)
    ranked = ranked.where(counts >= min_universe, other=pd.NA)
    return ranked


def build_sector_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """ohlcv: long frame (symbol, date, close, sector). Returns long frame with
    rs_vs_sector_21d and rs_vs_sector_63d columns (stock return minus sector avg return)."""
    if ohlcv.empty or "sector" not in ohlcv.columns:
        return pd.DataFrame(columns=["symbol", "date", "rs_vs_sector_21d", "rs_vs_sector_63d"])

    # Build wide close prices keyed by symbol
    wide = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()

    # Build symbol→sector map (drop nulls)
    sector_map = (
        ohlcv[["symbol", "sector"]]
        .dropna(subset=["sector"])
        .drop_duplicates("symbol")
        .set_index("symbol")["sector"]
    )

    out = None
    for w in RET_WINDOWS:
        rets = _windowed_return(wide, w)  # dates × symbols, float returns (skip-month for w=63)

        # For each date compute sector-avg returns (equal-weight, min MIN_SECTOR_SIZE stocks)
        # Melt returns into long form so we can groupby sector
        rets_long = (
            rets.stack(future_stack=True)
            .dropna()
            .rename("ret")
            .reset_index()
        )
        rets_long["sector"] = rets_long["symbol"].map(sector_map)
        rets_long = rets_long.dropna(subset=["sector"])

        sector_avg = (
            rets_long.groupby(["date", "sector"])["ret"]
            .agg(["mean", "count"])
            .reset_index()
            .rename(columns={"mean": "sector_avg", "count": "sector_n"})
        )
        # Require at least MIN_SECTOR_SIZE stocks in the sector
        sector_avg = sector_avg[sector_avg["sector_n"] >= MIN_SECTOR_SIZE][
            ["date", "sector", "sector_avg"]
        ]

        merged = rets_long.merge(sector_avg, on=["date", "sector"], how="left")
        merged[f"rs_vs_sector_{w}d"] = merged["ret"] - merged["sector_avg"]

        long = merged[["symbol", "date", f"rs_vs_sector_{w}d"]]
        out = long if out is None else out.merge(long, on=["date", "symbol"], how="outer")

    out = out[["symbol", "date", "rs_vs_sector_21d", "rs_vs_sector_63d"]]
    return out.dropna(subset=["rs_vs_sector_21d", "rs_vs_sector_63d"], how="all")


def build_rs_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """ohlcv: long frame (symbol, date, close[, sector]). Returns long frame with
    rs_rank_21d, rs_rank_63d, rs_vs_sector_21d, rs_vs_sector_63d ready for upsert."""
    cols = ["symbol", "date", "rs_rank_21d", "rs_rank_63d",
            "rs_vs_sector_21d", "rs_vs_sector_63d"]
    if ohlcv.empty:
        return pd.DataFrame(columns=cols)

    wide = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    out = None
    for w in RET_WINDOWS:
        rets = _windowed_return(wide, w)  # skip-month for w=63, see SKIP_MONTH_DAYS
        ranks = cross_sectional_rank(rets)
        long = ranks.stack(future_stack=True).dropna().rename(f"rs_rank_{w}d").reset_index()
        out = long if out is None else out.merge(long, on=["date", "symbol"], how="outer")

    out = out[["symbol", "date", "rs_rank_21d", "rs_rank_63d"]]
    out = out.dropna(subset=["rs_rank_21d", "rs_rank_63d"], how="all")

    # Sector-relative features (independent pass, outer-merged)
    if "sector" in ohlcv.columns:
        sector_feats = build_sector_features(ohlcv)
        if not sector_feats.empty:
            out = out.merge(sector_feats, on=["symbol", "date"], how="left")
        else:
            out["rs_vs_sector_21d"] = None
            out["rs_vs_sector_63d"] = None
    else:
        out["rs_vs_sector_21d"] = None
        out["rs_vs_sector_63d"] = None

    return out


def filter_to_existing(feats: pd.DataFrame, existing_pairs: set) -> pd.DataFrame:
    """Keep only the (symbol, date) rows that actually exist in technical_signals. RS is computed
    for the whole universe (~560k symbol-dates) but only a few thousand have a technical_signals
    row to attach to — filtering first turns a 560k-row UPDATE into a few-thousand-row one."""
    if feats.empty:
        return feats
    mask = [(s, d) in existing_pairs for s, d in zip(feats["symbol"], feats["date"])]
    return feats[pd.Series(mask, index=feats.index)]


def run(only_date: str | None = None) -> int:
    """Compute cross-sectional RS ranks + sector-relative RS and write them onto
    technical_signals. Returns rows updated."""
    ensure_schema()

    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    ohlcv = read_df(
        "SELECT o.symbol, o.date, o.close, ns.sector "
        "FROM stock_ohlcv o "
        "JOIN nse_stocks ns ON ns.symbol = o.symbol "
        "WHERE o.date >= ? AND COALESCE(o.is_suspect, 0) = 0 "
        "ORDER BY o.date",
        (cutoff,),
    )
    feats = build_rs_features(ohlcv)
    if only_date:
        # logical_trading_date(), not date.today() (2026-08-01) -- not currently reachable in
        # production (queues.ts calls this with no --date arg), but `--date today` is this
        # script's own documented usage pattern, and ml-daily-ops's step chain regularly
        # finishes after midnight IST -- see as_of.logical_trading_date's docstring.
        target = logical_trading_date() if only_date == "today" else only_date
        feats = feats[feats["date"] == target]
    if feats.empty:
        print("[RS] No relative-strength features to write.")
        return 0

    # stock_ohlcv.date is a DATE column on Postgres (read back as date objects) but
    # technical_signals.date is TEXT — normalize to 'YYYY-MM-DD' so the UPDATE join matches
    # on both engines (P3f rule: str-normalize a DATE value before binding to a TEXT column).
    feats = feats.copy()
    feats["date"] = pd.to_datetime(feats["date"]).dt.strftime("%Y-%m-%d")

    # Only update rows that exist in technical_signals (avoids ~560k no-op UPDATEs on PG).
    ts = read_df("SELECT symbol, date FROM technical_signals")
    existing = set(zip(ts["symbol"], ts["date"].astype(str)))
    feats = filter_to_existing(feats, existing)
    if feats.empty:
        print("[RS] No matching technical_signals rows to update.")
        return 0

    def _fval(v):
        return None if pd.isna(v) else float(v)

    params = [
        (_fval(r.rs_rank_21d), _fval(r.rs_rank_63d),
         _fval(r.rs_vs_sector_21d), _fval(r.rs_vs_sector_63d),
         r.symbol, r.date)
        for r in feats.itertuples(index=False)
    ]
    n = executemany(
        "UPDATE technical_signals "
        "SET rs_rank_21d = ?, rs_rank_63d = ?, "
        "    rs_vs_sector_21d = ?, rs_vs_sector_63d = ? "
        "WHERE symbol = ? AND date = ?",
        params,
    )
    sector_written = feats["rs_vs_sector_21d"].notna().sum()
    print(
        f"[RS] Updated rs_rank on {n} technical_signals rows ({len(feats)} symbol-dates); "
        f"{sector_written} rows have sector-relative RS."
    )
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cross-sectional relative-strength engine")
    parser.add_argument("--date", help="If 'today', only update today's rows")
    args = parser.parse_args()
    run(only_date=args.date)
