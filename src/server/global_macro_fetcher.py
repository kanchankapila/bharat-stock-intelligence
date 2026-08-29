#!/usr/bin/env python3
"""Fetch global macro indicators via yfinance and persist to macro_asset_prices table."""

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class GlobalMacroFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class GlobalMacroFetcherBaseFetcher(BaseFetcher[GlobalMacroFetcherSchema]):
    fetcher_name = 'GlobalMacroFetcher'
    domain = 'general'
    schema = GlobalMacroFetcherSchema
    min_interval_sec = 0.5


import sys
from datetime import datetime, timedelta

import yfinance as yf
import pandas as pd
from curl_cffi import requests as cffi_requests

from db_compat import connect

TICKERS = {
    "^TNX":      "US10Y",
    "DX-Y.NYB":  "DXY",
    "CL=F":      "CRUDE",
    "GC=F":      "GOLD",
    "^GSPC":     "SP500",
    "^NSEBANK":  "NSEBANK",
    "^NSEI":     "NIFTY50",
    "^INDIAVIX": "INDIAVIX",
}

# Labels that feature_engineering reads from stock_ohlcv (not just macro_asset_prices)
OHLCV_WRITE_LABELS = {"NIFTY50"}


def fetch_macro(days: int = 30) -> None:
    end = datetime.today()
    start = end - timedelta(days=days + 10)  # buffer for weekends

    con = connect()
    cur = con.cursor()

    for ticker, label in TICKERS.items():
        try:
            df = yf.download(ticker, start=start.strftime("%Y-%m-%d"),
                             end=end.strftime("%Y-%m-%d"), progress=False, auto_adjust=True)
            if df.empty:
                print(f"[MACRO] No data for {ticker}")
                continue

            # Flatten MultiIndex columns if present (yfinance >= 0.2 single-ticker quirk)
            if isinstance(df.columns, pd.MultiIndex):
                df.columns = df.columns.get_level_values(0)

            df.index = pd.to_datetime(df.index)

            # ── Write to macro_asset_prices ──────────────────────────────────
            close_col = "Close" if "Close" in df.columns else df.columns[0]
            df_macro = df[[close_col]].copy().rename(columns={close_col: "Close"})
            df_macro["ret_1d"] = df_macro["Close"].pct_change(1)
            df_macro["ret_5d"] = df_macro["Close"].pct_change(5)

            macro_rows = []
            for date, row in df_macro.iterrows():
                macro_rows.append((
                    date.strftime("%Y-%m-%d"),
                    label,
                    float(row["Close"]) if pd.notna(row["Close"]) else None,
                    float(row["ret_1d"]) if pd.notna(row["ret_1d"]) else None,
                    float(row["ret_5d"]) if pd.notna(row["ret_5d"]) else None,
                    datetime.now().isoformat(),
                ))

            cur.executemany(
                """INSERT INTO macro_asset_prices
                   (date, symbol, close, ret_1d, ret_5d, fetched_at)
                   VALUES (?, ?, ?, ?, ?, ?)
                   ON CONFLICT(date, symbol) DO UPDATE SET
                     close=excluded.close, ret_1d=excluded.ret_1d,
                     ret_5d=excluded.ret_5d, fetched_at=excluded.fetched_at""",
                macro_rows,
            )

            # Also write to macro_indicators (indicator_name, date, value)
            # Bug-fix 8: use named tuple positions (date_str=0, label=1, close=2) explicitly
            # instead of positional row[0]/row[2], which would silently use wrong values if
            # the macro_rows tuple structure ever changes.
            indicator_rows = [
                (label, date_str, close_val)
                for date_str, _lbl, close_val, _r1d, _r5d, _fetched in macro_rows
                if close_val is not None
            ]
            cur.executemany(
                """INSERT INTO macro_indicators
                   (indicator_name, date, value)
                   VALUES (?, ?, ?)
                   ON CONFLICT(indicator_name, date) DO UPDATE SET
                     value=excluded.value""",
                indicator_rows,
            )
            con.commit()
            print(f"[MACRO] {label}: {len(macro_rows)} rows upserted (and written to macro_indicators)")

            # ── Also write to stock_ohlcv for index symbols ──────────────────
            # feature_engineering.py reads NIFTY50 from stock_ohlcv for nifty_ret_5d/21d
            if label in OHLCV_WRITE_LABELS:
                has_ohlc = all(c in df.columns for c in ["Open", "High", "Low", "Close"])
                ohlcv_rows = []
                for date, row in df.iterrows():
                    close_val = float(row["Close"]) if pd.notna(row.get("Close")) else None
                    if close_val is None:
                        continue
                    ohlcv_rows.append((
                        label,
                        date.strftime("%Y-%m-%d"),
                        float(row["Open"])  if has_ohlc and pd.notna(row["Open"])  else close_val,
                        float(row["High"])  if has_ohlc and pd.notna(row["High"])  else close_val,
                        float(row["Low"])   if has_ohlc and pd.notna(row["Low"])   else close_val,
                        close_val,
                        int(row["Volume"]) if "Volume" in df.columns and pd.notna(row.get("Volume")) else 0,
                    ))

                if ohlcv_rows:
                    cur.executemany(
                        """INSERT INTO stock_ohlcv
                           (symbol, date, open, high, low, close, volume)
                           VALUES (?, ?, ?, ?, ?, ?, ?)
                           ON CONFLICT(symbol, date) DO UPDATE SET
                             open=excluded.open, high=excluded.high, low=excluded.low,
                             close=excluded.close, volume=excluded.volume""",
                        ohlcv_rows,
                    )
                    con.commit()
                    print(f"[MACRO] {label}: {len(ohlcv_rows)} rows written to stock_ohlcv")

        except Exception as e:
            print(f"[MACRO] ERROR {ticker}: {e}")

    con.close()

_BOND_NAME_MAP = {
    "India 10yr":         "INDIA_10Y",
    "United States 10yr": "US10Y_MC",
    "United Kingdom 10yr": "UK_10Y",
    "Germany 10yr":       "DE_10Y",
}

_BOND_HEADERS = {
    "Origin":     "https://www.moneycontrol.com",
    "Referer":    "https://www.moneycontrol.com/",
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept":     "application/json",
}

_BOND_URL = "https://api.moneycontrol.com/mcapi/v1/premarket/get-global-marketdata?section=bo"


def fetch_bond_yields() -> None:
    try:
        resp = cffi_requests.get(_BOND_URL, headers=_BOND_HEADERS, impersonate="chrome110", timeout=15)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        print(f"[MacroFetch] Bond yields fetch ERROR: {e}")
        return

    if not payload.get("success") or not payload.get("data"):
        print(f"[MacroFetch] Bond yields: unexpected response: {payload}")
        return

    today = datetime.today().strftime("%Y-%m-%d")
    fetched_at = datetime.now().isoformat()

    yields: dict[str, float] = {}
    rows = []

    for item in payload["data"]:
        name = item.get("name", "").strip()
        asset_name = _BOND_NAME_MAP.get(name)
        if not asset_name:
            continue
        try:
            ltp = float(item["ltp"])
        except (KeyError, ValueError, TypeError):
            continue
        yields[name] = ltp
        rows.append((today, asset_name, ltp, None, None, fetched_at))

    # Derived spread: India 10yr - US 10yr
    india_val = yields.get("India 10yr")
    us_val = yields.get("United States 10yr")
    if india_val is not None and us_val is not None:
        spread = round(india_val - us_val, 4)
        rows.append((today, "INDIA_US_SPREAD", spread, None, None, fetched_at))
    else:
        spread = None

    if not rows:
        print("[MacroFetch] Bond yields: no usable rows to write")
        return

    con = connect()
    cur = con.cursor()
    cur.executemany(
        """INSERT INTO macro_asset_prices
           (date, symbol, close, ret_1d, ret_5d, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(date, symbol) DO UPDATE SET
             close=excluded.close, ret_1d=excluded.ret_1d,
             ret_5d=excluded.ret_5d, fetched_at=excluded.fetched_at""",
        rows,
    )
    con.commit()
    con.close()

    spread_bps = f"{spread * 100:.1f}" if spread is not None else "n/a"
    print(
        f"[MacroFetch] Bond yields: India={india_val}% US={us_val}% "
        f"spread={spread_bps}bps — {len(rows)} rows upserted"
    )


if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fetch_macro(days)
    fetch_bond_yields()
    print("[MACRO] Done")

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
