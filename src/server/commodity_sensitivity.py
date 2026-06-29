"""
Commodity / Macro Sensitivity Feature Engine
============================================
Computes 90-day rolling Pearson correlation of each stock's daily returns with
macro factor returns (CRUDE, GOLD, DXY, SP500) and writes four columns onto the
most-recent technical_signals row for each symbol:

    crude_corr_90d   -- correlation with crude oil (CL=F)
    gold_corr_90d    -- correlation with gold (GC=F)
    dxy_corr_90d     -- correlation with USD index (DX-Y.NYB)
    sp500_corr_90d   -- correlation with S&P 500 (^GSPC)

Signal interpretation:
  crude_corr_90d  > 0.4  → oil & gas, aviation, paints (crude-price sensitive)
  gold_corr_90d   > 0.4  → precious metals / jewellery sector exposure
  dxy_corr_90d    < -0.3 → IT exporters, pharma (benefit when USD rises)
  sp500_corr_90d  high   → global cyclicals; low → defensives / domestics

Data sources:
  macro_asset_prices (asset_name TEXT, date TEXT, close REAL)  ← global_macro_fetcher.py
  stock_ohlcv        (symbol TEXT, date TEXT, close REAL, is_suspect INTEGER)

Run:
    python commodity_sensitivity.py
    python commodity_sensitivity.py --symbol HDFCBANK
    python commodity_sensitivity.py --days 90
"""

import argparse
import datetime

import numpy as np
import pandas as pd

from db_compat import connect, executemany, read_df, translate

# ---------------------------------------------------------------------------
# Constants
# ---------------------------------------------------------------------------
MACRO_ASSETS = ["CRUDE", "GOLD", "DXY", "SP500"]
DEFAULT_WINDOW = 90          # correlation window in trading days
LOOKBACK_DAYS = 420          # how far back to load data (window + buffer)
MIN_OVERLAP = 45             # minimum aligned dates required for a valid correlation


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------
COLUMNS = [
    "crude_corr_90d",
    "gold_corr_90d",
    "dxy_corr_90d",
    "sp500_corr_90d",
]


def ensure_schema() -> None:
    """Add the four corr columns to technical_signals if they are missing."""
    for col in COLUMNS:
        try:
            conn = connect()
            conn.execute(translate(f"ALTER TABLE technical_signals ADD COLUMN {col} REAL"))
            conn.commit()
            conn.close()
            print(f"[CommoditySensitivity] Added column technical_signals.{col}")
        except Exception:
            try:
                conn.rollback()
                conn.close()
            except Exception:
                pass


# ---------------------------------------------------------------------------
# Data loading
# ---------------------------------------------------------------------------

def load_macro_returns(cutoff: str) -> pd.DataFrame:
    """Return a wide DataFrame (date × asset) of daily log-returns for each macro factor.
    Returns empty DataFrame if macro_asset_prices table has no data."""
    try:
        raw = read_df(
            "SELECT symbol, date, close FROM macro_asset_prices "
            "WHERE symbol IN ('CRUDE','GOLD','DXY','SP500') AND date >= ? "
            "ORDER BY date",
            (cutoff,),
        )
    except Exception as exc:
        print(f"[CommoditySensitivity] Could not read macro_asset_prices: {exc}")
        return pd.DataFrame()

    if raw.empty:
        return pd.DataFrame()

    raw["date"] = pd.to_datetime(raw["date"]).dt.strftime("%Y-%m-%d")
    wide = raw.pivot_table(index="date", columns="symbol", values="close").sort_index()
    # Keep only the assets we care about (others are ignored)
    wide = wide[[c for c in MACRO_ASSETS if c in wide.columns]]
    returns = np.log(wide / wide.shift(1))
    return returns.dropna(how="all")


def load_stock_ohlcv(cutoff: str, symbol: str | None = None) -> pd.DataFrame:
    """Return long-format (symbol, date, close) from stock_ohlcv."""
    where = "WHERE o.date >= ? AND COALESCE(o.is_suspect, 0) = 0"
    params: list = [cutoff]
    if symbol:
        where += " AND o.symbol = ?"
        params.append(symbol.upper())

    ohlcv = read_df(
        f"SELECT symbol, date, close FROM stock_ohlcv o {where} ORDER BY symbol, date",
        tuple(params),
    )
    if ohlcv.empty:
        return ohlcv
    ohlcv["date"] = pd.to_datetime(ohlcv["date"]).dt.strftime("%Y-%m-%d")
    return ohlcv


# ---------------------------------------------------------------------------
# Correlation computation
# ---------------------------------------------------------------------------

def compute_corr_for_symbol(
    stock_rets: pd.Series,
    macro_rets: pd.DataFrame,
    window: int,
    min_overlap: int,
) -> dict[str, float | None]:
    """Compute Pearson correlation of `stock_rets` with each macro asset over the
    most-recent `window` trading days where both series have valid values.

    Returns a dict {asset: corr_or_None}.
    """
    result: dict[str, float | None] = {}
    for asset in MACRO_ASSETS:
        if asset not in macro_rets.columns:
            result[asset] = None
            continue
        # Align on common dates
        aligned = pd.concat(
            [stock_rets.rename("stock"), macro_rets[asset].rename("macro")],
            axis=1,
            join="inner",
        ).dropna()
        # Keep only the last `window` aligned dates
        aligned = aligned.tail(window)
        if len(aligned) < min_overlap:
            result[asset] = None
        else:
            corr = aligned["stock"].corr(aligned["macro"])
            result[asset] = None if np.isnan(corr) else round(float(corr), 6)
    return result


def build_features(
    ohlcv: pd.DataFrame,
    macro_rets: pd.DataFrame,
    window: int,
    min_overlap: int,
) -> pd.DataFrame:
    """Return a DataFrame with columns [symbol, crude_corr_90d, gold_corr_90d,
    dxy_corr_90d, sp500_corr_90d] — one row per symbol (most-recent window)."""
    if ohlcv.empty or macro_rets.empty:
        return pd.DataFrame(columns=["symbol"] + COLUMNS)

    records = []
    for sym, grp in ohlcv.groupby("symbol"):
        grp = grp.set_index("date").sort_index()
        stock_rets = np.log(grp["close"] / grp["close"].shift(1)).dropna()
        corrs = compute_corr_for_symbol(stock_rets, macro_rets, window, min_overlap)
        records.append({
            "symbol": sym,
            "crude_corr_90d": corrs.get("CRUDE"),
            "gold_corr_90d": corrs.get("GOLD"),
            "dxy_corr_90d": corrs.get("DXY"),
            "sp500_corr_90d": corrs.get("SP500"),
        })

    return pd.DataFrame(records, columns=["symbol"] + COLUMNS)


# ---------------------------------------------------------------------------
# Write helpers
# ---------------------------------------------------------------------------

def fetch_latest_ts_rows(symbols: list[str]) -> dict[str, str]:
    """Return {symbol: max_date} for the most-recent technical_signals row per symbol."""
    if not symbols:
        return {}
    ts = read_df("SELECT symbol, date FROM technical_signals")
    if ts.empty:
        return {}
    ts["date"] = ts["date"].astype(str)
    latest = ts.groupby("symbol")["date"].max()
    return latest[latest.index.isin(symbols)].to_dict()


def write_features(feats: pd.DataFrame) -> int:
    """UPDATE the most-recent technical_signals row for each symbol."""
    if feats.empty:
        return 0

    sym_date = fetch_latest_ts_rows(feats["symbol"].tolist())
    if not sym_date:
        print("[CommoditySensitivity] No technical_signals rows found to update.")
        return 0

    params = []
    for row in feats.itertuples(index=False):
        date = sym_date.get(row.symbol)
        if date is None:
            continue

        def _f(v):
            return None if (v is None or (isinstance(v, float) and np.isnan(v))) else v

        params.append((
            _f(row.crude_corr_90d),
            _f(row.gold_corr_90d),
            _f(row.dxy_corr_90d),
            _f(row.sp500_corr_90d),
            row.symbol,
            date,
        ))

    if not params:
        return 0

    n = executemany(
        "UPDATE technical_signals "
        "SET crude_corr_90d = ?, gold_corr_90d = ?, dxy_corr_90d = ?, sp500_corr_90d = ? "
        "WHERE symbol = ? AND date = ?",
        params,
    )
    return n


# ---------------------------------------------------------------------------
# Main entry point
# ---------------------------------------------------------------------------

def run(symbol: str | None = None, window: int = DEFAULT_WINDOW) -> int:
    ensure_schema()

    cutoff = (datetime.date.today() - datetime.timedelta(days=LOOKBACK_DAYS)).isoformat()

    macro_rets = load_macro_returns(cutoff)
    if macro_rets.empty:
        print("[CommoditySensitivity] macro_asset_prices is empty — writing NULLs.")

    ohlcv = load_stock_ohlcv(cutoff, symbol=symbol)
    if ohlcv.empty:
        print("[CommoditySensitivity] No stock_ohlcv data found. Nothing to do.")
        return 0

    feats = build_features(ohlcv, macro_rets, window, MIN_OVERLAP)

    n = write_features(feats)
    sym_count = feats["symbol"].nunique()
    print(f"[CommoditySensitivity] Done. {sym_count} symbols processed, {n} technical_signals rows updated.")
    return n


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Commodity / macro sensitivity feature engine")
    parser.add_argument("--symbol", help="Process a single NSE symbol only")
    parser.add_argument(
        "--days",
        type=int,
        default=DEFAULT_WINDOW,
        help=f"Correlation window in trading days (default: {DEFAULT_WINDOW})",
    )
    args = parser.parse_args()
    run(symbol=args.symbol, window=args.days)
