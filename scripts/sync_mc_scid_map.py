#!/usr/bin/env python3
"""
MC scid -> NSE symbol map backfill
==================================

stock_earnings_dates is keyed by MoneyControl's opaque scid ('RI', 'MDL02', ...).
The feature pipeline resolves scid -> NSE symbol through nse_stocks.mcsymbol, but
companies that listed recently (IPOs, SME names) are missing from both sides: the
feed learns their scid within days of their first result, while nse_stocks and
stocklist.json only learn them at the next universe refresh. Measured 2026-09-13:
1,944 of 3,694 feed scids resolved; the 1,750 unresolved are mostly recent
listings, and scripts/stocklist.json fills NONE of them (it is older and smaller
than nse_stocks, not newer).

This script closes the gap from the authoritative source: MoneyControl's own
autosuggestion API. For every unresolved feed scid it queries by stock_name and
accepts ONLY the entry whose sc_id equals the feed's scid (exact -- never a name
fuzzy-match, never the URL code: Shiprocket's price-page code is SL26 while its
earnings scid is SL25). The NSE symbol is extracted from the display payload
(ISIN, SYMBOL, scrip code) and persisted into mc_scid_map, which
feature_engineering._merge_earnings_clock consults as the fallback after
nse_stocks.

Phase 2 also backfills nse_stocks.mcsymbol rows that are NULL (same lookup, keyed
by symbol), which un-stalls the MC pricefeed fetcher for those names.

Resumable: scids already present in mc_scid_map are skipped. Safe to re-run on a
schedule (weekly is plenty -- it only has work when new listings appear).

Run:
  python scripts/sync_mc_scid_map.py                 # full backfill
  python scripts/sync_mc_scid_map.py --limit 100     # capped run
  python scripts/sync_mc_scid_map.py --skip-nse      # skip the nse_stocks phase
"""

import argparse
import html
import json
import os
import re
import sys
import time

import requests

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)),
                                "..", "src", "server"))
from db_compat import connect  # noqa: E402

AUTOSUGGEST_URL = ("https://www.moneycontrol.com/mccode/common/autosuggestion_solr.php"
                   "?query={query}&type=1&format=json")
RATE_LIMIT_SEC = 0.4
HEADERS = {"User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64)"}

_ISIN_RE = re.compile(r"^IN[0-9A-Z]{10}$")
_SYMBOL_RE = re.compile(r"^[A-Z0-9&\-]{1,20}$")


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mc_scid_map (
            scid        TEXT PRIMARY KEY,
            symbol      TEXT NOT NULL,
            stock_name  TEXT,
            source      TEXT,
            resolved_at TEXT DEFAULT CURRENT_TIMESTAMP
        )
    """)
    con.commit()


def _first_json(text: str):
    """Autosuggestion concatenates two JSON arrays with no separator; parse the first."""
    start = min((p for p in (text.find("["), text.find("{")) if p != -1), default=-1)
    if start == -1:
        return None
    try:
        val, _ = json.JSONDecoder().raw_decode(text[start:])
        return val
    except json.JSONDecodeError:
        return None


def _lookup(query: str):
    """Autosuggestion lookup. Returns the raw entry list, or None on failure."""
    try:
        r = requests.get(AUTOSUGGEST_URL.format(query=query), headers=HEADERS, timeout=10)
        return _first_json(r.text)
    except Exception as e:
        print(f"  [http] {query!r}: {e}", file=sys.stderr)
        return None


def _symbol_from_payload(entry: dict) -> "str | None":
    """Extract the NSE symbol from pdt_dis_nm: 'Name&nbsp;<span>ISIN, SYMBOL, scrip</span>'."""
    dis = html.unescape(entry.get("pdt_dis_nm") or "")
    m = re.search(r"<span[^>]*>(.*?)</span>", dis, re.I | re.S)
    if not m:
        return None
    inner = re.sub(r"<[^>]+>", "", m.group(1))
    tokens = [t.strip().upper() for t in inner.split(",") if t.strip()]
    for tok in tokens:
        if _ISIN_RE.fullmatch(tok) or tok.isdigit():
            continue
        if _SYMBOL_RE.fullmatch(tok):
            return tok
    return None


def _resolve_scid(scid: str, stock_name: str) -> "str | None":
    """Autosuggestion by name; accept ONLY the entry whose sc_id == the feed's scid."""
    entries = _lookup(stock_name)
    time.sleep(RATE_LIMIT_SEC)
    if not entries:
        return None
    for entry in entries:
        if entry.get("sc_id") == scid:
            return _symbol_from_payload(entry)
    return None


def _resolve_symbol_to_scid(symbol: str) -> "str | None":
    """Autosuggestion by symbol; exact-symbol match, TS resolveMoneycontrolSymbol rules."""
    entries = _lookup(symbol)
    time.sleep(RATE_LIMIT_SEC)
    if not entries:
        return None
    up = symbol.upper()
    for entry in entries:
        dis = html.unescape(entry.get("pdt_dis_nm") or "").upper()
        if (f" {up}," in dis or f", {up}," in dis or f", {up}<" in dis) and entry.get("sc_id"):
            return entry["sc_id"]
    return None


def phase_scid_map(con, limit=None) -> None:
    """Resolve feed scids that neither nse_stocks nor mc_scid_map can place."""
    rows = con.execute("""
        SELECT DISTINCT e.scid, MAX(e.stock_name) AS stock_name
        FROM stock_earnings_dates e
        LEFT JOIN nse_stocks n ON n.mcsymbol = e.scid
        LEFT JOIN mc_scid_map m ON m.scid = e.scid
        WHERE n.symbol IS NULL AND m.scid IS NULL
        GROUP BY e.scid
        ORDER BY e.scid
    """).fetchall()

    def g(r, k):
        return r[k] if isinstance(r, dict) else r[0]

    pending = [(g(r, "scid"), g(r, "stock_name")) for r in rows]
    if limit:
        pending = pending[:limit]
    print(f"[scid-map] {len(pending)} scids to resolve")

    done = failed = 0
    cur = con.cursor()
    for scid, stock_name in pending:
        symbol = _resolve_scid(scid, stock_name or scid)
        if not symbol:
            failed += 1
            continue
        cur.execute(
            "INSERT INTO mc_scid_map (scid, symbol, stock_name, source) "
            "VALUES (?, ?, ?, 'autosuggest-name') "
            "ON CONFLICT (scid) DO NOTHING", (scid, symbol, stock_name))
        con.commit()
        done += 1
        if done % 50 == 0:
            print(f"[scid-map] {done} resolved ({failed} no-match)...")
    print(f"[scid-map] done: {done} resolved, {failed} unresolved "
          f"(no autosuggestion entry with sc_id == feed scid)")


def phase_nse_stocks(con) -> None:
    """Backfill nse_stocks.mcsymbol rows that are NULL (un-stalls the pricefeed fetcher)."""
    rows = con.execute(
        "SELECT symbol FROM nse_stocks WHERE mcsymbol IS NULL").fetchall()
    print(f"[nse_stocks] {len(rows)} rows with NULL mcsymbol")
    cur = con.cursor()
    fixed = 0
    for r in rows:
        symbol = r["symbol"] if isinstance(r, dict) else r[0]
        scid = _resolve_symbol_to_scid(symbol)
        if scid:
            cur.execute("UPDATE nse_stocks SET mcsymbol = ? WHERE symbol = ? "
                        "AND mcsymbol IS NULL", (scid, symbol))
            con.commit()
            fixed += 1
            print(f"[nse_stocks] {symbol} -> {scid}")
    print(f"[nse_stocks] backfilled {fixed}/{len(rows)}")


def report(con) -> None:
    total = con.execute(
        "SELECT COUNT(DISTINCT scid) FROM stock_earnings_dates").fetchone()
    total = total["count"] if isinstance(total, dict) else total[0]
    n = con.execute("SELECT COUNT(*) FROM mc_scid_map").fetchone()
    n = n["count"] if isinstance(n, dict) else n[0]
    resolved_ns = con.execute(
        "SELECT COUNT(DISTINCT e.scid) FROM stock_earnings_dates e "
        "JOIN nse_stocks ns ON ns.mcsymbol = e.scid").fetchone()
    resolved_ns = resolved_ns["count"] if isinstance(resolved_ns, dict) else resolved_ns[0]
    resolved_map = con.execute(
        "SELECT COUNT(DISTINCT e.scid) FROM stock_earnings_dates e "
        "JOIN mc_scid_map m ON m.scid = e.scid").fetchone()
    resolved_map = (resolved_map["count"] if isinstance(resolved_map, dict)
                    else resolved_map[0])
    print(f"[report] feed scids: {total}; resolved via nse_stocks: {resolved_ns}; "
          f"via mc_scid_map: {resolved_map}; combined coverage: "
          f"{min(total, resolved_ns + resolved_map)}/{total}")


def main():
    ap = argparse.ArgumentParser(description="MC scid -> NSE symbol map backfill")
    ap.add_argument("--limit", type=int, default=None,
                    help="Cap the number of scid lookups this run")
    ap.add_argument("--skip-nse", action="store_true",
                    help="Skip the nse_stocks NULL-mcsymbol phase")
    ap.add_argument("--report-only", action="store_true",
                    help="Print coverage and exit")
    args = ap.parse_args()

    con = connect()
    ensure_schema(con)
    if args.report_only:
        report(con)
        return
    phase_scid_map(con, args.limit)
    if not args.skip_nse:
        phase_nse_stocks(con)
    report(con)
    con.close()


if __name__ == "__main__":
    main()



