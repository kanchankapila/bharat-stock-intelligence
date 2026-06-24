"""
Cross-Sectional Relative-Strength Feature Engine
=================================================
The ensemble's momentum is absolute (sector_ret_5d/21d). Cross-sectional rank — where a
stock's trailing return sits *relative to the whole universe on the same day* — is the most
robust equity-momentum factor (Jegadeesh-Titman / AQR). It is fully derivable from
stock_ohlcv, no new feed.

For each (symbol, date) it writes the universe percentile rank of the 21-day and 63-day
return into technical_signals.rs_rank_21d / rs_rank_63d (0=worst, 1=best). ml_ensemble joins
them via the existing technical_signals join.

Run:  python relative_strength.py
      python relative_strength.py --date today
"""

import argparse
import datetime

import pandas as pd

from db_compat import read_df, executemany

LOOKBACK_DAYS = 420   # enough to cover a 63-day return plus buffer
RET_WINDOWS = (21, 63)
MIN_UNIVERSE = 20     # need a reasonable cross-section before a rank is meaningful


def cross_sectional_rank(returns: pd.DataFrame, min_universe: int = MIN_UNIVERSE) -> pd.DataFrame:
    """Percentile-rank each row (a date) across columns (symbols). `returns` is a
    dates×symbols frame of trailing returns. Returns the same shape in [0,1]; rows with
    fewer than `min_universe` non-NaN names are left NaN (too thin to rank fairly)."""
    counts = returns.notna().sum(axis=1)
    ranked = returns.rank(axis=1, pct=True)
    ranked = ranked.where(counts >= min_universe, other=pd.NA)
    return ranked


def build_rs_features(ohlcv: pd.DataFrame) -> pd.DataFrame:
    """ohlcv: long frame (symbol, date, close). Returns long (symbol, date, rs_rank_21d,
    rs_rank_63d) ready to upsert onto technical_signals."""
    if ohlcv.empty:
        return pd.DataFrame(columns=["symbol", "date", "rs_rank_21d", "rs_rank_63d"])

    wide = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    out = None
    for w in RET_WINDOWS:
        rets = wide.pct_change(w)
        ranks = cross_sectional_rank(rets)
        long = ranks.stack(future_stack=True).dropna().rename(f"rs_rank_{w}d").reset_index()
        out = long if out is None else out.merge(long, on=["date", "symbol"], how="outer")

    out = out[["symbol", "date", "rs_rank_21d", "rs_rank_63d"]]
    return out.dropna(subset=["rs_rank_21d", "rs_rank_63d"], how="all")


def filter_to_existing(feats: pd.DataFrame, existing_pairs: set) -> pd.DataFrame:
    """Keep only the (symbol, date) rows that actually exist in technical_signals. RS is computed
    for the whole universe (~560k symbol-dates) but only a few thousand have a technical_signals
    row to attach to — filtering first turns a 560k-row UPDATE into a few-thousand-row one."""
    if feats.empty:
        return feats
    mask = [(s, d) in existing_pairs for s, d in zip(feats["symbol"], feats["date"])]
    return feats[pd.Series(mask, index=feats.index)]


def run(only_date: str | None = None) -> int:
    """Compute cross-sectional RS ranks and write them onto technical_signals. Returns rows
    updated."""
    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()
    ohlcv = read_df(
        "SELECT o.symbol, o.date, o.close "
        "FROM stock_ohlcv o "
        "JOIN nse_stocks ns ON ns.symbol = o.symbol "
        "WHERE o.date >= ? AND COALESCE(o.is_suspect, 0) = 0 "
        "ORDER BY o.date",
        (cutoff,),
    )
    feats = build_rs_features(ohlcv)
    if only_date:
        target = datetime.date.today().isoformat() if only_date == "today" else only_date
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

    params = [
        (None if pd.isna(r.rs_rank_21d) else float(r.rs_rank_21d),
         None if pd.isna(r.rs_rank_63d) else float(r.rs_rank_63d),
         r.symbol, r.date)
        for r in feats.itertuples(index=False)
    ]
    n = executemany(
        "UPDATE technical_signals SET rs_rank_21d = ?, rs_rank_63d = ? "
        "WHERE symbol = ? AND date = ?",
        params,
    )
    print(f"[RS] Updated rs_rank on {n} technical_signals rows ({len(feats)} symbol-dates).")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Cross-sectional relative-strength engine")
    parser.add_argument("--date", help="If 'today', only update today's rows")
    args = parser.parse_args()
    run(only_date=args.date)
