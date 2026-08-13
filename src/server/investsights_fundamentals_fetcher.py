#!/usr/bin/env python3
"""
Per-stock TTM financials + FMP ratios + growth metrics + DCF fair value, from InvestSights.

WHY THIS EXISTS
---------------
Onboarded via the `onboard-data-source` skill, 2026-08-13, batch pass over investsights.in +
tapetide.com. Four of InvestSights' per-stock endpoints, bundled into one fetcher because they
share a provider, a symbol-keyed resolution (see below), and a natural "today's fundamentals
snapshot" grain -- matching the existing convention of one file per PROVIDER-GROUP, not one per
endpoint (`mcApiService.ts`'s 20+ `fetchMc*` functions in one file is the same shape on the TS
side).

    https://investsights.in/api/v2/fundamentals/{symbol}/ttm
    https://investsights.in/api/v2/fundamentals/{symbol}/fmp-ratios?period=annual&limit=1
    https://investsights.in/api/v2/fundamentals/{symbol}/growth-metrics?period=annual&limit=1
    https://investsights.in/api/v2/fundamentals/{symbol}/dcf-valuation

DCF valuation does not exist anywhere else in this codebase -- this is the only source of a
fair-value estimate on the platform. `fmp-ratios` also carries Piotroski F-score and Altman
Z-score computed independently of this platform's own (`mc_stockvitals_history_fetcher.py`'s
Graham/Altman/Ohlson/DuPont harvest) -- a genuine cross-validation candidate, not assumed
redundant (see the two scores stored separately below, never averaged/reconciled here).

TICKER RESOLUTION -- confirmed trivial, live-verified 2026-08-13
------------------------------------------------------------------
`GET /api/v2/symbols/resolve/{symbol}` returns `{"found": true, "canonical": "<symbol>",
"was_alias": false}` for a plain NSE ticker -- InvestSights uses bare NSE symbols as its native
key, same as `endpoint_registry.py`'s own note for Tapetide. No `StockMapping` field, no
autocomplete cache, no ISIN fallback needed. This fetcher does not call `/symbols/resolve` per
row (that would double the request count for zero benefit) -- it trusts `nse_stocks.symbol`
directly, matching every other `investsights_*_fetcher.py` in this codebase.

ENDPOINT SHAPE -- verified live, do not "fix" these
----------------------------------------------------
* `ttm`'s three sub-statements (`income_statement`, `balance_sheet`, `cash_flow`) each carry
  their OWN `period_end_date`, and live-verified they can genuinely disagree (2025-12-31 /
  2025-09-30 / 2024-09-30 for the same WEBELSOLAR call) -- this is NOT a bug to reconcile, it's
  the provider mixing quarterly-lag sources per statement. This fetcher stores TTM's raw LEVEL
  figures (revenue/ebitda/net_profit/assets/debt/equity/cash-flow) keyed on the fetch date, not
  any of the three internal period_end_dates -- those raw levels are what `fmp-ratios` doesn't
  provide (it's ratios only, no absolute levels), so the two endpoints are combined by FIELD
  COMPLEMENT, not by picking one as authoritative and discarding the other.
* `fmp-ratios` is the authoritative RATIO source here (has Piotroski/Altman that `ttm.ratios`
  lacks); `ttm.ratios` itself is NOT stored, to avoid two conflicting `pe_ratio` columns from
  the same provider's two different calc paths for no analytical benefit.
* `dcf-valuation` can be a large negative number with `reliable: true` (live-verified:
  WEBELSOLAR's DCF value was -272 against a 96 stock price, upside_pct -382%) -- FMP's own DCF
  model, not a "some bracket didn't populate" artifact. Stored as-is; do not clip/reject
  negative DCF values.
* Blank string and literal `"null"` (seen live on other InvestSights endpoints this session)
  are not observed on these four, but `_num()` guards for them anyway, matching this
  provider's other fetchers in this codebase.

UNIVERSE
--------
`nse_stocks WHERE status = 'ACTIVE'`, ranked by `market_cap DESC`, bounded by `--limit`
(default 300) -- ponytail: no confirmed rate-limit budget from this provider yet, this cap
keeps a first run bounded and observable; widen once a real run's timing is known. `--symbol`
overrides for a single-stock run (used by the live_datasource test).

AS-OF DISCIPLINE
-----------------
Keyed on `(symbol, fetched_date)` using `as_of.logical_trading_date()`, not `date.today()` --
this fetcher can run post-close (evening market-metadata batch, matching its sibling
`investsights_*` fetchers), and a bare `date.today()` write-target is exactly the midnight-
crossing class documented in `recurring-bugs.md`.

Run:
  python investsights_fundamentals_fetcher.py --limit 300
  python investsights_fundamentals_fetcher.py --symbol RELIANCE
"""
import argparse
import sys
import time

import requests

from db_compat import connect, ConnWrapper
from fetch_utils import retry_get
from as_of import logical_trading_date

BASE = "https://investsights.in/api/v2/fundamentals"
SOURCE = "investsights"
RATE_LIMIT_SEC = 0.3

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _log(m):
    print(f"[InvestsightsFundamentals] {m}", flush=True)


def _num(raw, k):
    if raw is None:
        return None
    v = raw.get(k)
    if v is None or v == "" or (isinstance(v, str) and v.strip().lower() == "null"):
        return None
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f   # NaN -> None


# ── Fetch -- one function per endpoint, the ONLY fetch path each; tests call these directly ──

def fetch_ttm(session: requests.Session, symbol: str) -> dict | None:
    resp = retry_get(session, f"{BASE}/{symbol}/ttm", timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    return payload


def fetch_fmp_ratios(session: requests.Session, symbol: str) -> dict | None:
    resp = retry_get(session, f"{BASE}/{symbol}/fmp-ratios",
                      params={"period": "annual", "limit": 1}, timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    return payload.get("data")


def fetch_growth_metrics(session: requests.Session, symbol: str) -> dict | None:
    resp = retry_get(session, f"{BASE}/{symbol}/growth-metrics",
                      params={"period": "annual", "limit": 1}, timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    rows = payload.get("data") or []
    return rows[0] if rows else None


def fetch_dcf(session: requests.Session, symbol: str) -> dict | None:
    resp = retry_get(session, f"{BASE}/{symbol}/dcf-valuation", timeout=20)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        return None
    return payload.get("data")


# ── Parse ────────────────────────────────────────────────────────────────────

def parse_row(symbol: str, fetched_date: str, ttm: dict | None, fmp: dict | None,
               growth: dict | None, dcf: dict | None) -> dict | None:
    """Merge all four sub-responses into one row. None if every source came back empty --
    a fully-null row is not worth writing (matches _passes_rl_gate's fail-open convention:
    absence of data should not silently masquerade as a zero-valued row)."""
    if not any((ttm, fmp, growth, dcf)):
        return None

    inc = (ttm or {}).get("income_statement") or {}
    bal = (ttm or {}).get("balance_sheet") or {}
    cf = (ttm or {}).get("cash_flow") or {}

    return {
        "symbol": symbol, "fetched_date": fetched_date,
        # TTM raw levels -- fmp-ratios has no absolute levels, only ratios
        "ttm_revenue": _num(inc, "revenue"), "ttm_ebitda": _num(inc, "ebitda"),
        "ttm_net_profit": _num(inc, "net_profit"),
        "ttm_total_assets": _num(bal, "total_assets"), "ttm_total_debt": _num(bal, "total_debt"),
        "ttm_shareholders_equity": _num(bal, "shareholders_equity"),
        "ttm_operating_cash_flow": _num(cf, "operating_cash_flow"),
        "ttm_free_cash_flow": _num(cf, "free_cash_flow"),
        # fmp-ratios -- the authoritative ratio set (ttm.ratios deliberately not stored, see
        # module docstring)
        "pe_ratio": _num(fmp, "pe_ratio"), "price_to_book": _num(fmp, "price_to_book"),
        "price_to_sales": _num(fmp, "price_to_sales"), "ev_to_ebitda": _num(fmp, "ev_to_ebitda"),
        "gross_profit_margin": _num(fmp, "gross_profit_margin"),
        "operating_profit_margin": _num(fmp, "operating_profit_margin"),
        "net_profit_margin": _num(fmp, "net_profit_margin"),
        "return_on_equity": _num(fmp, "return_on_equity"),
        "return_on_assets": _num(fmp, "return_on_assets"),
        "return_on_capital_employed": _num(fmp, "return_on_capital_employed"),
        "current_ratio": _num(fmp, "current_ratio"), "quick_ratio": _num(fmp, "quick_ratio"),
        "debt_to_equity": _num(fmp, "debt_to_equity"),
        "interest_coverage": _num(fmp, "interest_coverage"),
        "piotroski_score": _num(fmp, "piotroski_score"),
        "altman_z_score": _num(fmp, "altman_z_score"),
        "eps_basic": _num(fmp, "eps_basic"), "dividend_yield": _num(fmp, "dividend_yield"),
        "fiscal_year": (fmp or {}).get("fiscal_year"),
        "period_end_date": ((fmp or {}).get("period_end_date") or "")[:10] or None,
        # growth-metrics
        "revenue_growth": _num(growth, "revenue_growth"),
        "net_income_growth": _num(growth, "net_income_growth"),
        "eps_growth": _num(growth, "eps_growth"),
        "operating_income_growth": _num(growth, "operating_income_growth"),
        "free_cash_flow_growth": _num(growth, "free_cash_flow_growth"),
        # dcf-valuation
        "dcf_stock_price": _num(dcf, "stock_price"), "dcf_value": _num(dcf, "dcf_value"),
        "dcf_upside_pct": _num(dcf, "upside_pct"),
        "dcf_reliable": int(bool(dcf.get("reliable"))) if dcf and dcf.get("reliable") is not None else None,
        "source": SOURCE,
    }


# ── Schema + store ──────────────────────────────────────────────────────────

COLS = [
    "symbol", "fetched_date",
    "ttm_revenue", "ttm_ebitda", "ttm_net_profit", "ttm_total_assets", "ttm_total_debt",
    "ttm_shareholders_equity", "ttm_operating_cash_flow", "ttm_free_cash_flow",
    "pe_ratio", "price_to_book", "price_to_sales", "ev_to_ebitda", "gross_profit_margin",
    "operating_profit_margin", "net_profit_margin", "return_on_equity", "return_on_assets",
    "return_on_capital_employed", "current_ratio", "quick_ratio", "debt_to_equity",
    "interest_coverage", "piotroski_score", "altman_z_score", "eps_basic", "dividend_yield",
    "fiscal_year", "period_end_date",
    "revenue_growth", "net_income_growth", "eps_growth", "operating_income_growth",
    "free_cash_flow_growth",
    "dcf_stock_price", "dcf_value", "dcf_upside_pct", "dcf_reliable",
    "source",
]


def ensure_schema(conn: ConnWrapper) -> None:
    # ponytail: explicit column list, not a generated one -- a clever comprehension here
    # (REAL-unless-TEXT-unless-dcf_reliable) previously mis-typed dcf_reliable and broke on
    # the first live write; a flat list is boring but cannot silently drift from COLS again.
    conn.execute("""
        CREATE TABLE IF NOT EXISTS investsights_fundamentals_history (
            symbol TEXT NOT NULL, fetched_date TEXT NOT NULL,
            ttm_revenue REAL, ttm_ebitda REAL, ttm_net_profit REAL, ttm_total_assets REAL,
            ttm_total_debt REAL, ttm_shareholders_equity REAL, ttm_operating_cash_flow REAL,
            ttm_free_cash_flow REAL,
            pe_ratio REAL, price_to_book REAL, price_to_sales REAL, ev_to_ebitda REAL,
            gross_profit_margin REAL, operating_profit_margin REAL, net_profit_margin REAL,
            return_on_equity REAL, return_on_assets REAL, return_on_capital_employed REAL,
            current_ratio REAL, quick_ratio REAL, debt_to_equity REAL, interest_coverage REAL,
            piotroski_score REAL, altman_z_score REAL, eps_basic REAL, dividend_yield REAL,
            fiscal_year TEXT, period_end_date TEXT,
            revenue_growth REAL, net_income_growth REAL, eps_growth REAL,
            operating_income_growth REAL, free_cash_flow_growth REAL,
            dcf_stock_price REAL, dcf_value REAL, dcf_upside_pct REAL, dcf_reliable INTEGER,
            source TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, fetched_date)
        )
    """)
    conn.commit()


def store_row(conn: ConnWrapper, row: dict | None) -> int:
    if not row:
        return 0
    ph = ",".join(["?"] * len(COLS))
    update_cols = [c for c in COLS if c not in ("symbol", "fetched_date")]
    updates = ", ".join(f"{c}=excluded.{c}" for c in update_cols)
    sql = (f"INSERT INTO investsights_fundamentals_history ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (symbol, fetched_date) DO UPDATE SET {updates}")
    conn.execute(sql, tuple(row[c] for c in COLS))
    conn.commit()
    return 1


# ── Run ──────────────────────────────────────────────────────────────────────

def _load_universe(conn: ConnWrapper, symbol_filter: str | None, limit: int) -> list[str]:
    if symbol_filter:
        return [symbol_filter.upper()]
    rows = conn.execute("""
        SELECT symbol FROM nse_stocks WHERE status = 'ACTIVE' AND market_cap IS NOT NULL
        ORDER BY market_cap DESC LIMIT ?
    """, (limit,)).fetchall()
    return [r["symbol"] if hasattr(r, "keys") else r[0] for r in rows]


def fetch_and_store_one(session: requests.Session, conn: ConnWrapper, symbol: str,
                         fetched_date: str) -> bool:
    ttm = fetch_ttm(session, symbol)
    growth = fetch_growth_metrics(session, symbol)
    dcf = fetch_dcf(session, symbol)
    fmp = fetch_fmp_ratios(session, symbol)
    row = parse_row(symbol, fetched_date, ttm, fmp, growth, dcf)
    return store_row(conn, row) > 0


def run(symbol_filter: str | None = None, limit: int = 300) -> dict:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    result = {"attempted": 0, "stored": 0}
    try:
        ensure_schema(conn)
        universe = _load_universe(conn, symbol_filter, limit)
        fetched_date = logical_trading_date()
        _log(f"fetching fundamentals for {len(universe)} symbols (as-of {fetched_date})...")
        for symbol in universe:
            result["attempted"] += 1
            try:
                if fetch_and_store_one(session, conn, symbol, fetched_date):
                    result["stored"] += 1
            except Exception as e:
                _log(f"{symbol}: failed ({e})")
            time.sleep(RATE_LIMIT_SEC)
        _log(f"done: {result['stored']}/{result['attempted']} symbols stored")
    finally:
        conn.close()
    return result


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--symbol", default=None)
    ap.add_argument("--limit", type=int, default=300)
    args = ap.parse_args()
    result = run(symbol_filter=args.symbol, limit=args.limit)
    return 0 if result["stored"] > 0 else 1


if __name__ == "__main__":
    sys.exit(main())
