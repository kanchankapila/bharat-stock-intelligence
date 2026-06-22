#!/usr/bin/env python3
"""Fetch global macro indicators via yfinance and persist to macro_asset_prices table."""

import sys
from datetime import datetime, timedelta

import yfinance as yf
import pandas as pd

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
            indicator_rows = [(label, row[0], row[2]) for row in macro_rows if row[2] is not None]
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

if __name__ == "__main__":
    days = int(sys.argv[1]) if len(sys.argv) > 1 else 30
    fetch_macro(days)
    print("[MACRO] Done")
