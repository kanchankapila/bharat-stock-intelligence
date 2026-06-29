"""
PCR (Put-Call Ratio) Fetcher
==============================
Fetches nearest-expiry options OI from NiftyTrader for Nifty 50 stocks and computes
per-symbol PCR. NiftyTrader is the source because NSE's own option-chain API is behind
Akamai Bot Manager (returns {} to non-browser clients). NiftyTrader does NOT populate
equity IV, so atm_iv/iv_skew stay None — a documented vendor limit (see ml-data-gaps).
The legacy NSE `fetch_symbol` method is retained but unused.

Stores results in stock_options_oi for use by PCR_EXTREME signal detection.

Run:  python pcr_fetcher.py
      python pcr_fetcher.py --symbols RELIANCE,TCS,INFY
      python pcr_fetcher.py --index NIFTY
"""

import os
import math
import time
import datetime
import argparse
import requests
import pandas as pd
from sqlalchemy import text

from db_compat import get_engine

# MoneyControl Nifty index OI endpoints
MC_EXPIRY_DATES_URL = (
    "https://priceapi.moneycontrol.com/technicalCompanyData/oiData/"
    "options-expiry-dates?scId=in;NSX&assetType=I&deviceType=W"
)
MC_OI_CHANGE_URL = (
    "https://priceapi.moneycontrol.com/technicalCompanyData/oiData/"
    "oi-change-chart?scId=in;NSX&expiryDate={expiry}&assetType=I&type=HIST&count=31&deviceType=W"
)
MC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.moneycontrol.com/",
    "Origin":          "https://www.moneycontrol.com",
    "DNT":             "1",
}

NIFTY_LOT_SIZE = 50          # Nifty 50 lot size (contracts × 50 shares)
NIFTY_GEX_SIGMA = 0.15       # IV proxy used in Gaussian gamma kernel

NSE_OPTION_CHAIN_URL = "https://www.nseindia.com/api/option-chain-equities?symbol={symbol}"
NSE_INDEX_CHAIN_URL  = "https://www.nseindia.com/api/option-chain-equities?symbol={symbol}"

# NiftyTrader webapi — the working source for equity OI/PCR. NSE's own option-chain
# API is behind Akamai Bot Manager (returns {} to non-browser clients), so PCR/OI is
# sourced here instead. NiftyTrader does NOT populate equity IV (calls_iv/puts_iv=0),
# so atm_iv/iv_skew stay None for stocks — a documented vendor limit, not a bug.
NIFTYTRADER_CHAIN_URL = (
    "https://webapi.niftytrader.in/webapi/option/option-chain-data"
    "?symbol={symbol}&exchange=nse&expiryDate=&atmBelow=0&atmAbove=0"
)
NIFTYTRADER_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":  "application/json, text/plain, */*",
    "Referer": "https://www.niftytrader.in/",
    "Origin":  "https://www.niftytrader.in",
}

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


def parse_niftytrader_chain(result_data: dict, symbol: str) -> dict | None:
    """Turn a NiftyTrader option-chain `resultData` payload into a stock_options_oi row.

    NiftyTrader's default (empty expiryDate) call returns only the NEAREST expiry, so
    near-expiry OI equals total OI. Equity IV is 0.0 → compute_atm_iv_skew yields
    (None, None) (zero IVs are filtered). Returns None when the chain is empty."""
    oc = result_data.get("opDatas") or result_data.get("optionChain") or []
    if not oc:
        return None

    first = oc[0]
    underlying = (
        result_data.get("spotPrice")
        or first.get("index_close")
        or first.get("last_price")
        or 0
    )

    total_call_oi = sum((r.get("calls_oi") or 0) for r in oc)
    total_put_oi  = sum((r.get("puts_oi")  or 0) for r in oc)
    call_vol      = sum((r.get("calls_volume") or 0) for r in oc)
    put_vol       = sum((r.get("puts_volume")  or 0) for r in oc)

    pcr     = total_put_oi / total_call_oi if total_call_oi > 0 else None
    pcr_vol = put_vol / call_vol if call_vol > 0 else None

    strikes = [
        (r.get("strike_price"), r.get("calls_iv") or 0, r.get("puts_iv") or 0)
        for r in oc if r.get("strike_price") is not None
    ]
    atm_iv, iv_skew = compute_atm_iv_skew(strikes, underlying)

    # Max pain: strike minimizing total writer payout across the chain.
    max_pain = underlying
    min_pain = float("inf")
    for sp, _, _ in strikes:
        pain = 0.0
        for r in oc:
            s = r.get("strike_price")
            if s is None:
                continue
            if sp > s:
                pain += (r.get("calls_oi") or 0) * (sp - s)
            elif sp < s:
                pain += (r.get("puts_oi") or 0) * (s - sp)
        if pain < min_pain:
            min_pain = pain
            max_pain = sp

    expiry = str(first.get("expiry_date") or "")[:10]

    return {
        "symbol":        symbol,
        "expiry":        expiry,
        "call_oi":       total_call_oi,
        "put_oi":        total_put_oi,
        "pcr":           pcr,
        "pcr_vol":       pcr_vol,
        "total_call_oi": total_call_oi,
        "total_put_oi":  total_put_oi,
        "market_pcr":    pcr,
        "atm_iv":        atm_iv,
        "iv_skew":       iv_skew,
        "max_pain":      max_pain,
    }


class PCRFetcher:
    def __init__(self):
        self.engine  = get_engine()
        self.session = requests.Session()
        self.session.headers.update(NIFTYTRADER_HEADERS)

    def fetch_symbol_niftytrader(self, symbol: str) -> dict | None:
        """Fetch the nearest-expiry option chain from NiftyTrader and compute PCR/OI.

        Primary source — NSE's own option-chain API is Akamai-walled. NiftyTrader does
        NOT populate equity IV, so atm_iv/iv_skew come back None (vendor limit)."""
        url = NIFTYTRADER_CHAIN_URL.format(symbol=symbol.upper())
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[PCR] {symbol}: fetch error — {e}")
            return None
        if data.get("result") != 1 or not data.get("resultData"):
            return None
        return parse_niftytrader_chain(data["resultData"], symbol.upper())

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
            near_call_vol = 0
            near_put_vol  = 0
            near_strikes  = []   # (strike, ce_iv, pe_iv) for nearest expiry — IV features

            for strike in chain_data:
                ce = strike.get("CE", {})
                pe = strike.get("PE", {})
                c_oi = ce.get("openInterest", 0) or 0
                p_oi = pe.get("openInterest", 0) or 0
                c_vol = ce.get("totalTradedVolume", 0) or 0
                p_vol = pe.get("totalTradedVolume", 0) or 0
                total_call_oi += c_oi
                total_put_oi  += p_oi

                if ce.get("expiryDate") == nearest_expiry:
                    near_call_oi += c_oi
                    near_call_vol += c_vol
                if pe.get("expiryDate") == nearest_expiry:
                    near_put_oi  += p_oi
                    near_put_vol += p_vol

                if ce.get("expiryDate") == nearest_expiry or pe.get("expiryDate") == nearest_expiry:
                    sp = strike.get("strikePrice")
                    if sp is not None:
                        near_strikes.append((
                            sp, ce.get("impliedVolatility") or 0, pe.get("impliedVolatility") or 0
                        ))

            # PCR = put OI / call OI (nearest expiry)
            near_pcr  = near_put_oi  / near_call_oi  if near_call_oi  > 0 else None
            total_pcr = total_put_oi / total_call_oi if total_call_oi > 0 else None
            near_pcr_vol = near_put_vol / near_call_vol if near_call_vol > 0 else None

            atm_iv, iv_skew = compute_atm_iv_skew(near_strikes, underlying)

            # Max Pain
            max_pain = underlying
            if near_strikes:
                min_pain_val = float('inf')
                for strike_info in near_strikes:
                    sp = strike_info[0]
                    total_pain = 0
                    for row in chain_data:
                        if row.get("expiryDate") != nearest_expiry and row.get("CE", {}).get("expiryDate") != nearest_expiry and row.get("PE", {}).get("expiryDate") != nearest_expiry: 
                            continue
                        s = row.get("strikePrice")
                        if s is None: continue
                        ce_oi = row.get("CE", {}).get("openInterest", 0) or 0
                        pe_oi = row.get("PE", {}).get("openInterest", 0) or 0
                        if sp > s: total_pain += ce_oi * (sp - s)
                        if sp < s: total_pain += pe_oi * (s - sp)
                    if total_pain < min_pain_val:
                        min_pain_val = total_pain
                        max_pain = sp

            return {
                "symbol":        symbol,
                "expiry":        nearest_expiry,
                "call_oi":       near_call_oi,
                "put_oi":        near_put_oi,
                "pcr":           near_pcr,
                "pcr_vol":       near_pcr_vol,
                "total_call_oi": total_call_oi,
                "total_put_oi":  total_put_oi,
                "market_pcr":    total_pcr,
                "atm_iv":        atm_iv,
                "iv_skew":       iv_skew,
                "max_pain":      max_pain,
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
                         total_call_oi, total_put_oi, market_pcr, atm_iv, iv_skew, fetched_at)
                    VALUES
                        (:symbol, :date, :expiry, :call_oi, :put_oi, :pcr,
                         :total_call_oi, :total_put_oi, :market_pcr, :atm_iv, :iv_skew, :fetched_at)
                    ON CONFLICT(symbol, date, expiry) DO UPDATE SET
                        call_oi       = excluded.call_oi,
                        put_oi        = excluded.put_oi,
                        pcr           = excluded.pcr,
                        total_call_oi = excluded.total_call_oi,
                        total_put_oi  = excluded.total_put_oi,
                        market_pcr    = excluded.market_pcr,
                        atm_iv        = excluded.atm_iv,
                        iv_skew       = excluded.iv_skew,
                        fetched_at    = excluded.fetched_at
                """), {"atm_iv": None, "iv_skew": None, **r, "date": today, "fetched_at": now})

                conn.execute(text("""
                    INSERT INTO historical_fno_sentiment
                        (symbol, date, pcr_oi, pcr_vol, max_pain, atm_iv, iv_skew,
                         total_ce_oi, total_pe_oi, updated_at)
                    VALUES
                        (:symbol, :date, :pcr_oi, :pcr_vol, :max_pain, :atm_iv, :iv_skew,
                         :total_ce_oi, :total_pe_oi, :fetched_at)
                    ON CONFLICT(symbol, date) DO UPDATE SET
                        pcr_oi      = excluded.pcr_oi,
                        pcr_vol     = excluded.pcr_vol,
                        max_pain    = excluded.max_pain,
                        atm_iv      = excluded.atm_iv,
                        iv_skew     = excluded.iv_skew,
                        total_ce_oi = excluded.total_ce_oi,
                        total_pe_oi = excluded.total_pe_oi,
                        updated_at  = excluded.updated_at
                """), {
                    "symbol": r["symbol"],
                    "date": today,
                    "pcr_oi": r["pcr"],
                    "pcr_vol": r.get("pcr_vol"),
                    "max_pain": r.get("max_pain"),
                    "atm_iv": r.get("atm_iv"),
                    "iv_skew": r.get("iv_skew"),
                    "total_ce_oi": r["total_call_oi"],
                    "total_pe_oi": r["total_put_oi"],
                    "fetched_at": now
                })
                saved += 1

        return saved

    # ------------------------------------------------------------------
    # Nifty GEX (Gamma Exposure) — MoneyControl strike-level OI
    # ------------------------------------------------------------------

    def _mc_get(self, url: str) -> dict | None:
        """GET from MoneyControl using MC_HEADERS; returns parsed JSON or None."""
        try:
            resp = self.session.get(url, headers=MC_HEADERS, timeout=15)
            resp.raise_for_status()
            return resp.json()
        except Exception as e:
            print(f"[GEX] HTTP error fetching {url}: {e}")
            return None

    def _fetch_nearest_expiry(self) -> str | None:
        """Return the nearest Nifty expiry date string (YYYY-MM-DD) from MC."""
        data = self._mc_get(MC_EXPIRY_DATES_URL)
        if not data or not data.get("success"):
            print("[GEX] Could not fetch expiry dates from MoneyControl")
            return None
        dates = data.get("data") or []
        if not dates:
            print("[GEX] Empty expiry date list from MoneyControl")
            return None
        # dates are expected as strings; pick the first (nearest)
        nearest = str(dates[0]).strip()
        print(f"[GEX] Nearest Nifty expiry: {nearest}")
        return nearest

    def fetch_nifty_gex(self) -> dict | None:
        """Fetch strike-level Nifty OI from MoneyControl and compute dealer GEX.

        GEX formula (Gaussian-kernel weighted, dealer short-call / long-put):
            for each strike k:
                moneyness  = (k − spot) / spot
                gamma_wt   = exp(−0.5 × (moneyness / σ)²)
                dealer_gex += (−call_oi + put_oi) × gamma_wt × lot_size × spot / 1e9

        Positive GEX → dealers long gamma (mean-reversion / dampening regime).
        Negative GEX → dealers short gamma (trend / amplifying regime).

        Also captures total-level PCR, callOiChange, putOiChange for macro context.
        Returns a dict with keys: dealer_gex, pcr_oi, call_oi_change, put_oi_change,
        total_call_oi, total_put_oi, spot, expiry. Returns None on any fetch/parse error.
        """
        expiry = self._fetch_nearest_expiry()
        if not expiry:
            return None

        url  = MC_OI_CHANGE_URL.format(expiry=expiry)
        data = self._mc_get(url)
        if not data or not data.get("success"):
            print("[GEX] Failed to fetch OI change data from MoneyControl")
            return None

        results: dict = (data.get("data") or {}).get("results") or {}
        if not results:
            print("[GEX] Empty results in OI change response")
            return None

        # Use the most recent date's data (first key when sorted descending)
        latest_date = sorted(results.keys(), reverse=True)[0]
        day_data    = results[latest_date]
        print(f"[GEX] Using OI snapshot for date: {latest_date}")

        total    = day_data.get("total") or {}
        spot     = float(day_data.get("atm") or 0)
        strikes  = day_data.get("list") or []

        total_call_oi    = float(total.get("callOi")      or 0)
        total_put_oi     = float(total.get("putOi")       or 0)
        call_oi_change   = float(total.get("callOiChange") or 0)
        put_oi_change    = float(total.get("putOiChange")  or 0)

        pcr_oi = total_put_oi / total_call_oi if total_call_oi > 0 else None

        if not spot or not strikes:
            print("[GEX] Missing ATM price or strike list — cannot compute GEX")
            return None

        sigma   = NIFTY_GEX_SIGMA
        lot     = NIFTY_LOT_SIZE
        gex_sum = 0.0

        for row in strikes:
            k          = float(row.get("strikePrice") or 0)
            call_oi    = float(row.get("callOi")      or 0)
            put_oi     = float(row.get("putOi")       or 0)
            if not k:
                continue
            moneyness  = (k - spot) / spot
            gamma_wt   = math.exp(-0.5 * (moneyness / sigma) ** 2)
            # Dealers are short calls (negative gamma) and long puts (positive gamma)
            gex_sum   += (-call_oi + put_oi) * gamma_wt

        dealer_gex = gex_sum * lot * spot / 1e9  # ₹ billions

        print(
            f"[GEX] spot={spot:,.0f}  PCR={pcr_oi:.3f if pcr_oi else 'N/A'}  "
            f"dealer_gex={dealer_gex:+.2f}B  "
            f"call_ΔOI={call_oi_change:+,.0f}  put_ΔOI={put_oi_change:+,.0f}"
        )

        return {
            "dealer_gex":     dealer_gex,
            "pcr_oi":         pcr_oi,
            "call_oi_change": call_oi_change,
            "put_oi_change":  put_oi_change,
            "total_call_oi":  total_call_oi,
            "total_put_oi":   total_put_oi,
            "spot":           spot,
            "expiry":         expiry,
        }

    def save_nifty_gex(self, gex: dict) -> None:
        """Write Nifty GEX and related metrics to macro_asset_prices."""
        today = datetime.date.today().isoformat()
        now   = datetime.datetime.now().isoformat()

        rows = [
            ("NIFTY_GEX",              gex["dealer_gex"]),
            ("NIFTY_PUT_CALL_OI_RATIO", gex["pcr_oi"]),
            ("NIFTY_PUT_OI_CHANGE",     gex["put_oi_change"]),
            ("NIFTY_CALL_OI_CHANGE",    gex["call_oi_change"]),
        ]

        with self.engine.begin() as conn:
            for asset_name, value in rows:
                if value is None:
                    continue
                conn.execute(text("""
                    INSERT INTO macro_asset_prices
                        (symbol, date, close, fetched_at)
                    VALUES
                        (:symbol, :date, :close, :fetched_at)
                    ON CONFLICT(symbol, date) DO UPDATE SET
                        close      = excluded.close,
                        fetched_at = excluded.fetched_at
                """), {
                    "symbol": asset_name,
                    "date":       today,
                    "close":      value,
                    "fetched_at": now,
                })
                print(f"[GEX] Saved {asset_name}={value:.4f} for {today}")

    def run_nifty_gex(self) -> None:
        """Fetch Nifty strike-level OI from MoneyControl, compute GEX, and persist."""
        print(f"[GEX] Starting Nifty GEX fetch at {datetime.datetime.now()}")
        gex = self.fetch_nifty_gex()
        if gex:
            self.save_nifty_gex(gex)
            regime = "LONG GAMMA (mean-reversion)" if gex["dealer_gex"] > 0 else "SHORT GAMMA (trending)"
            print(f"[GEX] Regime signal: {regime}")
        else:
            print("[GEX] GEX fetch failed — nothing saved")

    def run(self, symbols: list[str], delay: float = 1.5):
        print(f"[PCR] Fetching {len(symbols)} symbols at {datetime.datetime.now()}")
        results = []

        for i, sym in enumerate(symbols):
            print(f"[PCR] ({i+1}/{len(symbols)}) {sym}...")
            rec = self.fetch_symbol_niftytrader(sym)
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
    parser.add_argument("--gex", action="store_true",
                        help="Fetch Nifty strike-level OI and compute dealer GEX → macro_asset_prices")
    args = parser.parse_args()

    fetcher = PCRFetcher()

    if args.gex:
        fetcher.run_nifty_gex()
    elif args.index:
        rec = fetcher.fetch_symbol_niftytrader(args.index)
        if rec:
            fetcher.save([rec])
            print(f"Saved index PCR: {rec}")
    else:
        symbols = [s.strip().upper() for s in args.symbols.split(",") if s.strip()] \
                  if args.symbols else DEFAULT_SYMBOLS
        fetcher.run(symbols, delay=args.delay)
