#!/usr/bin/env python3
"""
investsights_corporate_actions_fetcher.py

Market-wide corporate-actions calendar, sourced from real NSE regulatory filings via
InvestSights -- the completeness cross-check for `mc_corporate_actions_fetcher.py`'s per-stock
MoneyControl ledger, not a replacement for it.

WHY THIS EXISTS
---------------
    https://investsights.in/api/v2/market/corporate-actions?days_back=45&days_ahead=180

Live-verified 2026-08-07: `{"success":true,"source":"nse_filings", ...,"actions":[...]}`, one
call, 41 rows in the default window, each with `source_url` pointing at a real
`nsearchives.nseindia.com/corporate/*.pdf` filing -- this is NSE's own regulatory-disclosure
record, not a third party's derived guess. MC's per-stock endpoint is comprehensive for a stock
once you know to ask it, but there's no way to know from MC alone whether an action was missed
for a stock whose `mcsymbol` failed to resolve, or whose section happened to 204 that day. This
fetcher answers a different question -- "what did the exchange itself say happened market-wide"
-- independent of MC's per-stock resolution success.

FIELD SHAPE (verified live, no explicit id -- `source_url` is the natural stable key, since it's
a URL to one specific filing PDF and therefore already globally unique by construction)
------------------------------------------------------------------------------------------------
    symbol, company_name, dividend_per_share, record_date, ex_date, filing_date, headline,
    category ("board_meeting|dividend|results" -- a pipe-joined multi-label string, not an enum),
    source_url, upcoming (bool)

`ex_date` is frequently null even when `record_date` is populated (live-confirmed on the
TATAPOWER sample row) -- NSE filings disclose the record date well before the exchange itself
fixes an ex-date, so this is a normal, not-missing state, not a parse failure.

Symbol resolution: this endpoint already returns NSE tickers directly (confirmed: "TATAPOWER",
"CINEVISTA" -- real symbols, not InvestSights' own investor-tracking endpoint's BSE-numeric-code
quirk). Still filtered against `nse_stocks` before storing, matching this codebase's standing
"never trust an external symbol without checking it against the real universe" rule -- unlike
the investor-activity fetcher this isn't expected to drop much, since the source already claims
to be NSE-symbol-keyed.

Run:
  python investsights_corporate_actions_fetcher.py
  python investsights_corporate_actions_fetcher.py --days-back 90 --days-ahead 180
"""
import argparse
import sys

import requests

from db_compat import connect, ConnWrapper, query_all
from fetch_utils import retry_get

ACTIONS_URL = "https://investsights.in/api/v2/market/corporate-actions"
HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}


def _log(m):
    print(f"[InvestSightsCorpActions] {m}", flush=True)


def fetch_filed_actions(session: requests.Session, days_back: int = 45, days_ahead: int = 180) -> list:
    """One market-wide call. The ONLY fetch path -- tests call this."""
    resp = retry_get(session, ACTIONS_URL,
                      params={"days_back": days_back, "days_ahead": days_ahead}, timeout=30)
    payload = resp.json()
    if not isinstance(payload, dict) or not payload.get("success"):
        raise ValueError(f"unexpected envelope: {str(payload)[:200]}")
    return payload.get("actions") or []


def _num(v):
    try:
        f = float(v)
    except (TypeError, ValueError):
        return None
    return None if f != f else f


def parse_action(raw: dict, universe: set) -> dict | None:
    """One filed-action row -> one nse_filed_corporate_actions row, or None if not usable."""
    symbol = (raw.get("symbol") or "").strip().upper()
    if not symbol or symbol not in universe:
        return None
    source_url = (raw.get("source_url") or "").strip()
    if not source_url:
        return None  # the only stable dedup key this feed offers -- unusable without it
    return {
        "source_url": source_url,
        "symbol": symbol,
        "company_name": raw.get("company_name"),
        "category": raw.get("category"),
        "headline": raw.get("headline"),
        "dividend_per_share": _num(raw.get("dividend_per_share")),
        "record_date": (raw.get("record_date") or None),
        "ex_date": (raw.get("ex_date") or None),
        "filing_date": (raw.get("filing_date") or None),
        "upcoming": 1 if raw.get("upcoming") else 0,
    }


COLS = ["source_url", "symbol", "company_name", "category", "headline",
        "dividend_per_share", "record_date", "ex_date", "filing_date", "upcoming"]


def ensure_schema(conn: ConnWrapper) -> None:
    conn.execute("""
        CREATE TABLE IF NOT EXISTS nse_filed_corporate_actions (
            source_url TEXT PRIMARY KEY, symbol TEXT NOT NULL, company_name TEXT,
            category TEXT, headline TEXT, dividend_per_share REAL,
            record_date TEXT, ex_date TEXT, filing_date TEXT, upcoming INTEGER,
            source TEXT DEFAULT 'investsights_nse_filings',
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nfca_symbol ON nse_filed_corporate_actions (symbol)")
    conn.execute("CREATE INDEX IF NOT EXISTS idx_nfca_filing_date ON nse_filed_corporate_actions (filing_date)")
    conn.commit()


def store(conn: ConnWrapper, rows: list[dict]) -> int:
    if not rows:
        return 0
    ph = ",".join(["?"] * len(COLS))
    updates = ", ".join(f"{c}=excluded.{c}" for c in COLS[1:])
    sql = (f"INSERT INTO nse_filed_corporate_actions ({', '.join(COLS)}) VALUES ({ph}) "
           f"ON CONFLICT (source_url) DO UPDATE SET {updates}")
    n = 0
    for r in rows:
        conn.execute(sql, tuple(r[c] for c in COLS))
        n += 1
    conn.commit()
    return n


def load_nse_universe() -> set:
    rows = query_all("SELECT symbol FROM nse_stocks")
    return {(r["symbol"] or "").upper() for r in rows if r.get("symbol")}


def run(days_back: int = 45, days_ahead: int = 180) -> int:
    session = requests.Session()
    session.headers.update(HEADERS)
    conn = connect()
    try:
        ensure_schema(conn)
        universe = load_nse_universe()
        actions = fetch_filed_actions(session, days_back=days_back, days_ahead=days_ahead)
        _log(f"{len(actions)} filed actions found in the window")
        rows = [r for r in (parse_action(a, universe) for a in actions) if r is not None]
        stored = store(conn, rows)
        _log(f"stored {stored} / {len(actions)} (rest dropped: unresolvable symbol or no source_url)")
    finally:
        try:
            conn.close()
        except Exception:
            pass
    # An empty actions list (not "zero stored") is the real failure signal -- the endpoint
    # returning some rows that then all fail to resolve is a universe-coverage question, not
    # an outage.
    return 0 if actions else 1


def main():
    ap = argparse.ArgumentParser(description="InvestSights NSE-filed corporate actions calendar")
    ap.add_argument("--days-back", type=int, default=45)
    ap.add_argument("--days-ahead", type=int, default=180)
    args = ap.parse_args()
    sys.exit(run(days_back=args.days_back, days_ahead=args.days_ahead))


if __name__ == "__main__":
    main()