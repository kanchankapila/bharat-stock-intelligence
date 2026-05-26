"""
PCR (Put-Call Ratio) Fetcher
==============================
Fetches options OI data from NSE for Nifty 50 stocks and computes
per-symbol PCR from the option chain API.

Stores results in stock_options_oi table for use by PCR_EXTREME signal detection.

Run:  python pcr_fetcher.py
      python pcr_fetcher.py --symbols RELIANCE,TCS,INFY
      python pcr_fetcher.py --index NIFTY
"""

import os
import time
import datetime
import argparse
import requests
import pandas as pd
from sqlalchemy import create_engine, text

DB_PATH      = os.path.join(os.getcwd(), 'database.sqlite')
DATABASE_URL = f"sqlite:///{DB_PATH}"

NSE_OPTION_CHAIN_URL = "https://www.nseindia.com/api/option-chain-equities?symbol={symbol}"
NSE_INDEX_CHAIN_URL  = "https://www.nseindia.com/api/option-chain-indices?symbol={symbol}"

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.nseindia.com/option-chain",
    "DNT":             "1",
}

# Default Nifty 50 symbols to fetch PCR for (subset — extend as needed)
DEFAULT_SYMBOLS = [
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
    "HINDUNILVR", "ITC", "SBIN", "BAJFINANCE", "BHARTIARTL",
    "KOTAKBANK", "LT", "AXISBANK", "ASIANPAINT", "MARUTI",
    "TITAN", "SUNPHARMA", "WIPRO", "ULTRACEMCO", "TECHM",
]


class PCRFetcher:
    def __init__(self):
        self.engine  = create_engine(DATABASE_URL)
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._prime_session()

    def _prime_session(self):
        # NiftyTrader does not require session priming
        pass

    def fetch_symbol(self, symbol: str, is_index: bool = False) -> dict | None:
        """Fetch option chain for a symbol and compute PCR. Returns dict or None."""
        url = f"https://webapi.niftytrader.in/webapi/option/option-chain-data?symbol={symbol}&exchange=nse&expiryDate=&atmBelow=0&atmAbove=0"
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[PCR] {symbol}: fetch error — {e}")
            return None

        try:
            result_data = data.get("resultData")
            if not result_data or not isinstance(result_data, dict):
                print(f"[PCR] {symbol}: no resultData returned")
                return None

            op_totals = result_data.get("opTotals", {})
            total_calls_puts = op_totals.get("total_calls_puts", {})
            if not total_calls_puts:
                print(f"[PCR] {symbol}: total_calls_puts not found in opTotals")
                return None

            total_call_oi = total_calls_puts.get("total_calls_oi", 0) or 0
            total_put_oi  = total_calls_puts.get("total_puts_oi", 0) or 0

            op_datas = result_data.get("opDatas", [])
            nearest_expiry = "N/A"
            if op_datas and isinstance(op_datas, list):
                first_item = op_datas[0]
                if isinstance(first_item, dict) and "expiry_date" in first_item:
                    # Format "2026-05-26T00:00:00" -> "2026-05-26"
                    nearest_expiry = first_item["expiry_date"].split("T")[0]

            if nearest_expiry == "N/A" or not nearest_expiry:
                nearest_expiry = datetime.date.today().isoformat()

            # PCR = put OI / call OI
            near_pcr  = total_put_oi / total_call_oi if total_call_oi > 0 else None
            total_pcr = near_pcr

            return {
                "symbol":        symbol,
                "expiry":        nearest_expiry,
                "call_oi":       int(total_call_oi),
                "put_oi":        int(total_put_oi),
                "pcr":           near_pcr,
                "total_call_oi": int(total_call_oi),
                "total_put_oi":  int(total_put_oi),
                "market_pcr":    total_pcr,
            }
        except Exception as e:
            print(f"[PCR] {symbol}: parse error — {e}")
            return None

    def save(self, records: list[dict]) -> int:
        if not records:
            return 0

        today = datetime.date.today().isoformat()
        now   = datetime.datetime.now().isoformat()
        saved = 0

        with self.engine.begin() as conn:
            for r in records:
                conn.execute(text("""
                    INSERT INTO stock_options_oi
                        (symbol, date, expiry, call_oi, put_oi, pcr,
                         total_call_oi, total_put_oi, market_pcr, fetched_at)
                    VALUES
                        (:symbol, :date, :expiry, :call_oi, :put_oi, :pcr,
                         :total_call_oi, :total_put_oi, :market_pcr, :fetched_at)
                    ON CONFLICT(symbol, date, expiry) DO UPDATE SET
                        call_oi       = excluded.call_oi,
                        put_oi        = excluded.put_oi,
                        pcr           = excluded.pcr,
                        total_call_oi = excluded.total_call_oi,
                        total_put_oi  = excluded.total_put_oi,
                        market_pcr    = excluded.market_pcr,
                        fetched_at    = excluded.fetched_at
                """), {**r, "date": today, "fetched_at": now})
                saved += 1

        return saved

    def run(self, symbols: list[str], delay: float = 0.2):
        print(f"[PCR] Fetching {len(symbols)} symbols at {datetime.datetime.now()}")
        results = []

        for i, sym in enumerate(symbols):
            print(f"[PCR] ({i+1}/{len(symbols)}) {sym}...")
            rec = self.fetch_symbol(sym)
            if rec:
                results.append(rec)
                pcr_str = f"{rec['pcr']:.3f}" if rec['pcr'] is not None else "N/A"
                print(f"[PCR]   PCR={pcr_str}  call_oi={rec['call_oi']:,}  put_oi={rec['put_oi']:,}")
            time.sleep(delay)

        saved = self.save(results)
        print(f"\n[PCR] Done. Saved {saved}/{len(symbols)} symbols to stock_options_oi.")

        if results:
            df = pd.DataFrame(results)[["symbol", "pcr", "total_call_oi", "total_put_oi"]]
            df["pcr"] = df["pcr"].map(lambda x: f"{x:.3f}" if x is not None else "N/A")
            print("\nTop PCR extremes:")
            print(df.sort_values("pcr", ascending=False).head(10).to_string(index=False))


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="NSE PCR Fetcher")
    parser.add_argument("--symbols", type=str, default="",
                        help="Comma-separated symbol list (default: Nifty 50 subset)")
    parser.add_argument("--index", type=str, default="",
                        help="Fetch index option chain (e.g. NIFTY, BANKNIFTY)")
    parser.add_argument("--delay", type=float, default=0.2,
                        help="Seconds between requests (default: 0.2)")
    args = parser.parse_args()

    fetcher = PCRFetcher()

    if args.index:
        rec = fetcher.fetch_symbol(args.index, is_index=True)
        if rec:
            fetcher.save([rec])
            print(f"Saved index PCR: {rec}")
    else:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] \
                  if args.symbols else DEFAULT_SYMBOLS
        fetcher.run(symbols, delay=args.delay)
