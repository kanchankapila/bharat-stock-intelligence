"""
Market-Breadth / Internals Engine
=================================
`nifty_regime` is a 3-class label; continuous breadth turns the same daily bars into
leading internals the label can't express — how broad a move is, not just its direction.
All four series are computed from our own `stock_ohlcv` universe, no new feed, and are
fully backfillable from history.

Per trading date it writes:
  - pct_above_200dma   fraction of the universe trading above its 200-day SMA   (trend breadth)
  - adv_decline_ratio  advancers / (advancers + decliners) vs the prior close   (daily thrust)
  - pct_at_20d_high    fraction making a fresh 20-day high                       (momentum breadth)
  - net_highs_lows     (52w new-highs − 52w new-lows) / universe                 (regime turns)

into the `market_breadth` table. ml_ensemble joins it by date (like `nifty_regime`).

Run:  python market_breadth.py            # full backfill from all history
      python market_breadth.py --days 420 # bound the read for a fast daily top-up
"""

import polars as pl
import argparse
import datetime

import numpy as np
import pandas as pd

from db_compat import read_df, executemany

SMA_WINDOW = 200       # trend reference
HIGH_WINDOW = 20       # short-term momentum-breadth lookback
HL_WINDOW = 252        # ~52 trading weeks for new-high / new-low
MIN_UNIVERSE = 20      # need a real cross-section before breadth is meaningful

_COLUMNS = ["pct_above_200dma", "adv_decline_ratio", "pct_at_20d_high", "net_highs_lows"]


def compute_breadth(closes: pd.DataFrame,
                    sma_window: int = SMA_WINDOW,
                    high_window: int = HIGH_WINDOW,
                    hl_window: int = HL_WINDOW,
                    min_universe: int = MIN_UNIVERSE) -> pd.DataFrame:
    """closes: a dates×symbols wide frame of close prices. Returns a date-indexed frame with
    the four breadth series. Days with fewer than `min_universe` listed names are left NaN
    (too thin to measure breadth fairly)."""
    if closes.empty:
        return pd.DataFrame(columns=_COLUMNS)

    closes = closes.sort_index()

    # ── Trend breadth: above the 200-day SMA ──
    sma = closes.rolling(sma_window, min_periods=sma_window).mean()
    above = (closes > sma).where(sma.notna())
    sma_n = sma.notna().sum(axis=1).replace(0, np.nan)
    pct_above_200dma = above.sum(axis=1) / sma_n

    # ── Daily thrust: advancers vs decliners on the day ──
    chg = closes.diff()
    adv = (chg > 0).sum(axis=1)
    dec = (chg < 0).sum(axis=1)
    adv_decline_ratio = adv / (adv + dec).replace(0, np.nan)

    # ── Momentum breadth: fresh short-term highs ──
    roll_hi = closes.rolling(high_window, min_periods=high_window).max()
    at_high = (closes >= roll_hi).where(roll_hi.notna())
    hi_n = roll_hi.notna().sum(axis=1).replace(0, np.nan)
    pct_at_20d_high = at_high.sum(axis=1) / hi_n

    # ── Regime turns: net 52-week new highs minus new lows ──
    roll_hl_hi = closes.rolling(hl_window, min_periods=hl_window).max()
    roll_hl_lo = closes.rolling(hl_window, min_periods=hl_window).min()
    valid_hl = roll_hl_hi.notna()
    new_high = ((closes >= roll_hl_hi) & valid_hl).sum(axis=1)
    new_low = ((closes <= roll_hl_lo) & valid_hl).sum(axis=1)
    hl_n = valid_hl.sum(axis=1).replace(0, np.nan)
    net_highs_lows = (new_high - new_low) / hl_n

    out = pd.DataFrame({
        "pct_above_200dma": pct_above_200dma,
        "adv_decline_ratio": adv_decline_ratio,
        "pct_at_20d_high": pct_at_20d_high,
        "net_highs_lows": net_highs_lows,
    })

    universe = closes.notna().sum(axis=1)
    out = out.where(universe >= min_universe)
    out.index.name = "date"
    return out


def run(days: int | None = None) -> int:
    """Read close history from stock_ohlcv, compute breadth per date, upsert market_breadth.
    Returns rows written. `days` bounds the read for a fast daily top-up (full backfill if None)."""
    where = "WHERE COALESCE(is_suspect,0) = 0"
    params: tuple = ()
    if days:
        cutoff = (datetime.date.today() - datetime.timedelta(days=days)).isoformat()
        where = "WHERE date >= ? AND COALESCE(is_suspect,0) = 0"
        params = (cutoff,)

    ohlcv = read_df(
        f"SELECT symbol, date, close FROM stock_ohlcv {where} ORDER BY date", params,
    )
    if ohlcv.empty:
        print("[BREADTH] No OHLCV rows to compute breadth from.")
        return 0

    wide = ohlcv.pivot_table(index="date", columns="symbol", values="close").sort_index()
    breadth = compute_breadth(wide)
    breadth = breadth.dropna(how="all")
    if breadth.empty:
        print("[BREADTH] No breadth rows to write (universe too thin / insufficient history).")
        return 0

    now = datetime.datetime.now().isoformat()
    rows = [
        (str(date),
         None if pd.isna(r.pct_above_200dma) else float(r.pct_above_200dma),
         None if pd.isna(r.adv_decline_ratio) else float(r.adv_decline_ratio),
         None if pd.isna(r.pct_at_20d_high) else float(r.pct_at_20d_high),
         None if pd.isna(r.net_highs_lows) else float(r.net_highs_lows),
         now)
        for date, r in breadth.iterrows()
    ]
    n = executemany(
        """INSERT INTO market_breadth
             (date, pct_above_200dma, adv_decline_ratio, pct_at_20d_high, net_highs_lows, computed_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(date) DO UPDATE SET
             pct_above_200dma = excluded.pct_above_200dma,
             adv_decline_ratio = excluded.adv_decline_ratio,
             pct_at_20d_high = excluded.pct_at_20d_high,
             net_highs_lows = excluded.net_highs_lows,
             computed_at = excluded.computed_at""",
        rows,
    )
    print(f"[BREADTH] Upserted breadth for {len(rows)} dates ({n} rows).")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Market-breadth / internals engine")
    parser.add_argument("--days", type=int, help="Bound the OHLCV read to the last N days (default: full backfill)")
    args = parser.parse_args()
    run(days=args.days)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
