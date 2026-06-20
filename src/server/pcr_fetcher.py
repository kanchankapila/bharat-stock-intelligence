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
from sqlalchemy import text

from db_compat import get_engine

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


def compute_atm_iv_skew(strikes: list, underlying: float) -> tuple:
    """ATM implied vol and put-call IV skew from a nearest-expiry chain.

    `strikes`: list of (strike_price, call_iv, pe_iv). `underlying`: spot.
    atm_iv  = mean(call_iv, put_iv) at the strike nearest spot (ignoring zero IVs).
    iv_skew = OTM-put IV − OTM-call IV, using the strikes nearest ±5% from spot — a model-
              free proxy for 25-delta skew (positive = downside crash bid). Returns
              (None, None) when the chain has no usable IVs."""
    usable = [(s, c, p) for (s, c, p) in strikes if s and (c or p)]
    if not usable or not underlying:
        return None, None

    atm = min(usable, key=lambda r: abs(r[0] - underlying))
    atm_ivs = [v for v in (atm[1], atm[2]) if v]
    atm_iv = sum(atm_ivs) / len(atm_ivs) if atm_ivs else None

    put_strike  = min(usable, key=lambda r: abs(r[0] - underlying * 0.95))
    call_strike = min(usable, key=lambda r: abs(r[0] - underlying * 1.05))
    iv_skew = None
    if put_strike[2] and call_strike[1]:
        iv_skew = put_strike[2] - call_strike[1]

    return atm_iv, iv_skew


class PCRFetcher:
    def __init__(self):
        self.engine  = get_engine()
        self.session = requests.Session()
        self.session.headers.update(HEADERS)
        self._prime_session()

    def _prime_session(self):
        try:
            self.session.get("https://www.nseindia.com", timeout=10)
            time.sleep(1.5)
        except Exception as e:
            print(f"[PCR] Session prime warning: {e}")

    def fetch_symbol(self, symbol: str, is_index: bool = False) -> dict | None:
        """Fetch option chain for a symbol and compute PCR. Returns dict or None."""
        url = (NSE_INDEX_CHAIN_URL if is_index else NSE_OPTION_CHAIN_URL).format(
            symbol=symbol
        )
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[PCR] {symbol}: fetch error — {e}")
            return None

        try:
            records = data.get("records", {})
            expiry_dates = records.get("expiryDates", [])
            if not expiry_dates:
                return None

            nearest_expiry = expiry_dates[0]
            chain_data     = records.get("data", [])
            underlying     = records.get("underlyingValue") or 0

            total_call_oi = 0
            total_put_oi  = 0
            near_call_oi  = 0
            near_put_oi   = 0
            near_strikes  = []   # (strike, ce_iv, pe_iv) for nearest expiry — IV features

            for strike in chain_data:
                ce = strike.get("CE", {})
                pe = strike.get("PE", {})
                c_oi = ce.get("openInterest", 0) or 0
                p_oi = pe.get("openInterest", 0) or 0
                total_call_oi += c_oi
                total_put_oi  += p_oi

                if ce.get("expiryDate") == nearest_expiry:
                    near_call_oi += c_oi
                if pe.get("expiryDate") == nearest_expiry:
                    near_put_oi  += p_oi

                if ce.get("expiryDate") == nearest_expiry or pe.get("expiryDate") == nearest_expiry:
                    sp = strike.get("strikePrice")
                    if sp is not None:
                        near_strikes.append((
                            sp, ce.get("impliedVolatility") or 0, pe.get("impliedVolatility") or 0
                        ))

            # PCR = put OI / call OI (nearest expiry)
            near_pcr  = near_put_oi  / near_call_oi  if near_call_oi  > 0 else None
            total_pcr = total_put_oi / total_call_oi if total_call_oi > 0 else None

            atm_iv, iv_skew = compute_atm_iv_skew(near_strikes, underlying)

            return {
                "symbol":        symbol,
                "expiry":        nearest_expiry,
                "call_oi":       near_call_oi,
                "put_oi":        near_put_oi,
                "pcr":           near_pcr,
                "total_call_oi": total_call_oi,
                "total_put_oi":  total_put_oi,
                "market_pcr":    total_pcr,
                "atm_iv":        atm_iv,
                "iv_skew":       iv_skew,
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

    def run(self, symbols: list[str], delay: float = 1.5):
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
    parser.add_argument("--delay", type=float, default=1.5,
                        help="Seconds between requests (default: 1.5)")
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
