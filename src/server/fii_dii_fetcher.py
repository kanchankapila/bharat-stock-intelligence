"""
FII/DII Daily Flow Fetcher
===========================
Fetches FII and DII trade data from NSE API and stores it in the fii_dii_flow table.
Designed to run daily (cron or manual) after market close.

Run:  python fii_dii_fetcher.py
      python fii_dii_fetcher.py --days 30
"""

import polars as pl
import os
import datetime
import argparse
import time
import requests
import pandas as pd
from sqlalchemy import text

from db_compat import get_engine
from fetch_utils import retry_get
import sys
from pydantic import BaseModel
from base_fetcher import BaseFetcher

class FiiDiiRowSchema(BaseModel):
    category: str
    date: str
    buy_value: float | None = None
    sell_value: float | None = None
    net_value: float | None = None

class FiiDiiBaseFetcher(BaseFetcher[FiiDiiRowSchema]):
    fetcher_name = "FiiDiiFetcher"
    domain = "nseindia.com"
    schema = FiiDiiRowSchema
    min_interval_sec = 0.5


NSE_FII_DII_URL = "https://www.nseindia.com/api/fiidiiTradeReact"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.nseindia.com/market-data/fii-dii-activity",
    "DNT":             "1",
}


class FiiDiiFetcher:
    def __init__(self):
        self.engine  = get_engine()
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._prime_session()

    def _prime_session(self):
        """Prime NSE session cookie — required before API calls."""
        try:
            self.session.get("https://www.nseindia.com", timeout=10)
            time.sleep(1)
        except Exception as e:
            print(f"[FiiDii] Session prime warning: {e}", file=sys.stderr)

    def fetch(self) -> list[dict]:
        """Fetch FII/DII data from NSE. Returns list of daily records.

        NSE API (as of mid-2026) returns one row per category (FII/FPI, DII) per date
        with fields: buyValue, sellValue, netValue, category, date.
        We pivot these into one record per date with fii_* and dii_* columns.
        """
        try:
            resp = retry_get(self.session, NSE_FII_DII_URL, timeout=15)
            data = resp.json()
        except Exception as e:
            print(f"[FiiDii] Fetch error after retries: {e}", file=sys.stderr)
            return []

        # Group by date, then pivot FII/FPI and DII rows into one record per date
        by_date: dict[str, dict] = {}
        for row in data:
            try:
                date_str = self._parse_date(row.get("date", ""))
                if not date_str:
                    continue
                cat = (row.get("category") or "").upper()
                if date_str not in by_date:
                    by_date[date_str] = {}
                if "FII" in cat:
                    by_date[date_str]["fii_buy"]  = self._parse_float(row.get("buyValue"))
                    by_date[date_str]["fii_sell"] = self._parse_float(row.get("sellValue"))
                    by_date[date_str]["fii_net"]  = self._parse_float(row.get("netValue"))
                elif "DII" in cat:
                    by_date[date_str]["dii_buy"]  = self._parse_float(row.get("buyValue"))
                    by_date[date_str]["dii_sell"] = self._parse_float(row.get("sellValue"))
                    by_date[date_str]["dii_net"]  = self._parse_float(row.get("netValue"))
            except Exception as e:
                print(f"[FiiDii] Row parse error: {e} — row={row}", file=sys.stderr)

        records = []
        for date_str, vals in by_date.items():
            fii_buy  = vals.get("fii_buy")
            fii_sell = vals.get("fii_sell")
            fii_net  = vals.get("fii_net")
            dii_buy  = vals.get("dii_buy")
            dii_sell = vals.get("dii_sell")
            dii_net  = vals.get("dii_net")

            # Compute net if not provided
            if fii_net is None and fii_buy is not None and fii_sell is not None:
                fii_net = fii_buy - fii_sell
            if dii_net is None and dii_buy is not None and dii_sell is not None:
                dii_net = dii_buy - dii_sell

            if all(v is None for v in (fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net)):
                print(f"[FiiDii] Skipping {date_str} — all values null (non-trading day)")
                continue

            records.append({
                "date":     date_str,
                "fii_buy":  fii_buy,
                "fii_sell": fii_sell,
                "fii_net":  fii_net,
                "dii_buy":  dii_buy,
                "dii_sell": dii_sell,
                "dii_net":  dii_net,
                "source":   "NSE",
            })

        return records

    @staticmethod
    def _parse_date(raw: str) -> str | None:
        """Convert NSE date formats (DD-MMM-YYYY, YYYY-MM-DD) to YYYY-MM-DD."""
        raw = raw.strip()
        for fmt in ("%d-%b-%Y", "%Y-%m-%d", "%d/%m/%Y", "%d-%m-%Y"):
            try:
                return datetime.datetime.strptime(raw, fmt).strftime("%Y-%m-%d")
            except ValueError:
                continue
        return None

    @staticmethod
    def _parse_float(val) -> float | None:
        if val is None:
            return None
        try:
            return float(str(val).replace(",", ""))
        except (ValueError, TypeError):
            return None

    def save(self, records: list[dict]) -> int:
        """Upsert records into fii_dii_flow. Returns count of saved rows."""
        if not records:
            return 0

        now = datetime.datetime.now().isoformat()
        saved = 0
        with self.engine.begin() as conn:
            for r in records:
                conn.execute(text("""
                    INSERT INTO fii_dii_flow
                        (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source, fetched_at)
                    VALUES
                        (:date, :fii_buy, :fii_sell, :fii_net, :dii_buy, :dii_sell, :dii_net, :source, :fetched_at)
                    ON CONFLICT(date) DO UPDATE SET
                        fii_buy    = excluded.fii_buy,
                        fii_sell   = excluded.fii_sell,
                        fii_net    = excluded.fii_net,
                        dii_buy    = excluded.dii_buy,
                        dii_sell   = excluded.dii_sell,
                        dii_net    = excluded.dii_net,
                        source     = excluded.source,
                        fetched_at = excluded.fetched_at
                """), {**r, "fetched_at": now})
                saved += 1

        return saved

    def get_recent(self, days: int = 5) -> pd.DataFrame:
        """Return the most recent N days from fii_dii_flow."""
        with self.engine.connect() as conn:
            return pd.read_sql(
                f"SELECT * FROM fii_dii_flow ORDER BY date DESC LIMIT {days}",
                conn,
            )

    def fetch_provisional(self) -> None:
        """Fetch same-day (T+0) provisional FII/DII data from NSE and write to
        macro_asset_prices (symbol-keyed) and upsert today's row into fii_dii_flow.

        NSE publishes provisional figures around 6 PM IST at the same endpoint
        used for historical data.  The most-recent row in the response is today's
        provisional figure; we identify it by comparing its date to today's date.
        """
        today = datetime.date.today().strftime("%Y-%m-%d")

        try:
            resp = self.session.get(NSE_FII_DII_URL, timeout=15)
            if resp.status_code in (403, 401, 429):
                print("[FIIFetcher] Provisional data unavailable (NSE auth), skipping.")
                return
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[FIIFetcher] Provisional fetch error: {e}", file=sys.stderr)
            return

        # Find the row(s) whose date matches today
        fii_row: dict = {}
        dii_row: dict = {}
        for row in data:
            date_str = self._parse_date(row.get("date", ""))
            if date_str != today:
                continue
            cat = (row.get("category") or "").upper()
            if "FII" in cat:
                fii_row = row
            elif "DII" in cat:
                dii_row = row

        if not fii_row and not dii_row:
            print(f"[FIIFetcher] No provisional data for {today} yet (market may still be open or data not published).")
            return

        fii_buy  = self._parse_float(fii_row.get("buyValue"))
        fii_sell = self._parse_float(fii_row.get("sellValue"))
        fii_net  = self._parse_float(fii_row.get("netValue"))
        dii_buy  = self._parse_float(dii_row.get("buyValue"))
        dii_sell = self._parse_float(dii_row.get("sellValue"))
        dii_net  = self._parse_float(dii_row.get("netValue"))

        if fii_net is None and fii_buy is not None and fii_sell is not None:
            fii_net = fii_buy - fii_sell
        if dii_net is None and dii_buy is not None and dii_sell is not None:
            dii_net = dii_buy - dii_sell

        now = datetime.datetime.now().isoformat()

        # ── Write to macro_asset_prices (symbol, date, close) ─────────────────
        macro_rows = [
            r for r in [
                ("FII_NET_TODAY",  today, fii_net),
                ("DII_NET_TODAY",  today, dii_net),
                ("FII_BUY_TODAY",  today, fii_buy),
                ("FII_SELL_TODAY", today, fii_sell),
            ] if r[2] is not None
        ]

        with self.engine.begin() as conn:
            for symbol, date, close in macro_rows:
                conn.execute(text("""
                    INSERT INTO macro_asset_prices (date, symbol, close, fetched_at)
                    VALUES (:date, :symbol, :close, :fetched_at)
                    ON CONFLICT(date, symbol) DO UPDATE SET
                        close=excluded.close,
                        fetched_at=excluded.fetched_at
                """), {"date": date, "symbol": symbol, "close": close, "fetched_at": now})

            # ── Also upsert today's row into fii_dii_flow ─────────────────────
            conn.execute(text("""
                INSERT INTO fii_dii_flow
                    (date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net, source, fetched_at)
                VALUES
                    (:date, :fii_buy, :fii_sell, :fii_net, :dii_buy, :dii_sell, :dii_net, :source, :fetched_at)
                ON CONFLICT(date) DO UPDATE SET
                    fii_buy    = excluded.fii_buy,
                    fii_sell   = excluded.fii_sell,
                    fii_net    = excluded.fii_net,
                    dii_buy    = excluded.dii_buy,
                    dii_sell   = excluded.dii_sell,
                    dii_net    = excluded.dii_net,
                    source     = excluded.source,
                    fetched_at = excluded.fetched_at
            """), {
                "date": today, "fii_buy": fii_buy, "fii_sell": fii_sell, "fii_net": fii_net,
                "dii_buy": dii_buy, "dii_sell": dii_sell, "dii_net": dii_net,
                "source": "NSE_PROVISIONAL", "fetched_at": now,
            })

        print(
            f"[FIIFetcher] Provisional {today}: "
            f"FII net={fii_net} Cr  DII net={dii_net} Cr  "
            f"({len(macro_rows)} rows -> macro_asset_prices, 1 row -> fii_dii_flow)"
        )

    def run(self, days: int = 0):
        print(f"[FiiDii] Fetching from NSE at {datetime.datetime.now()}")
        records = self.fetch()
        if not records:
            print("[FiiDii] No records returned.")
            return

        if days > 0:
            records = records[:days]

        saved = self.save(records)
        print(f"[FiiDii] Saved {saved} rows to fii_dii_flow.")

        recent = self.get_recent(5)
        if not recent.empty:
            print("\nLast 5 days FII/DII flow (Cr):")
            print(recent[["date", "fii_net", "dii_net"]].to_string(index=False))

        # Fetch same-day provisional figures (available ~6 PM IST)
        self.fetch_provisional()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FII/DII Daily Flow Fetcher")
    parser.add_argument("--days", type=int, default=0,
                        help="Limit to last N days (0 = all returned by NSE)")
    args = parser.parse_args()

    fetcher = FiiDiiFetcher()
    fetcher.run(days=args.days)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
