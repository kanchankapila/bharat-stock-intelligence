#!/usr/bin/env python3
"""
Ranked institutional buy/sell deal activity, from MoneyControl's deals-insight feed.

WHY THIS EXISTS
---------------
`block_deal_fetcher.py`/`tickertape_deals_fetcher.py` already capture individual bulk/block
transactions, but neither is RANKED by counterparty conviction -- they're a flat list of every
disclosed deal. MoneyControl's `deals/insight` endpoint (surfaced by the 2026-08-03 urls.txt
field analysis, `docs/url_explorer/DATA_CATEGORIZATION_AND_USAGE.md`) is a pre-aggregated,
pre-ranked "who is buying/selling the most, this week" feed keyed by `boughtBy` (the
counterparty name, used for both buy and sell rows despite the field name) -- richer
counterparty/sector/value detail than the raw NSE bulk/block pull, and already sorted by size.

    https://api.moneycontrol.com/mcapi/v1/deals/insight?start=0&limit=N&value=value&range=1W&action={buy,sell}&dealsType=topInvestor

Live-verified 2026-08-06: both `action=buy` and `action=sell` return real, current (deal_date
within the last few days), ticker-keyed rows.

ENDPOINT SHAPE -- verified live, do not "fix" these
----------------------------------------------------
* This is a WEEKLY-AGGREGATE feed, not a single-transaction feed (`range=1W` in the URL
  controls the aggregation window). `dealsCount` on a row is the number of deals rolled into
  it over that window, and `dealValue` is the AGGREGATE total across all of them -- it does
  NOT equal `quantity * deal_price` (those two fields describe one representative deal within
  the aggregate, not the whole aggregate). Do not derive `deal_value_cr` from quantity*price;
  use the API's own `dealValue` field, which arrives already in crore.
* `dealsType` also accepts `topDeal`/`topInsider` -- only `topInvestor` is fetched here
  (matching the one `dealsType` already promoted into `endpoint_registry.py`'s archive).
  `topInsider` overlaps `tickertape_deals_fetcher.py`'s own insider rows; `topDeal` overlaps
  this same feed's own default view. Revisit only if a gap is demonstrated.
* `boughtBy` is populated on BOTH buy and sell rows -- it means "counterparty", not literally
  "the buyer". Stored as `counterparty` here rather than carrying the misleading upstream name
  forward.

AS-OF DISCIPLINE
-----------------
`deal_date` is the disclosure date (same convention as `tickertape_deals_fetcher.py` --
bulk/block-style deals are disclosed same-session, no publication-lag offset needed). Any
consumer must still join strictly as-of the NEXT session, same rule as that fetcher.

Run:
  python institutional_deals_fetcher.py
"""
import sys

from curl_cffi import requests as cffi_req

from db_compat import connect, ConnWrapper, query_all

API = "https://api.moneycontrol.com/mcapi/v1/deals/insight"
SOURCE = "moneycontrol"
ACTIONS = ("buy", "sell")

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Origin": "https://www.moneycontrol.com",
    "Referer": "https://www.moneycontrol.com/",
    "Accept": "application/json",
}


def _log(m):
    print(f"[InstDeals] {m}", flush=True)


def fetch_deals(action: str, limit: int = 30) -> list:
    """One action side (buy/sell) of the topInvestor deals feed. The ONLY fetch path -- tests
    call this."""
    params = {"start": 0, "limit": limit, "value": "value", "range": "1W",
              "action": action, "dealsType": "topInvestor"}
    r = cffi_req.get(API, params=params, headers=HEADERS, impersonate="chrome120", timeout=20)
    payload = r.json()
    if not isinstance(payload, dict) or payload.get("success") != 1:
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return ((payload.get("data") or {}).get("topInvestor")) or []


def parse_deal(action: str, raw: dict, universe: set) -> dict | None:
    """One API row -> one institutional_deal_signals row, or None if not usable."""
    symbol = (raw.get("symbol") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    deal_date = (raw.get("deal_date") or "")[:10]
    if not deal_date:
        return None
    ds_id = raw.get("ds_id")
    if ds_id is None:
        return None

    def num(k):
        try:
            f = float(raw.get(k))
        except (TypeError, ValueError):
            return None
        return None if f != f else f   # NaN -> None; a NaN passes every coverage check

    return {
        # Namespaced by provider + action so a same-day buy and sell row for the same deal id
        # (if MC ever reuses ds_id across sides) can never silently overwrite each other.
        "id": f"mc:{action}:{ds_id}",
        "symbol": symbol,
        "exchange": (raw.get("exchange") or "").strip() or None,
        "sector": (raw.get("sector") or "").strip() or None,
        "action": action,
        "deal_type": (raw.get("deal_type") or "").strip() or None,
        "deal_date": deal_date,
        "counterparty": (raw.get("boughtBy") or "").strip() or None,
        "quantity": num("quantity"),
        "deal_price": num("deal_price"),
        "deal_value_cr_1w": num("dealValue"),
        "deals_count_1w": int(num("dealsCount")) if num("dealsCount") is not None else None,
        "source": SOURCE,
    }


COLS = ["id", "symbol", "exchange", "sector", "action", "deal_type", "deal_date",
        "counterparty", "quantity", "deal_price", "deal_value_cr_1w", "deals_count_1w", "source"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS institutional_deal_signals (
            id TEXT PRIMARY KEY, symbol TEXT NOT NULL, exchange TEXT, sector TEXT,
            action TEXT NOT NULL, deal_type TEXT, deal_date TEXT NOT NULL,
            counterparty TEXT, quantity REAL, deal_price REAL,
            deal_value_cr_1w REAL, deals_count_1w INTEGER,
            source TEXT, fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.commit()


def store(conn: ConnWrapper, rows: list) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO institutional_deal_signals ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (id) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def load_nse_universe() -> set:
    rows = query_all("SELECT symbol FROM nse_stocks")
    return {(r["symbol"] or "").upper() for r in rows if r.get("symbol")}


def run(limit: int = 30) -> int:
    conn = connect()
    total = 0
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        for action in ACTIONS:
            try:
                raw_rows = fetch_deals(action, limit=limit)
            except Exception as e:
                _log(f"{action}: fetch failed ({e}), skipping")
                continue
            rows = [r for r in (parse_deal(action, d, universe) for d in raw_rows) if r is not None]
            n = store(conn, rows)
            total += n
            _log(f"{action}: {len(raw_rows)} seen, {n} stored")
    finally:
        conn.close()
    return total


def main() -> int:
    n = run()
    if n == 0:
        _log("nothing stored on either side")
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(main())