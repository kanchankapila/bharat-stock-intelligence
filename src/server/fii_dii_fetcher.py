"""
FII/DII Daily Flow Fetcher
===========================
Fetches FII and DII trade data from NSE API and stores it in the fii_dii_flow table.
Designed to run daily (cron or manual) after market close.

Run:  python fii_dii_fetcher.py
      python fii_dii_fetcher.py --days 30
"""

import os
import datetime
import argparse
import time
import requests
import pandas as pd
from sqlalchemy import create_engine, text

DB_PATH      = os.path.join(os.getcwd(), 'database.sqlite')
DATABASE_URL = f"sqlite:///{DB_PATH}"

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
        self.engine  = create_engine(DATABASE_URL)
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._prime_session()

    def _prime_session(self):
        """Prime NSE session cookie — required before API calls."""
        try:
            self.session.get("https://www.nseindia.com", timeout=10)
            time.sleep(1)
        except Exception as e:
            print(f"[FiiDii] Session prime warning: {e}")

    def fetch(self) -> list[dict]:
        """Fetch FII/DII data from NSE. Returns list of daily records."""
        try:
            resp = self.session.get(NSE_FII_DII_URL, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[FiiDii] Fetch error: {e}")
            return []

        records = []
        for row in data:
            try:
                date_str = self._parse_date(row.get("date", ""))
                if not date_str:
                    continue

                fii_buy  = self._parse_float(row.get("fiiBuy"))
                fii_sell = self._parse_float(row.get("fiiSell"))
                fii_net  = self._parse_float(row.get("fiiNet"))
                dii_buy  = self._parse_float(row.get("diiBuy"))
                dii_sell = self._parse_float(row.get("diiSell"))
                dii_net  = self._parse_float(row.get("diiNet"))

                # Fallback: compute net if not provided
                if fii_net is None and fii_buy is not None and fii_sell is not None:
                    fii_net = fii_buy - fii_sell
                if dii_net is None and dii_buy is not None and dii_sell is not None:
                    dii_net = dii_buy - dii_sell

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
            except Exception as e:
                print(f"[FiiDii] Row parse error: {e} — row={row}")

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


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="FII/DII Daily Flow Fetcher")
    parser.add_argument("--days", type=int, default=0,
                        help="Limit to last N days (0 = all returned by NSE)")
    args = parser.parse_args()

    fetcher = FiiDiiFetcher()
    fetcher.run(days=args.days)
