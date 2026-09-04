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

import polars as pl
from pydantic import BaseModel
from base_fetcher import BaseFetcher, governed_fetcher

class PcrFetcherSchema(BaseModel):
    symbol: str | None = None
    date: str | None = None

class PcrFetcherBaseFetcher(BaseFetcher[PcrFetcherSchema]):
    fetcher_name = 'PcrFetcher'
    domain = 'general'
    schema = PcrFetcherSchema
    min_interval_sec = 0.5


import os
import math
import time
import datetime
import argparse
import requests
import pandas as pd
from concurrent.futures import ThreadPoolExecutor, as_completed
from sqlalchemy import text

from db_compat import get_engine
from fetch_utils import retry_get, FetchTracker
from so_chain_source import chain_rows, has_chain
from as_of import logical_write_floor
import sys

# Live-measured 2026-08-28 against NiftyTrader's option-chain endpoint (fetch_symbol_niftytrader,
# the active path -- NOT the legacy/unused NSE fetch_symbol method, which sits behind Akamai and
# is untested here): 4 concurrent workers, 4/4 ok, ~3.3x speedup, zero errors. Kept modest (this
# universe is a small, bounded Nifty-50-ish list, not the ~2000-stock scale) rather than jumping
# straight to the 8 workers validated for other providers.
MAX_WORKERS = 4

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
            resp = retry_get(self.session, url, timeout=15)
            data = resp.json()
        except Exception as e:
            print(f"[PCR] {symbol}: fetch error after retries — {e}", file=sys.stderr)
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
            resp = retry_get(self.session, url, timeout=15)
            data = resp.json()
        except Exception as e:
            print(f"[PCR] {symbol}: fetch error after retries — {e}", file=sys.stderr)
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
            print(f"[PCR] {symbol}: parse error — {e}", file=sys.stderr)
            return None

    def save(self, records: list[dict]) -> int:
        if not records:
            return 0

        # logical_write_floor(), not date.today(): this is recurring-bugs.md's
        # date.today()-as-a-write-anchor class. Two concrete problems it caused here, both
        # observed live 2026-09-04 rather than reasoned about -- (1) a post-close run that
        # crosses midnight IST stamps rows for a session that never happened, and (2) it
        # disagreed with stock_option_chain_fetcher.py, the OTHER writer of this same table,
        # which already anchors on logical_write_floor() -- so the same trading session's
        # option data was being split across two different `date` values (12 rows dated
        # 2026-09-04 from here, 152 dated 2026-09-03 from there), which every consumer joining
        # on (symbol, date) then reads as a coverage collapse.
        today = logical_write_floor(fallback=datetime.date.today().isoformat())
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
            print(f"[GEX] HTTP error fetching {url}: {e}", file=sys.stderr)
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
        # dates may be a list OR a dict keyed by something other than 0.
        # Normalise to a flat list of values before picking the first entry.
        if isinstance(dates, dict):
            dates = list(dates.values())
        elif not isinstance(dates, list):
            dates = list(dates)
        if not dates:
            print("[GEX] Could not parse expiry date list from MoneyControl")
            return None
        # Pick the first (nearest) entry
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

        Source: NiftyTrader index option-chain — the same working feed already used for
        equity OI/PCR. MoneyControl's oiData endpoints (expiry-dates + oi-change-chart)
        began returning HTTP 404 in Jul 2026, so both the expiry lookup and strike OI are
        sourced here. NiftyTrader carries absolute strike OI (calls_oi/puts_oi), the spot
        (index_close), and total OI/ΔOI (opTotals) — everything GEX needs, single expiry.
        """
        url = NIFTYTRADER_CHAIN_URL.format(symbol="NIFTY")
        try:
            resp = self.session.get(url, timeout=15)
            resp.raise_for_status()
            data = resp.json()
        except Exception as e:
            print(f"[GEX] Failed to fetch Nifty option chain from NiftyTrader: {e}", file=sys.stderr)
            return None

        rd      = data.get("resultData") or {}
        strikes = rd.get("opDatas") or []
        if not strikes:
            print("[GEX] Empty NiftyTrader option chain — cannot compute GEX")
            return None

        spot   = next((float(r.get("index_close") or 0) for r in strikes if r.get("index_close")), 0.0)
        expiry = str(strikes[0].get("expiry_date") or "")[:10]
        if not spot:
            print("[GEX] Missing spot (index_close) — cannot compute GEX")
            return None

        total            = (rd.get("opTotals") or {}).get("total_calls_puts") or {}
        total_call_oi    = float(total.get("total_calls_oi")        or 0)
        total_put_oi     = float(total.get("total_puts_oi")         or 0)
        call_oi_change   = float(total.get("total_calls_change_oi") or 0)
        put_oi_change    = float(total.get("total_puts_change_oi")  or 0)

        pcr_oi = total_put_oi / total_call_oi if total_call_oi > 0 else None

        sigma   = NIFTY_GEX_SIGMA
        lot     = NIFTY_LOT_SIZE
        gex_sum = 0.0

        for row in strikes:
            k          = float(row.get("strike_price") or 0)
            call_oi    = float(row.get("calls_oi")     or 0)
            put_oi     = float(row.get("puts_oi")      or 0)
            if not k:
                continue
            moneyness  = (k - spot) / spot
            gamma_wt   = math.exp(-0.5 * (moneyness / sigma) ** 2)
            # Dealers are short calls (negative gamma) and long puts (positive gamma)
            gex_sum   += (-call_oi + put_oi) * gamma_wt

        dealer_gex = gex_sum * lot * spot / 1e9  # ₹ billions

        pcr_str = f"{pcr_oi:.3f}" if pcr_oi else "N/A"
        print(
            f"[GEX] spot={spot:,.0f}  PCR={pcr_str}  "
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

    def fetch_symbol_from_so_chain(self, symbol: str) -> dict | None:
        """Derive the same record shape as fetch_symbol() from `so_option_chain`.

        The staleness/expiry guards and the front-month selection live in so_chain_source so
        stock_option_chain_fetcher.py shares exactly one copy of them -- see that module's
        docstring for why this fallback exists and what it measured.
        """
        try:
            got = chain_rows(self.engine, symbol)
            if not got:
                return None
            _as_of, underlying, near = got

            def _i(v):
                return int(v) if v is not None else 0

            near_call_oi = sum(_i(r["ce_oi"]) for r in near)
            near_put_oi = sum(_i(r["pe_oi"]) for r in near)
            near_call_vol = sum(_i(r["ce_volume"]) for r in near)
            near_put_vol = sum(_i(r["pe_volume"]) for r in near)

            near_strikes = [
                (float(r["strike"]), float(r["ce_iv"] or 0), float(r["pe_iv"] or 0))
                for r in near if r["strike"] is not None
            ]
            atm_iv, iv_skew = compute_atm_iv_skew(near_strikes, underlying)

            max_pain, best_pain = underlying, float("inf")
            for sp, _c, _p in near_strikes:
                pain = 0.0
                for r in near:
                    st = float(r["strike"] or 0)
                    if sp > st:
                        pain += _i(r["ce_oi"]) * (sp - st)
                    elif sp < st:
                        pain += _i(r["pe_oi"]) * (st - sp)
                if pain < best_pain:
                    best_pain, max_pain = pain, sp

            # chain_rows() returns the front-month slice only, so near totals ARE the totals
            # available from this source -- market_pcr therefore equals pcr here, unlike the
            # NiftyTrader path where a multi-expiry payload makes them differ.
            return {
                "symbol":        symbol,
                "expiry":        near[0]["expiry"],
                "call_oi":       near_call_oi,
                "put_oi":        near_put_oi,
                "pcr":           near_put_oi / near_call_oi if near_call_oi > 0 else None,
                "pcr_vol":       near_put_vol / near_call_vol if near_call_vol > 0 else None,
                "total_call_oi": near_call_oi,
                "total_put_oi":  near_put_oi,
                "market_pcr":    near_put_oi / near_call_oi if near_call_oi > 0 else None,
                "atm_iv":        atm_iv,
                "iv_skew":       iv_skew,
                "max_pain":      max_pain,
            }
        except Exception as e:
            print(f"[PCR] {symbol}: so_option_chain fallback error - {e}", file=sys.stderr)
            return None

    def _fetch_one_paced(self, sym: str, delay: float) -> tuple[dict | None, bool]:
        """Returns (record, covered). `covered` is False only when NO source carries this
        symbol at all -- distinct from a source carrying it and the fetch failing."""
        rec = self.fetch_symbol_niftytrader(sym)
        if rec is not None:
            time.sleep(delay)
            return rec, True
        # DB-only fallback: no network call, so the inter-request pacing sleep would buy
        # nothing. Return straight away rather than idling the worker.
        fallback = self.fetch_symbol_from_so_chain(sym)
        if fallback is not None:
            return fallback, True
        time.sleep(delay)
        return None, self.so_chain_has(sym)

    def so_chain_has(self, symbol: str) -> bool:
        """True when a usable chain exists for `symbol`; see so_chain_source.has_chain()."""
        return has_chain(self.engine, symbol)

    def run(self, symbols: list[str], delay: float = 1.5):
        print(f"[PCR] Fetching {len(symbols)} symbols at {datetime.datetime.now()}")
        results = []
        uncovered: list[str] = []
        tracker = FetchTracker("pcr_fetcher")

        # Parallel fetch (network only) -- tracker.record()/results.append() stay on the main
        # thread as futures resolve. `delay` now paces each WORKER's own successive calls
        # (still meaningful under concurrency) rather than serializing every request platform-
        # wide. FetchTracker's abort_after_consecutive_fails is unset here (default None), so
        # there's no consecutive-count semantic to preserve across threads -- only the aggregate
        # fail-rate finish() check, which is safe to accumulate this way.
        with ThreadPoolExecutor(max_workers=MAX_WORKERS) as pool:
            futures = {pool.submit(self._fetch_one_paced, sym, delay): sym for sym in symbols}
            done = 0
            for fut in as_completed(futures):
                sym = futures[fut]
                done += 1
                rec, covered = fut.result()
                print(f"[PCR] ({done}/{len(symbols)}) {sym}...")
                if rec is None and not covered:
                    # Not a fetch failure: no surviving source carries this symbol at all.
                    # Recorded and printed below, never silently dropped -- see so_chain_has().
                    uncovered.append(sym)
                else:
                    tracker.record(sym, ok=rec is not None)
                if rec:
                    results.append(rec)
                    pcr_str = f"{rec['pcr']:.3f}" if rec['pcr'] is not None else "N/A"
                    print(f"[PCR]   PCR={pcr_str}  call_oi={rec['call_oi']:,}  put_oi={rec['put_oi']:,}")

        saved = self.save(results)
        print(f"\n[PCR] Done. Saved {saved}/{len(symbols)} symbols to stock_options_oi.")
        if uncovered:
            print(f"[PCR] {len(uncovered)}/{len(symbols)} symbol(s) have no chain in ANY "
                  f"surviving source and are NOT counted as fetch failures: "
                  f"{', '.join(sorted(uncovered))}", file=sys.stderr)
        tracker.finish()  # exits non-zero if the failure rate crosses threshold

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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
