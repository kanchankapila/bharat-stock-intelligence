"""
Stock Option Chain Fetcher
==========================
Fetches NiftyTrader nearest-expiry option chain for each F&O stock and computes:

  1. expected_move_pct  — (ATM call LTP + ATM put LTP) / spot × 100
  2. stock_gex_proxy    — simplified dealer gamma exposure direction
                          (>0 = dealers long gamma = price-dampening)

Results are written to:
  • stock_option_features  — per-symbol / per-date row table (full detail)
  • technical_signals      — expected_move_pct + stock_gex_proxy columns patched in

Run:
    python stock_option_chain_fetcher.py                 # all F&O stocks
    python stock_option_chain_fetcher.py --symbol INFY   # single stock (debug)
    python stock_option_chain_fetcher.py --limit 10      # first N stocks
"""

import os
import sys
import time
import argparse
import calendar
import datetime
import math
import requests
from concurrent.futures import ThreadPoolExecutor, as_completed

from db_compat import get_engine, use_postgres
from sql_translate import translate, build_params
from sqlalchemy import text

# ─── NiftyTrader endpoint (same base URL used by pcr_fetcher and optionChainService) ──

NIFTYTRADER_CHAIN_URL = (
    "https://webapi.niftytrader.in/webapi/option/option-chain-data"
    "?symbol={symbol}&exchange=nse&expiryDate=&atmBelow=0&atmAbove=0"
)

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept":  "application/json, text/plain, */*",
    "Referer": "https://www.niftytrader.in/",
    "Origin":  "https://www.niftytrader.in",
}

SLEEP_BETWEEN = 0.3   # seconds — respectful rate-limit for a public API
BATCH_SIZE = 15
BATCH_GAP_SEC = 0.5


# ─── Black-Scholes implied volatility ─────────────────────────────────────────

def _bs_call(S: float, K: float, T: float, r: float, sigma: float) -> float:
    """Black-Scholes European call price."""
    if T <= 0 or sigma <= 0:
        return max(S - K, 0.0)
    d1 = (math.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * math.sqrt(T))
    d2 = d1 - sigma * math.sqrt(T)
    # Standard normal CDF via math.erfc
    def _N(x):
        return 0.5 * math.erfc(-x / math.sqrt(2))
    return S * _N(d1) - K * math.exp(-r * T) * _N(d2)


def _next_month_expiry(near_expiry: "datetime.date") -> "datetime.date":
    """Next month's expiry, inferred as the same weekday as `near_expiry` in the last 7
    days of next month. Derived from the live near-month expiry rather than a hardcoded
    weekday (e.g. "last Thursday") because NSE has changed the F&O expiry weekday more than
    once in recent years (Thursday -> Monday -> Tuesday) -- inferring from live data keeps
    this correct across future changes without a code edit."""
    next_month = near_expiry.month + 1 if near_expiry.month < 12 else 1
    next_year = near_expiry.year if near_expiry.month < 12 else near_expiry.year + 1
    last_day = calendar.monthrange(next_year, next_month)[1]
    last_date = datetime.date(next_year, next_month, last_day)
    offset = (last_date.weekday() - near_expiry.weekday()) % 7
    return last_date - datetime.timedelta(days=offset)


def _implied_vol(call_price: float, S: float, K: float, T: float,
                 r: float = 0.065) -> float | None:
    """Back-solve for IV using bisection on Black-Scholes call price.

    Returns annualised IV (e.g. 0.25 = 25%) or None if the price is outside
    the no-arbitrage bounds or bisection fails to converge.
    """
    if T <= 0 or call_price is None or S <= 0 or K <= 0:
        return None
    intrinsic = max(S - K * math.exp(-r * T), 0.0)
    if call_price < intrinsic - 0.01:   # price below intrinsic — bad data
        return None
    lo, hi = 1e-4, 5.0   # IV search range: 0.01% – 500%
    for _ in range(100):
        mid = (lo + hi) / 2
        price = _bs_call(S, K, T, r, mid)
        if abs(price - call_price) < 1e-4:
            return round(mid, 4)
        if price < call_price:
            lo = mid
        else:
            hi = mid
    return round((lo + hi) / 2, 4)


# ─── Schema helpers ────────────────────────────────────────────────────────────

_CREATE_FEATURES_TABLE = """
CREATE TABLE IF NOT EXISTS stock_option_features (
    symbol             TEXT NOT NULL,
    date               TEXT NOT NULL,
    expiry             TEXT,
    spot               REAL,
    atm_strike         REAL,
    atm_call_ltp       REAL,
    atm_put_ltp        REAL,
    expected_move_pct  REAL,
    total_call_oi      REAL,
    total_put_oi       REAL,
    gex_proxy          REAL,
    atm_iv             REAL,
    next_expiry_iv     REAL,
    iv_term_slope      REAL,
    fetched_at         TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (symbol, date)
)
"""

# Columns to add to technical_signals (ADD COLUMN IF NOT EXISTS — safe on repeat runs)
_TECHNICAL_SIGNALS_COLS = [
    ("expected_move_pct", "REAL"),
    ("stock_gex_proxy",   "REAL"),
    ("atm_iv",            "REAL"),
    # next_expiry_iv / iv_term_slope: options IV term structure. iv_term_slope =
    # next_expiry_iv - atm_iv; negative (backwardation, near-term IV > far-term) often
    # signals an anticipated near-term event (earnings, corporate action); positive
    # (contango) is the normal calm-market shape.
    ("next_expiry_iv",    "REAL"),
    ("iv_term_slope",     "REAL"),
]

# stock_option_features predates atm_iv/next_expiry_iv/iv_term_slope -- CREATE TABLE IF NOT
# EXISTS is a no-op on the live table (already exists), so these need their own ADD COLUMN
# pass just like technical_signals above. Missed this on the first pass of this feature
# (2026-07-18) -- caught immediately by a live end-to-end run throwing UndefinedColumn.
_STOCK_OPTION_FEATURES_COLS = [
    ("atm_iv",         "REAL"),
    ("next_expiry_iv", "REAL"),
    ("iv_term_slope",  "REAL"),
]


def _add_columns_if_missing(engine, table: str, cols: list[tuple[str, str]]):
    pg = use_postgres()
    for col, dtype in cols:
        try:
            with engine.begin() as conn:
                if pg:
                    conn.execute(text(
                        f"ALTER TABLE {table} ADD COLUMN IF NOT EXISTS {col} {dtype}"
                    ))
                else:
                    conn.execute(text(
                        f"ALTER TABLE {table} ADD COLUMN {col} {dtype}"
                    ))
        except Exception:
            pass   # column already exists on SQLite (no IF NOT EXISTS support)


def ensure_schema(engine):
    """Create stock_option_features table; add columns to it and to technical_signals."""
    with engine.begin() as conn:
        conn.execute(text(translate(_CREATE_FEATURES_TABLE)))

    _add_columns_if_missing(engine, "stock_option_features", _STOCK_OPTION_FEATURES_COLS)
    _add_columns_if_missing(engine, "technical_signals", _TECHNICAL_SIGNALS_COLS)


# ─── Symbol list from nt_fno_dashboard ────────────────────────────────────────

def get_fno_symbols(engine, limit=None):
    """Return F&O symbols already known to NiftyTrader from nt_fno_dashboard."""
    sql = """
        SELECT DISTINCT symbol FROM nt_fno_dashboard
        WHERE date = (SELECT MAX(date) FROM nt_fno_dashboard)
        ORDER BY symbol
    """
    try:
        with engine.connect() as conn:
            rows = conn.execute(text(translate(sql))).fetchall()
        symbols = [r[0] for r in rows]
        if limit:
            symbols = symbols[:limit]
        return symbols
    except Exception as e:
        print(f"[StockOptionChain] Could not load symbols from nt_fno_dashboard: {e}")
        return []


# ─── Option chain fetch + compute ──────────────────────────────────────────────

def fetch_chain(session: requests.Session, symbol: str, expiry: str | None = None) -> dict | None:
    """Fetch an option chain from NiftyTrader — nearest expiry by default, or an explicit
    `expiry` (YYYY-MM-DD) for the term-structure second leg. Returns resultData or None."""
    url = NIFTYTRADER_CHAIN_URL.format(symbol=symbol.upper())
    if expiry:
        url = url.replace("expiryDate=", f"expiryDate={expiry}")
    try:
        resp = session.get(url, timeout=15)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[StockOptionChain] {symbol}: fetch error — {e}")
        return None

    if data.get("result") != 1 or not data.get("resultData"):
        return None
    return data["resultData"]


def _f(row, *keys):
    """Normalise field names — NiftyTrader uses snake_case keys, occasionally CE_/PE_-prefixed."""
    for k in keys:
        v = row.get(k)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                pass
    return 0.0


def _atm_iv_from_chain(oc: list, spot: float) -> tuple[float | None, str]:
    """ATM strike + Black-Scholes IV for one option-chain payload. Shared by the near-month
    (full feature set, via compute_features) and next-month (term-structure-only) legs."""
    def _strike(row):
        return _f(row, "strike_price")

    sorted_oc = sorted(oc, key=lambda r: abs(_strike(r) - spot))
    atm = sorted_oc[0]
    atm_strike   = _strike(atm)
    atm_call_ltp = _f(atm, "calls_ltp", "call_ltp", "CE_ltp")
    expiry_str = str(oc[0].get("expiry_date") or "")[:10]
    iv = None
    if atm_call_ltp > 0 and atm_strike > 0 and expiry_str:
        try:
            exp_date = datetime.date.fromisoformat(expiry_str)
            T = (exp_date - datetime.date.today()).days / 365.0
            iv = _implied_vol(atm_call_ltp, spot, atm_strike, T)
        except Exception:
            pass
    return iv, expiry_str


def next_month_iv(session: requests.Session, symbol: str, near_expiry_str: str) -> tuple[float | None, str | None]:
    """Fetch the next-month expiry's chain and return its ATM IV, for the term-structure
    feature (iv_term_slope = next_expiry_iv - atm_iv). Best-effort: returns (None, None) on
    any failure so a term-structure miss never blocks the near-month features that already
    worked. near_expiry_str drives which weekday to look for -- see _next_month_expiry."""
    try:
        near_date = datetime.date.fromisoformat(near_expiry_str)
        next_date = _next_month_expiry(near_date)
        result_data = fetch_chain(session, symbol, expiry=next_date.isoformat())
        if result_data is None:
            return None, None
        oc = result_data.get("opDatas") or result_data.get("optionChain") or []
        if not oc:
            return None, None
        spot = float(
            result_data.get("spotPrice") or oc[0].get("index_close") or oc[0].get("last_price") or 0
        )
        if spot <= 0:
            return None, None
        iv, expiry_str = _atm_iv_from_chain(oc, spot)
        return iv, expiry_str or next_date.isoformat()
    except Exception:
        return None, None


def compute_features(result_data: dict, symbol: str) -> dict | None:
    """Extract expected-move and GEX proxy from a NiftyTrader resultData payload."""
    oc = result_data.get("opDatas") or result_data.get("optionChain") or []
    if not oc:
        return None

    first = oc[0]
    spot = float(
        result_data.get("spotPrice")
        or first.get("index_close")
        or first.get("last_price")
        or 0
    )
    if spot <= 0:
        return None

    # Find ATM strike (closest to spot)
    def _strike(row):
        return _f(row, "strike_price")

    sorted_oc = sorted(oc, key=lambda r: abs(_strike(r) - spot))
    atm = sorted_oc[0]
    atm_strike    = _strike(atm)
    atm_call_ltp  = _f(atm, "calls_ltp",  "call_ltp",  "CE_ltp")
    atm_put_ltp   = _f(atm, "puts_ltp",   "put_ltp",   "PE_ltp")

    expected_move_pct = (atm_call_ltp + atm_put_ltp) / spot * 100 if spot > 0 else None

    atm_iv, expiry_str = _atm_iv_from_chain(oc, spot)

    # Simplified GEX proxy — OI imbalance within ±5% of spot
    near = [r for r in oc if spot > 0 and abs(_strike(r) - spot) / spot < 0.05]
    call_oi = sum(_f(r, "calls_oi", "call_oi", "CE_openInterest") for r in near)
    put_oi  = sum(_f(r, "puts_oi",  "put_oi",  "PE_openInterest") for r in near)
    total_oi = call_oi + put_oi
    gex_proxy = (put_oi - call_oi) / total_oi if total_oi > 0 else 0.0

    total_call_oi = sum(_f(r, "calls_oi", "call_oi") for r in oc)
    total_put_oi  = sum(_f(r, "puts_oi",  "put_oi")  for r in oc)
    expiry = expiry_str

    return {
        "symbol":            symbol.upper(),
        "expiry":            expiry,
        "spot":              spot,
        "atm_strike":        atm_strike,
        "atm_call_ltp":      atm_call_ltp,
        "atm_put_ltp":       atm_put_ltp,
        "expected_move_pct": expected_move_pct,
        "total_call_oi":     total_call_oi,
        "total_put_oi":      total_put_oi,
        "gex_proxy":         gex_proxy,
        "atm_iv":            atm_iv,
    }


# ─── DB writes ─────────────────────────────────────────────────────────────────

_UPSERT_FEATURES_PG = """
INSERT INTO stock_option_features
    (symbol, date, expiry, spot, atm_strike, atm_call_ltp, atm_put_ltp,
     expected_move_pct, total_call_oi, total_put_oi, gex_proxy, atm_iv,
     next_expiry_iv, iv_term_slope, fetched_at)
VALUES
    (:symbol, :date, :expiry, :spot, :atm_strike, :atm_call_ltp, :atm_put_ltp,
     :expected_move_pct, :total_call_oi, :total_put_oi, :gex_proxy, :atm_iv,
     :next_expiry_iv, :iv_term_slope, :fetched_at)
ON CONFLICT (symbol, date) DO UPDATE SET
    expiry            = EXCLUDED.expiry,
    spot              = EXCLUDED.spot,
    atm_strike        = EXCLUDED.atm_strike,
    atm_call_ltp      = EXCLUDED.atm_call_ltp,
    atm_put_ltp       = EXCLUDED.atm_put_ltp,
    expected_move_pct = EXCLUDED.expected_move_pct,
    total_call_oi     = EXCLUDED.total_call_oi,
    total_put_oi      = EXCLUDED.total_put_oi,
    gex_proxy         = EXCLUDED.gex_proxy,
    atm_iv            = EXCLUDED.atm_iv,
    next_expiry_iv    = EXCLUDED.next_expiry_iv,
    iv_term_slope     = EXCLUDED.iv_term_slope,
    fetched_at        = EXCLUDED.fetched_at
"""

_UPSERT_FEATURES_SL = """
INSERT OR REPLACE INTO stock_option_features
    (symbol, date, expiry, spot, atm_strike, atm_call_ltp, atm_put_ltp,
     expected_move_pct, total_call_oi, total_put_oi, gex_proxy, atm_iv,
     next_expiry_iv, iv_term_slope, fetched_at)
VALUES
    (:symbol, :date, :expiry, :spot, :atm_strike, :atm_call_ltp, :atm_put_ltp,
     :expected_move_pct, :total_call_oi, :total_put_oi, :gex_proxy, :atm_iv,
     :next_expiry_iv, :iv_term_slope, :fetched_at)
"""

# Also mirror atm_iv into stock_options_oi so iv_features.py can compute rolling iv_rank
_UPSERT_OI_IV_PG = """
INSERT INTO stock_options_oi
    (symbol, date, expiry, call_oi, put_oi, pcr,
     total_call_oi, total_put_oi, market_pcr, atm_iv, iv_skew, fetched_at)
VALUES
    (:symbol, :date, :expiry, :call_oi, :put_oi, :pcr,
     :total_call_oi, :total_put_oi, :market_pcr, :atm_iv, :iv_skew, :fetched_at)
ON CONFLICT (symbol, date, expiry) DO UPDATE SET
    atm_iv     = EXCLUDED.atm_iv,
    fetched_at = EXCLUDED.fetched_at
"""

_UPSERT_OI_IV_SL = """
INSERT OR IGNORE INTO stock_options_oi
    (symbol, date, expiry, call_oi, put_oi, pcr,
     total_call_oi, total_put_oi, market_pcr, atm_iv, iv_skew, fetched_at)
VALUES
    (:symbol, :date, :expiry, :call_oi, :put_oi, :pcr,
     :total_call_oi, :total_put_oi, :market_pcr, :atm_iv, :iv_skew, :fetched_at)
"""

_PATCH_TECHNICAL_SIGNALS_PG = """
UPDATE technical_signals
SET expected_move_pct = :expected_move_pct,
    stock_gex_proxy   = :gex_proxy,
    atm_iv            = :atm_iv,
    next_expiry_iv    = :next_expiry_iv,
    iv_term_slope     = :iv_term_slope
WHERE symbol = :symbol
  AND date = (SELECT MAX(date) FROM technical_signals t2 WHERE t2.symbol = :symbol)
"""

_PATCH_TECHNICAL_SIGNALS_SL = _PATCH_TECHNICAL_SIGNALS_PG   # same syntax


def upsert_features(engine, row: dict, today: str):
    params = {**row, "date": today, "fetched_at": datetime.datetime.utcnow().isoformat()}
    pg = use_postgres()
    sql = _UPSERT_FEATURES_PG if pg else _UPSERT_FEATURES_SL
    with engine.begin() as conn:
        conn.execute(text(translate(sql)), build_params(params))

    # Mirror into stock_options_oi so iv_features.py computes rolling iv_rank
    if row.get("atm_iv") is not None:
        pcr = (row["total_put_oi"] / row["total_call_oi"]
               if row.get("total_call_oi") and row["total_call_oi"] > 0 else None)
        oi_params = {
            "symbol":        row["symbol"],
            "date":          today,
            "expiry":        row.get("expiry", ""),
            "call_oi":       row.get("total_call_oi"),
            "put_oi":        row.get("total_put_oi"),
            "pcr":           pcr,
            "total_call_oi": row.get("total_call_oi"),
            "total_put_oi":  row.get("total_put_oi"),
            "market_pcr":    pcr,
            "atm_iv":        row["atm_iv"],
            "iv_skew":       None,
            "fetched_at":    params["fetched_at"],
        }
        oi_sql = _UPSERT_OI_IV_PG if pg else _UPSERT_OI_IV_SL
        with engine.begin() as conn:
            conn.execute(text(translate(oi_sql)), build_params(oi_params))


def patch_technical_signals(engine, symbol: str, today: str, expected_move_pct, gex_proxy, atm_iv,
                            next_expiry_iv=None, iv_term_slope=None):
    params = {
        "symbol":            symbol,
        "date":              today,
        "expected_move_pct": expected_move_pct,
        "gex_proxy":         gex_proxy,
        "atm_iv":            atm_iv,
        "next_expiry_iv":    next_expiry_iv,
        "iv_term_slope":     iv_term_slope,
    }
    sql = _PATCH_TECHNICAL_SIGNALS_PG if use_postgres() else _PATCH_TECHNICAL_SIGNALS_SL
    with engine.begin() as conn:
        conn.execute(text(translate(sql)), build_params(params))


# ─── Main ──────────────────────────────────────────────────────────────────────

def main():
    parser = argparse.ArgumentParser(description="Fetch per-stock option chain features")
    parser.add_argument("--symbol", help="Single symbol to process (for testing)")
    parser.add_argument("--limit",  type=int, help="Process only the first N symbols")
    args = parser.parse_args()

    engine = get_engine()
    ensure_schema(engine)

    today = datetime.date.today().isoformat()

    if args.symbol:
        symbols = [args.symbol.upper()]
    else:
        symbols = get_fno_symbols(engine, limit=args.limit)
        if not symbols:
            print("[StockOptionChain] No symbols found in nt_fno_dashboard. "
                  "Run nt_dashboard_fetcher.py first or pass --symbol.")
            sys.exit(1)

    print(f"[StockOptionChain] Processing {len(symbols)} symbols for {today}...")

    session = requests.Session()
    session.headers.update(HEADERS)

    successes = 0
    failures  = 0
    move_pcts = []
    done = 0

    def _fetch_one(symbol):
        result_data = fetch_chain(session, symbol)
        if result_data is None:
            return symbol, None
        row = compute_features(result_data, symbol)
        if row is None:
            return symbol, None
        # Term structure: next-month ATM IV minus near-month ATM IV. Best-effort second leg
        # (doubles the request count for this script) -- a miss here never drops the
        # near-month row, it just leaves next_expiry_iv/iv_term_slope null for this symbol.
        row["next_expiry_iv"] = None
        row["iv_term_slope"] = None
        if row.get("atm_iv") is not None and row.get("expiry"):
            nxt_iv, nxt_expiry = next_month_iv(session, symbol, row["expiry"])
            if nxt_iv is not None:
                row["next_expiry_iv"] = nxt_iv
                row["iv_term_slope"] = round(nxt_iv - row["atm_iv"], 4)
        return symbol, row

    for batch_start in range(0, len(symbols), BATCH_SIZE):
        batch = symbols[batch_start:batch_start + BATCH_SIZE]
        with ThreadPoolExecutor(max_workers=len(batch)) as pool:
            futures = [pool.submit(_fetch_one, s) for s in batch]
            for fut in as_completed(futures):
                symbol, row = fut.result()
                done += 1
                if row is None:
                    print(f"[StockOptionChain] {done}/{len(symbols)} {symbol}: no data or empty chain")
                    failures += 1
                    continue
                try:
                    upsert_features(engine, row, today)
                    patch_technical_signals(
                        engine, symbol, today,
                        row["expected_move_pct"], row["gex_proxy"], row.get("atm_iv"),
                        row.get("next_expiry_iv"), row.get("iv_term_slope"),
                    )
                    pct = row["expected_move_pct"]
                    iv  = row.get("atm_iv")
                    slope = row.get("iv_term_slope")
                    pct_str = f"{pct:.2f}%" if pct is not None else "n/a"
                    iv_str  = f"{iv*100:.1f}%" if iv is not None else "n/a"
                    slope_str = f"{slope*100:+.1f}pp" if slope is not None else "n/a"
                    print(f"[StockOptionChain] {done}/{len(symbols)} {symbol}: "
                          f"ATM={row['atm_strike']:.0f}  move={pct_str}  GEX={row['gex_proxy']:+.3f}  "
                          f"IV={iv_str}  termSlope={slope_str}")
                    if pct is not None:
                        move_pcts.append(pct)
                    successes += 1
                except Exception as e:
                    print(f"[StockOptionChain] {symbol}: DB write error — {e}")
                    failures += 1
        time.sleep(BATCH_GAP_SEC)

    avg_move = sum(move_pcts) / len(move_pcts) if move_pcts else 0.0
    print(
        f"[StockOptionChain] Done. {successes}/{len(symbols)} stocks processed. "
        f"Expected move avg: {avg_move:.1f}%"
    )


if __name__ == "__main__":
    main()
