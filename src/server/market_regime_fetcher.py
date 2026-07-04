#!/usr/bin/env python3
"""
Market Regime Fetcher
=====================
Fetches three regime-critical real-time signals and persists them to macro_asset_prices:

  1. INDIA_VIX       — fear gauge (NSE allIndices endpoint)
  2. USDINR_RATE     — currency risk (MoneyControl major currencies)
     USDINR_CHG_PCT  — intraday % change
  3. NIFTY_BASIS_PCT — annualized futures basis (NSE liveEquity-derivatives)
     NIFTY_CONTANGO  — 1=contango (normal), 0=backwardation (stress)

Run modes:
  python market_regime_fetcher.py           # all three signals, single run
  python market_regime_fetcher.py --once    # alias for single run (explicit)
  python market_regime_fetcher.py --vix     # only VIX
  python market_regime_fetcher.py --fx      # only USDINR
  python market_regime_fetcher.py --basis   # only futures basis

Designed to run every 15 minutes during market hours (09:15–15:30 IST Mon–Fri).
"""

import argparse
import datetime
import time

import requests
from curl_cffi import requests as cffi_requests
from sqlalchemy import text

from db_compat import get_engine

# ---------------------------------------------------------------------------
# NSE session headers — same pattern used across NSE-sourced fetchers
# ---------------------------------------------------------------------------
NSE_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":          "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer":         "https://www.nseindia.com/",
    "Origin":          "https://www.nseindia.com",
    "DNT":             "1",
}

NSE_INDICES_URL  = "https://www.nseindia.com/api/allIndices"
# NSE liveEquity-derivatives returns HTTP 500 as of June 2026 (server-side issue).
# Fallback: NiftyTrader dashboard-data carries maxPain + expiry data but not spot/futures.
# Basis is skipped gracefully when NSE is unavailable.
NSE_FUTURES_URL  = "https://www.nseindia.com/api/liveEquity-derivatives?index=nifty50"
NT_DASHBOARD_URL = "https://webapi.niftytrader.in/webapi/Option/dashboard-data"
NT_HEADERS_BASIS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}
NSE_HOME_URL     = "https://www.nseindia.com"

# MoneyControl major currencies endpoint (same one mc_global_macro_fetcher.py uses —
# the old currency/get-currency-data path was retired by MC)
MC_CURRENCY_URL  = (
    "https://api.moneycontrol.com/mcapi/v1/us-markets/getCurrencies"
)
MC_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept":     "application/json",
    "Referer":    "https://www.moneycontrol.com/",
    "Origin":     "https://www.moneycontrol.com",
}

# VIX regime thresholds (for display only)
VIX_REGIMES = [
    (12,  "complacency"),
    (18,  "normal"),
    (25,  "elevated"),
    (999, "fear/BEAR"),
]


def _vix_regime(vix: float) -> str:
    for threshold, label in VIX_REGIMES:
        if vix < threshold:
            return label
    return "fear/BEAR"


# ---------------------------------------------------------------------------
# DB write helper — mirrors pcr_fetcher.save_nifty_gex pattern
# ---------------------------------------------------------------------------

def _save_macro_rows(engine, rows: list[tuple[str, float]]) -> None:
    """Upsert (asset_name, price) rows into macro_asset_prices for today."""
    today      = datetime.date.today().isoformat()
    fetched_at = datetime.datetime.now().isoformat()

    with engine.begin() as conn:
        for asset_name, price in rows:
            if price is None:
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
                "close":      price,
                "fetched_at": fetched_at,
            })


# ---------------------------------------------------------------------------
# NSE session bootstrap — warms the cookie jar before hitting data endpoints
# ---------------------------------------------------------------------------

def _nse_session() -> requests.Session:
    """Return a requests.Session with a warm NSE session cookie."""
    session = requests.Session()
    session.headers.update(NSE_HEADERS)
    try:
        session.get(NSE_HOME_URL, timeout=10)
        time.sleep(0.5)
    except Exception as e:
        print(f"[MarketRegime] NSE session warm-up warning: {e}")
    return session


# ---------------------------------------------------------------------------
# Signal 1: India VIX
# ---------------------------------------------------------------------------

def fetch_vix(session: requests.Session) -> float | None:
    """Fetch live India VIX from NSE allIndices endpoint."""
    try:
        resp = session.get(NSE_INDICES_URL, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[MarketRegime] VIX fetch error: {e}")
        return None

    indices = data.get("data") or []
    for item in indices:
        if (item.get("index") or "").strip().upper() == "INDIA VIX":
            try:
                vix_val = float(item["last"])
                # Sanity guard: India VIX historically ranges 8–80. Values outside suggest
                # a wrong field (e.g. totalTurnover) is being returned for the VIX slot.
                if not (5.0 < vix_val < 100.0):
                    print(f"[MarketRegime] VIX sanity fail: {vix_val} (expected 5–100), skipping")
                    return None
                return vix_val
            except (KeyError, ValueError, TypeError):
                pass

    print("[MarketRegime] VIX: 'India VIX' not found in allIndices response")
    return None


def run_vix(engine) -> float | None:
    session = _nse_session()
    vix = fetch_vix(session)
    if vix is not None:
        _save_macro_rows(engine, [("INDIA_VIX", vix)])
    return vix


# ---------------------------------------------------------------------------
# Signal 2: USDINR
# ---------------------------------------------------------------------------

def fetch_usdinr() -> tuple[float | None, float | None]:
    """Fetch USD/INR rate and intraday % change from MoneyControl.

    Returns (rate, chg_pct). Uses curl_cffi to bypass bot detection.
    """
    try:
        resp = cffi_requests.get(
            MC_CURRENCY_URL, headers=MC_HEADERS, impersonate="chrome110", timeout=15
        )
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        print(f"[MarketRegime] USDINR fetch error: {e}")
        return None, None

    # MC response structure: {"success": true, "data": [...]}
    data = payload.get("data") or []
    for item in data:
        pair = (item.get("pair") or item.get("name") or "").upper().replace(" ", "")
        if "USD" in pair and "INR" in pair:
            try:
                rate    = float(item.get("price") or item.get("ltp") or item.get("last") or 0)
                chg_pct = float(item.get("changePercent") or item.get("pChg") or item.get("change_pct") or item.get("chgper") or 0)
                if rate > 0:
                    return rate, chg_pct
            except (ValueError, TypeError):
                continue

    print("[MarketRegime] USDINR: USD/INR pair not found in MC currency response")
    return None, None


def run_fx(engine) -> tuple[float | None, float | None]:
    rate, chg_pct = fetch_usdinr()
    rows = []
    if rate is not None:
        rows.append(("USDINR_RATE", rate))
    if chg_pct is not None:
        rows.append(("USDINR_CHG_PCT", chg_pct))
    if rows:
        _save_macro_rows(engine, rows)
    return rate, chg_pct


# ---------------------------------------------------------------------------
# Signal 3: Nifty Futures Basis
# ---------------------------------------------------------------------------

def _fetch_basis_from_nt() -> tuple[float | None, int | None]:
    """Fallback: derive Nifty basis from NiftyTrader dashboard futures price,
    paired with the latest NIFTY50 spot close already captured by
    global_macro_fetcher.py into macro_indicators (dashboard-data has no
    spot price of its own — only the futures last_trade_price)."""
    import requests as _req
    try:
        r = _req.get(NT_DASHBOARD_URL, headers=NT_HEADERS_BASIS, timeout=10)
        d = r.json()
        if d.get("result") != 1:
            return None, None
        indices = ((d.get("resultData") or {}).get("indices")) or []
        entry = next((e for e in indices if str(e.get("symbol_name", "")).upper() == "NIFTY"), None)
        if not entry:
            return None, None

        fut = float(entry.get("last_trade_price") or 0)
        expiry_date = entry.get("expiry_date")
        if not fut or not expiry_date:
            return None, None
        days = (datetime.datetime.fromisoformat(expiry_date.split("T")[0]).date()
                - datetime.date.today()).days
        if days <= 0:
            return None, None

        with get_engine().connect() as conn:
            row = conn.execute(text(
                "SELECT value FROM macro_indicators WHERE indicator_name = 'NIFTY50' "
                "ORDER BY date DESC LIMIT 1"
            )).fetchone()
        spot = float(row[0]) if row and row[0] else 0
        if not spot:
            return None, None

        basis = (fut - spot) / spot * 100 * (365 / days)
        return round(basis, 4), 1 if basis > 0 else 0
    except Exception as e:
        print(f"[MarketRegime] NT dashboard fallback error: {e}")
    return None, None


def fetch_nifty_basis(session: requests.Session) -> tuple[float | None, int | None]:
    """Compute annualized Nifty futures basis from NSE liveEquity-derivatives.

    basis_pct (annualized) = (futures - spot) / spot × 100 × (365 / days_to_expiry)
    contango  = 1 if basis_pct > 0 (normal carry), 0 if backwardation (stress)

    Returns (basis_pct_annualized, contango_flag).
    """
    try:
        resp = session.get(NSE_FUTURES_URL, timeout=15)
        if resp.status_code in (500, 503):
            print(f"[MarketRegime] NSE liveEquity-derivatives HTTP {resp.status_code} — trying NiftyTrader fallback")
            return _fetch_basis_from_nt()
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[MarketRegime] Nifty futures fetch error: {e} — trying NiftyTrader fallback")
        return _fetch_basis_from_nt()

    # Extract spot price (underlying value)
    try:
        spot = float(data.get("underlyingValue") or 0)
    except (ValueError, TypeError):
        spot = 0

    if not spot:
        # Try alternate key paths
        meta = data.get("marketDeptOrderBook") or {}
        try:
            spot = float(meta.get("tradeInfo", {}).get("lastPrice") or 0)
        except (ValueError, TypeError):
            pass

    if not spot:
        print("[MarketRegime] Nifty basis: could not determine spot price")
        return None, None

    # Find near-month NIFTY futures contract
    contracts = data.get("data") or []
    today = datetime.date.today()
    best_contract = None
    best_days     = None

    for c in contracts:
        instrument = (c.get("instrumentType") or "").upper()
        symbol     = (c.get("symbol") or "").upper()
        # Only futures on NIFTY index (not equity futures)
        if instrument not in ("FUTIDX",) or symbol != "NIFTY":
            continue

        expiry_str = c.get("expiryDate") or ""
        try:
            # NSE returns expiry as "DD-Mon-YYYY" e.g. "27-Jun-2024"
            expiry_date = datetime.datetime.strptime(expiry_str, "%d-%b-%Y").date()
        except ValueError:
            try:
                expiry_date = datetime.datetime.strptime(expiry_str[:10], "%Y-%m-%d").date()
            except ValueError:
                continue

        days = (expiry_date - today).days
        if days < 0:
            continue  # already expired

        if best_days is None or days < best_days:
            best_days     = days
            best_contract = c

    if best_contract is None or best_days is None or best_days == 0:
        print("[MarketRegime] Nifty basis: no valid near-month NIFTY futures contract found")
        return None, None

    try:
        futures_price = float(
            best_contract.get("lastPrice")
            or best_contract.get("ltp")
            or best_contract.get("lastTradedPrice")
            or 0
        )
    except (ValueError, TypeError):
        futures_price = 0

    if not futures_price:
        print("[MarketRegime] Nifty basis: futures price is zero")
        return None, None

    raw_basis    = (futures_price - spot) / spot  # fractional
    ann_basis    = raw_basis * 100 * (365 / best_days)  # annualized %
    contango     = 1 if ann_basis > 0 else 0

    print(
        f"[MarketRegime] Nifty spot={spot:,.0f}  futures={futures_price:,.0f}  "
        f"expiry={best_contract.get('expiryDate')}  days={best_days}  "
        f"raw_basis={raw_basis*100:.3f}%  ann_basis={ann_basis:.2f}%"
    )
    return round(ann_basis, 4), contango


def run_basis(engine) -> tuple[float | None, int | None]:
    session = _nse_session()
    basis_pct, contango = fetch_nifty_basis(session)
    rows = []
    if basis_pct is not None:
        rows.append(("NIFTY_BASIS_PCT", basis_pct))
    if contango is not None:
        rows.append(("NIFTY_CONTANGO", float(contango)))
    if rows:
        _save_macro_rows(engine, rows)
    return basis_pct, contango


# ---------------------------------------------------------------------------
# Orchestrator
# ---------------------------------------------------------------------------

def run_all(engine, do_vix: bool, do_fx: bool, do_basis: bool) -> None:
    vix      = None
    rate     = None
    chg_pct  = None
    basis    = None
    contango = None

    if do_vix:
        session = _nse_session()
        vix = fetch_vix(session)
        if vix is not None:
            _save_macro_rows(engine, [("INDIA_VIX", vix)])

    if do_fx:
        rate, chg_pct = run_fx(engine)

    if do_basis:
        # Reuse a fresh session for basis (separate NSE cookie session to avoid stale cookies)
        session_b = _nse_session()
        basis, contango = fetch_nifty_basis(session_b)
        rows = []
        if basis is not None:
            rows.append(("NIFTY_BASIS_PCT", basis))
        if contango is not None:
            rows.append(("NIFTY_CONTANGO", float(contango)))
        if rows:
            _save_macro_rows(engine, rows)

    # ── Summary line ────────────────────────────────────────────────────────
    parts = []

    if vix is not None:
        parts.append(f"VIX={vix:.1f} ({_vix_regime(vix)})")
    elif do_vix:
        parts.append("VIX=n/a")

    if rate is not None:
        sign = "+" if (chg_pct or 0) >= 0 else ""
        chg_str = f"{sign}{chg_pct:.2f}%" if chg_pct is not None else "n/a"
        parts.append(f"USDINR={rate:.2f} ({chg_str})")
    elif do_fx:
        parts.append("USDINR=n/a")

    if basis is not None:
        carry_label = "contango" if contango else "backwardation"
        sign = "+" if basis >= 0 else ""
        parts.append(f"Nifty basis={sign}{basis:.1f}% ann ({carry_label})")
    elif do_basis:
        parts.append("Nifty basis=n/a")

    if parts:
        print(f"[MarketRegime] {', '.join(parts)}")


# ---------------------------------------------------------------------------
# Entry point
# ---------------------------------------------------------------------------

if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Fetch market regime signals: India VIX, USDINR, Nifty futures basis"
    )
    parser.add_argument("--once",  action="store_true", help="Single run (default behaviour)")
    parser.add_argument("--vix",   action="store_true", help="Only fetch India VIX")
    parser.add_argument("--fx",    action="store_true", help="Only fetch USDINR rate")
    parser.add_argument("--basis", action="store_true", help="Only fetch Nifty futures basis")
    args = parser.parse_args()

    # If no signal flag supplied, run all three
    any_flag = args.vix or args.fx or args.basis
    do_vix   = args.vix   or not any_flag
    do_fx    = args.fx    or not any_flag
    do_basis = args.basis or not any_flag

    engine = get_engine()
    run_all(engine, do_vix=do_vix, do_fx=do_fx, do_basis=do_basis)
