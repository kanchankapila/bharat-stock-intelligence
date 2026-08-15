import time
import datetime
import requests
import pandas as pd
from sqlalchemy import text
from db_compat import get_engine
from pydantic import BaseModel
from typing import List, Optional

# NOTE: this module deliberately has no DB path of its own. It uses db_compat.get_engine(),
# which resolves the dialect from USE_POSTGRES -- production is Postgres. Two dead lines
# were removed here 2026-08-15: a DB_PATH/DATABASE_URL pair that force-wrapped the value in
# "sqlite:///" and was then never referenced again. They were harmless but actively
# misleading -- they are why a past session recorded AlphaQuant as a live SQLite writer
# (infra_gotchas memory) when it has never been one. See docs/SQLITE_DECOMMISSION_PLAN.md.

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

DEFAULT_SYMBOLS = [
    "RELIANCE", "TCS", "HDFCBANK", "INFY", "ICICIBANK",
    "HINDUNILVR", "ITC", "SBIN", "BAJFINANCE", "BHARTIARTL",
    "KOTAKBANK", "LT", "AXISBANK", "ASIANPAINT", "MARUTI",
    "TITAN", "SUNPHARMA", "WIPRO", "ULTRACEMCO", "TECHM",
]

class PCRFetcher:
    def __init__(self):
        self.engine  = get_engine()
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._prime_session()

    def _prime_session(self):
        # NiftyTrader does not require session priming
        pass

    def fetch_symbol(self, symbol: str, is_index: bool = False) -> dict | None:
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
        results = []
        for sym in symbols:
            rec = self.fetch_symbol(sym)
            if rec:
                results.append(rec)
            time.sleep(delay)
        saved = self.save(results)
        return {"saved": saved, "total": len(symbols), "results": results}

class PcrRequest(BaseModel):
    symbols: Optional[List[str]] = None
    delay: Optional[float] = 0.2

def run_pcr_fetch(req: PcrRequest):
    fetcher = PCRFetcher()
    symbols = req.symbols if req.symbols else DEFAULT_SYMBOLS
    res = fetcher.run(symbols, delay=req.delay)
    return res

def get_latest_pcr():
    engine = get_engine()
    with engine.connect() as conn:
        query = text("""
            SELECT symbol, date, expiry, pcr, market_pcr, total_call_oi, total_put_oi
            FROM stock_options_oi
            WHERE date = (SELECT MAX(date) FROM stock_options_oi)
            ORDER BY pcr DESC
        """)
        try:
            df = pd.read_sql(query, conn)
            return df.to_dict(orient="records")
        except Exception as e:
            print(f"Error reading PCR data: {e}")
            return []
