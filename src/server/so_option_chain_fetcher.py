"""
so_option_chain_fetcher.py
==========================
Fetches full option chain with GREEKS from SmartOptions (Trendlyne) for all
F&O-eligible stocks and indices. Writes to:
  - so_option_chain       — per-strike CE/PE: price, volume, OI, IV, Delta, Gamma,
                            Theta, Vega, Rho, Build-Up
  - so_stock_oi_summary   — per stock/expiry: maxPain, ATM, MWPL, IV, PCR, futures

This is the only source in the platform that provides OPTIONS GREEKS for
individual stocks. Delta and Theta are used in oi_delta_features.py and
IV is cross-validated against pcr_fetcher.py ATM IV.

API: https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/
     ?stockCode={symbol}&expDate={expiry_date}

expDate must be a valid upcoming expiry for the stock. Nearest expiry per symbol
is fetched from nt_fno_expiry (populated by sync_nt_fno_symbols.py → NT expiry API)
or falls back to the nearest upcoming Thursday (NSE weekly expiry).

Run:
  python so_option_chain_fetcher.py                # all F&O stocks, nearest expiry
  python so_option_chain_fetcher.py --symbol BEL   # single stock
  python so_option_chain_fetcher.py --index NIFTY  # single index
  python so_option_chain_fetcher.py --expiry 2026-06-30  # force expiry date
  python so_option_chain_fetcher.py --delay 0.5    # seconds between requests (default 0.3)
"""

import argparse
import time
from datetime import date as _date, timedelta

import requests

from db_compat import execute, executemany, query_all

SO_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json",
    "Origin": "https://smartoptions.trendlyne.com",
    "Referer": "https://smartoptions.trendlyne.com/",
}

CHAIN_URL = (
    "https://smartoptions.trendlyne.com/phoenix/api/fno/option/chain/"
    "?stockCode={symbol}&expDate={expiry}"
)

# Column positions in the positional tableData array (from tableHeaders unique_name)
_COL = {
    "ce_price":     0,   "ce_day_chg":  1,  "ce_volume":   2,
    "ce_vol_chg":   3,   "ce_ttv":      4,  "ce_oi":       5,
    "ce_oi_chg":    6,   "ce_iv":       7,  "ce_iv_chg":   8,
    "ce_delta":     9,   "ce_gamma":   10,  "ce_rho":      11,
    "ce_theta":    12,   "ce_vega":    13,  "ce_buildup":  14,
    "strike":      17,
    "pe_price":    18,   "pe_day_chg": 19,  "pe_volume":   20,
    "pe_vol_chg":  21,   "pe_ttv":     22,  "pe_oi":       23,
    "pe_oi_chg":   24,   "pe_iv":      25,  "pe_iv_chg":   26,
    "pe_delta":    27,   "pe_gamma":   28,  "pe_rho":      29,
    "pe_theta":    30,   "pe_vega":    31,  "pe_buildup":  32,
}


def _nearest_thursday() -> str:
    """Next Thursday (NSE weekly expiry) >= today."""
    today = _date.today()
    days_ahead = (3 - today.weekday()) % 7  # 3 = Thursday
    return (today + timedelta(days=days_ahead)).isoformat()


def _get_nearest_expiry(symbol: str, exchange: str = "NSE") -> str:
    """Look up nearest upcoming expiry from nt_fno_expiry, fallback to nearest Thursday."""
    today = _date.today().isoformat()
    try:
        rows = query_all(
            "SELECT expiry FROM nt_fno_expiry WHERE symbol = ? AND exchange = ? AND expiry >= ? ORDER BY expiry LIMIT 1",
            (symbol.upper(), exchange, today)
        )
        if rows:
            return rows[0]["expiry"][:10]
    except Exception:
        pass
    return _nearest_thursday()


def _get_fno_symbols() -> list[str]:
    """Return all F&O-eligible NSE symbols."""
    try:
        rows = query_all(
            "SELECT symbol FROM nse_stocks WHERE fno_eligible = 1 ORDER BY symbol"
        )
        return [r["symbol"] for r in rows]
    except Exception:
        return []


def _sf(v) -> float | None:
    try:
        return float(v) if v is not None and v != "" else None
    except (TypeError, ValueError):
        return None


def fetch_chain(symbol: str, expiry: str) -> dict | None:
    url = CHAIN_URL.format(symbol=symbol, expiry=expiry)
    try:
        r = requests.get(url, headers=SO_HEADERS, timeout=20)
        if not r.ok or not r.text.strip():
            return None
        d = r.json()
        if d.get("head", {}).get("status") != "0":
            return None
        return d.get("body")
    except Exception as e:
        print(f"    [SO] fetch error {symbol}/{expiry}: {e}")
        return None


def _parse_chain(body: dict, symbol: str, today: str, expiry: str) -> tuple[list, dict | None]:
    """Parse tableData into chain rows + summary. Returns (chain_rows, summary_dict)."""
    rows = []
    for rec in body.get("tableData") or []:
        strike = _sf(rec[_COL["strike"]])
        if strike is None:
            continue
        rows.append((
            symbol, today, expiry, strike,
            _sf(rec[_COL["ce_price"]]),   _sf(rec[_COL["ce_volume"]]),
            _sf(rec[_COL["ce_oi"]]),      _sf(rec[_COL["ce_oi_chg"]]),
            _sf(rec[_COL["ce_iv"]]),      _sf(rec[_COL["ce_iv_chg"]]),
            _sf(rec[_COL["ce_delta"]]),   _sf(rec[_COL["ce_gamma"]]),
            _sf(rec[_COL["ce_theta"]]),   _sf(rec[_COL["ce_vega"]]),
            _sf(rec[_COL["ce_rho"]]),
            rec[_COL["ce_buildup"]] if len(rec) > _COL["ce_buildup"] else None,
            _sf(rec[_COL["pe_price"]]),   _sf(rec[_COL["pe_volume"]]),
            _sf(rec[_COL["pe_oi"]]),      _sf(rec[_COL["pe_oi_chg"]]),
            _sf(rec[_COL["pe_iv"]]),      _sf(rec[_COL["pe_iv_chg"]]),
            _sf(rec[_COL["pe_delta"]]),   _sf(rec[_COL["pe_gamma"]]),
            _sf(rec[_COL["pe_theta"]]),   _sf(rec[_COL["pe_vega"]]),
            _sf(rec[_COL["pe_rho"]]),
            rec[_COL["pe_buildup"]] if len(rec) > _COL["pe_buildup"] else None,
        ))

    # Stock-level summary
    iv_data  = body.get("IV") or {}
    pcr_data = body.get("expiryLevelPCRValues") or {}
    fut_data = body.get("futureData") or {}
    summary  = {
        "symbol":    symbol,
        "date":      today,
        "expiry":    expiry,
        "max_pain":  _sf(body.get("maxPain")),
        "atm":       _sf(body.get("atTheMoney")),
        "mwpl":      _sf(body.get("MWPL")),
        "iv_call":   _sf(iv_data.get("ce") or iv_data.get("call")),
        "iv_put":    _sf(iv_data.get("pe") or iv_data.get("put")),
        "pcr":       _sf(pcr_data.get(expiry) or (list(pcr_data.values())[0] if pcr_data else None)),
        "fut_price": _sf(fut_data.get("futurePrice") or fut_data.get("ltp")),
        "fut_oi":    _sf(fut_data.get("futureOI") or fut_data.get("oi")),
        "fut_oi_chg": _sf(fut_data.get("futureOIChange") or fut_data.get("oi_change")),
    }
    return rows, summary


def save_chain(chain_rows: list, summary: dict | None) -> int:
    if chain_rows:
        executemany("""
            INSERT INTO so_option_chain
                (symbol, date, expiry, strike,
                 ce_price, ce_volume, ce_oi, ce_oi_chg_pct, ce_iv, ce_iv_chg,
                 ce_delta, ce_gamma, ce_theta, ce_vega, ce_rho, ce_buildup,
                 pe_price, pe_volume, pe_oi, pe_oi_chg_pct, pe_iv, pe_iv_chg,
                 pe_delta, pe_gamma, pe_theta, pe_vega, pe_rho, pe_buildup)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (symbol, date, expiry, strike) DO UPDATE SET
                ce_price=excluded.ce_price, ce_volume=excluded.ce_volume,
                ce_oi=excluded.ce_oi, ce_oi_chg_pct=excluded.ce_oi_chg_pct,
                ce_iv=excluded.ce_iv, ce_iv_chg=excluded.ce_iv_chg,
                ce_delta=excluded.ce_delta, ce_gamma=excluded.ce_gamma,
                ce_theta=excluded.ce_theta, ce_vega=excluded.ce_vega,
                ce_rho=excluded.ce_rho, ce_buildup=excluded.ce_buildup,
                pe_price=excluded.pe_price, pe_volume=excluded.pe_volume,
                pe_oi=excluded.pe_oi, pe_oi_chg_pct=excluded.pe_oi_chg_pct,
                pe_iv=excluded.pe_iv, pe_iv_chg=excluded.pe_iv_chg,
                pe_delta=excluded.pe_delta, pe_gamma=excluded.pe_gamma,
                pe_theta=excluded.pe_theta, pe_vega=excluded.pe_vega,
                pe_rho=excluded.pe_rho, pe_buildup=excluded.pe_buildup,
                fetched_at=CURRENT_TIMESTAMP
        """, chain_rows)

    if summary:
        execute("""
            INSERT INTO so_stock_oi_summary
                (symbol, date, expiry, max_pain, atm, mwpl, iv_call, iv_put,
                 pcr, fut_price, fut_oi, fut_oi_chg)
            VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
            ON CONFLICT (symbol, date, expiry) DO UPDATE SET
                max_pain=excluded.max_pain, atm=excluded.atm, mwpl=excluded.mwpl,
                iv_call=excluded.iv_call, iv_put=excluded.iv_put,
                pcr=excluded.pcr, fut_price=excluded.fut_price,
                fut_oi=excluded.fut_oi, fut_oi_chg=excluded.fut_oi_chg,
                fetched_at=CURRENT_TIMESTAMP
        """, (
            summary["symbol"], summary["date"], summary["expiry"],
            summary["max_pain"], summary["atm"], summary["mwpl"],
            summary["iv_call"], summary["iv_put"], summary["pcr"],
            summary["fut_price"], summary["fut_oi"], summary["fut_oi_chg"],
        ))

    return len(chain_rows)


def run_symbol(symbol: str, expiry: str | None = None, today: str | None = None) -> int:
    today = today or _date.today().isoformat()
    exp = expiry or _get_nearest_expiry(symbol)
    body = fetch_chain(symbol, exp)
    if body is None:
        return 0
    chain_rows, summary = _parse_chain(body, symbol.upper(), today, exp)
    return save_chain(chain_rows, summary)


def run(
    target_symbol: str | None = None,
    expiry: str | None = None,
    delay: float = 0.3,
) -> None:
    today = _date.today().isoformat()

    if target_symbol:
        symbols = [target_symbol.upper()]
    else:
        symbols = _get_fno_symbols()
        if not symbols:
            # fallback: top liquid F&O stocks
            symbols = ["NIFTY", "BANKNIFTY", "FINNIFTY", "RELIANCE", "TCS",
                       "INFY", "HDFCBANK", "SBIN", "ITC", "BEL"]

    print(f"[so_chain] Fetching option chains for {len(symbols)} symbols ...")
    ok = fail = 0
    for i, sym in enumerate(symbols):
        exp = expiry or _get_nearest_expiry(sym)
        print(f"  [{i+1}/{len(symbols)}] {sym} (expiry={exp}) ...", end=" ", flush=True)
        body = fetch_chain(sym, exp)
        if body is None:
            print("no data")
            fail += 1
        else:
            chain_rows, summary = _parse_chain(body, sym, today, exp)
            n = save_chain(chain_rows, summary)
            mp = summary["max_pain"] if summary else None
            print(f"{n} strikes  maxPain={mp}")
            ok += 1
        if delay > 0:
            time.sleep(delay)

    print(f"[so_chain] Done. ok={ok} fail={fail} total={ok+fail}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", default=None, help="Single stock, e.g. BEL")
    parser.add_argument("--index",  default=None, help="Index, e.g. NIFTY")
    parser.add_argument("--expiry", default=None, help="Expiry date YYYY-MM-DD")
    parser.add_argument("--delay",  type=float, default=0.3)
    args = parser.parse_args()

    sym = args.symbol or args.index
    run(target_symbol=sym, expiry=args.expiry, delay=args.delay)
