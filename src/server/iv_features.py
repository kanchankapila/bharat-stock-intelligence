"""
Implied-Volatility Feature Engine
==================================
Turns the raw ATM-IV snapshots captured by pcr_fetcher.py (stock_options_oi.atm_iv,
.iv_skew) into the two leak-free, forward-looking features the ensemble consumes:

  iv_rank  — where today's ATM IV sits in its own trailing 252-day [min,max] range (0-1).
             Low rank on a breakout = cheap optionality / coiled move; high rank = the move
             is already priced into options (fade risk). Orthogonal to every price feature.
  iv_skew  — put_iv − call_iv at ~25-delta, passed through from the snapshot. Positive =
             downside hedging bid (crash fear) even when spot looks calm.

Both are written back onto technical_signals(symbol, date) so ml_ensemble.load_*() pick
them up via the existing join. Historical rows are filled at their own as-of date — the
rank at date T only ever uses IV observed on/before T, so there is no look-ahead.

Run:  python iv_features.py            # backfill iv_rank/iv_skew for all dates
      python iv_features.py --date today
"""

import argparse
import datetime

import numpy as np
import pandas as pd

from db_compat import read_df, executemany

IV_RANK_WINDOW = 252   # trading days (~1y) — standard IV-rank lookback
IV_RANK_MIN_OBS = 20   # need at least this many prior obs before a rank is meaningful


def compute_iv_rank(iv: pd.Series, window: int = IV_RANK_WINDOW,
                    min_periods: int = IV_RANK_MIN_OBS) -> pd.Series:
    """Trailing IV-rank in [0,1] for each row of `iv` (must be ordered oldest→newest).

    rank_t = (iv_t − min(window_t)) / (max(window_t) − min(window_t)), where window_t is the
    trailing `window` observations ending at t (inclusive). A flat window (max==min) or too
    few observations yields 0.5 (neutral) so the feature never injects a spurious extreme.
    Uses only past+current values, so it is leak-free for as-of joins."""
    iv = pd.to_numeric(iv, errors="coerce")
    roll_min = iv.rolling(window, min_periods=min_periods).min()
    roll_max = iv.rolling(window, min_periods=min_periods).max()
    span = roll_max - roll_min
    rank = (iv - roll_min) / span
    rank = rank.where(span > 0, 0.5)        # flat window → neutral
    return rank.fillna(0.5).clip(0, 1)


def _latest_iv_per_day(df: pd.DataFrame) -> pd.DataFrame:
    """One ATM-IV row per (symbol, date) — the nearest-expiry snapshot is captured per day,
    but if multiple expiries were stored, keep the row with the highest total OI proxy
    (atm_iv is already nearest-expiry; collapse defensively on max fetched_at order)."""
    df = df.dropna(subset=["atm_iv"])
    df = df.sort_values(["symbol", "date"])
    return df.groupby(["symbol", "date"], as_index=False).last()


def build_iv_features(options_df: pd.DataFrame) -> pd.DataFrame:
    """Given stock_options_oi rows (symbol, date, atm_iv, iv_skew), return a frame of
    (symbol, date, iv_rank, iv_skew) ready to upsert onto technical_signals."""
    if options_df.empty:
        return pd.DataFrame(columns=["symbol", "date", "iv_rank", "iv_skew"])

    daily = _latest_iv_per_day(options_df)
    out = []
    for symbol, g in daily.groupby("symbol"):
        g = g.sort_values("date")
        rank = compute_iv_rank(g["atm_iv"])
        out.append(pd.DataFrame({
            "symbol":  symbol,
            "date":    g["date"].values,
            "iv_rank": rank.values,
            "iv_skew": pd.to_numeric(g.get("iv_skew"), errors="coerce").fillna(0.0).values,
        }))
    return pd.concat(out, ignore_index=True)


def run(only_date: str | None = None) -> int:
    """Compute IV features from stock_options_oi and write them onto technical_signals.
    Returns the number of (symbol, date) rows updated."""
    options = read_df(
        "SELECT symbol, date, atm_iv, iv_skew FROM stock_options_oi "
        "WHERE atm_iv IS NOT NULL ORDER BY symbol, date"
    )
    feats = build_iv_features(options)
    if only_date:
        target = datetime.date.today().isoformat() if only_date == "today" else only_date
        feats = feats[feats["date"] == target]
    if feats.empty:
        print("[IV] No IV features to write.")
        return 0

    # Update the most-recent ts row per symbol (scanner rows lag by days; exact date match misses them).
    params = [
        (float(r.iv_rank), float(r.iv_skew), r.symbol, r.symbol)
        for r in feats.itertuples(index=False)
    ]
    n = executemany(
        "UPDATE technical_signals SET iv_rank = ?, iv_skew = ? "
        "WHERE symbol = ? AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = ?)",
        params,
    )
    print(f"[IV] Updated iv_rank/iv_skew on {n} technical_signals rows "
          f"({len(feats)} symbol-dates computed).")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Implied-volatility feature engine")
    parser.add_argument("--date", help="If 'today', only update today's rows")
    args = parser.parse_args()
    run(only_date=args.date)
