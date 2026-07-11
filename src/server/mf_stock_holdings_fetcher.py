#!/usr/bin/env python3
"""
MF Stock-Holdings Fetcher — per-stock mutual-fund ownership flow
=================================================================
Aggregates ET Markets' per-stock MF-holdings endpoint into an institutional-flow
signal: how many funds hold the stock and whether they are net accumulating or
trimming it month-over-month.

  Source: https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm
          ?pagesize=100&sortby=numberOfSharesHeld&companyid={cid}&callback=&pageno=1
  Per fund: numberOfSharesHeld, changeInNumberOfShares, percentageAssets, assetDate.
  Keyed by ET companyid (scripts/stocklist.json), the same id the ET_Stats fetchers use.

This is distinct from mf_holdings_fetcher.py (which pulls *per-fund* portfolios via
MFPortfolioHolding). Here the axis is the stock: net MF share-change is a well-known
accumulation/distribution signal, and fund-count is ownership breadth.

Writes:
  mf_stock_holdings  (symbol, as_of_date) — aggregates + fetched_at
  technical_signals  — mf_net_share_chg_pct, mf_fund_count
  (point-in-time stamped: MF portfolios for a month-end are disclosed ~2 weeks later,
   so the value is only written onto rows dated >= as_of_date + MF_DISCLOSURE_LAG_DAYS
   and NULLed on older rows — no look-ahead into ML training.)

Cadence: monthly (portfolio disclosures are monthly).

Run:
  python mf_stock_holdings_fetcher.py            # all stocks with a companyid
  python mf_stock_holdings_fetcher.py --symbol BEL
  python mf_stock_holdings_fetcher.py --limit 50
"""

import argparse
from datetime import date, datetime, timedelta

import requests

from db_compat import connect
from et_stats_client import HEADERS, load_companyid_map

MF_URL = ("https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm"
          "?pagesize=100&sortby=numberOfSharesHeld&companyid={cid}&marketcap=&callback=&pageno=1")

# MF portfolio for a month-end is published ~10-14 days into the next month; use 14 to stay
# safely on the late side so a disclosure never back-fills onto rows that predate it.
MF_DISCLOSURE_LAG_DAYS = 14


def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS mf_stock_holdings (
            symbol               TEXT NOT NULL,
            as_of_date           TEXT NOT NULL,
            num_funds            INTEGER,
            total_shares_held    REAL,
            net_change_shares    REAL,
            net_share_chg_pct    REAL,
            funds_adding         INTEGER,
            funds_trimming       INTEGER,
            fetched_at           TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, as_of_date)
        )
    """)
    cur.execute("CREATE INDEX IF NOT EXISTS idx_mfsh_sym ON mf_stock_holdings(symbol, as_of_date DESC)")
    con.commit()
    for ddl in [
        "ALTER TABLE technical_signals ADD COLUMN mf_net_share_chg_pct REAL",
        "ALTER TABLE technical_signals ADD COLUMN mf_fund_count        INTEGER",
    ]:
        try:
            cur.execute(ddl); con.commit()
        except Exception:
            con.rollback()


# ── Pure computation (unit-testable) ─────────────────────────────────────────────

def _num(v, default=None):
    try:
        return float(v)
    except (TypeError, ValueError):
        return default


def _as_of_date(rows: list[dict]) -> str | None:
    """Latest assetDate across the returned funds, normalised DD-MM-YYYY → YYYY-MM-DD."""
    best = None
    for r in rows:
        s = str(r.get("assetDate", "")).strip()
        try:
            d = datetime.strptime(s, "%d-%m-%Y").date()
        except ValueError:
            continue
        if best is None or d > best:
            best = d
    return best.isoformat() if best else None


def aggregate(searchresult: list[dict] | None, total_records) -> dict | None:
    """Fold the per-fund page into per-stock MF-flow aggregates. Returns None if unusable."""
    rows = searchresult or []
    if not rows:
        return None
    total_shares = sum(_num(r.get("numberOfSharesHeld"), 0) or 0 for r in rows)
    net_change = sum(_num(r.get("changeInNumberOfShares"), 0) or 0 for r in rows)
    funds_adding = sum(1 for r in rows if (_num(r.get("changeInNumberOfShares"), 0) or 0) > 0)
    funds_trimming = sum(1 for r in rows if (_num(r.get("changeInNumberOfShares"), 0) or 0) < 0)
    prior = total_shares - net_change
    net_pct = round(net_change / prior * 100, 4) if prior > 0 else None
    return {
        "as_of_date": _as_of_date(rows),
        "num_funds": int(_num(total_records, len(rows)) or len(rows)),
        "total_shares_held": round(total_shares, 2),
        "net_change_shares": round(net_change, 2),
        "net_share_chg_pct": net_pct,
        "funds_adding": funds_adding,
        "funds_trimming": funds_trimming,
    }


def _floor(as_of_date: str | None) -> str:
    try:
        d = date.fromisoformat(as_of_date) if as_of_date else None
    except ValueError:
        d = None
    return (d + timedelta(days=MF_DISCLOSURE_LAG_DAYS)).isoformat() if d else date.today().isoformat()


# ── Persist ──────────────────────────────────────────────────────────────────────

def upsert(symbol: str, agg: dict, con) -> None:
    con.cursor().execute("""
        INSERT INTO mf_stock_holdings
            (symbol, as_of_date, num_funds, total_shares_held, net_change_shares,
             net_share_chg_pct, funds_adding, funds_trimming)
        VALUES (?,?,?,?,?,?,?,?)
        ON CONFLICT(symbol, as_of_date) DO UPDATE SET
            num_funds = excluded.num_funds, total_shares_held = excluded.total_shares_held,
            net_change_shares = excluded.net_change_shares, net_share_chg_pct = excluded.net_share_chg_pct,
            funds_adding = excluded.funds_adding, funds_trimming = excluded.funds_trimming,
            fetched_at = CURRENT_TIMESTAMP
    """, (symbol, agg["as_of_date"], agg["num_funds"], agg["total_shares_held"],
          agg["net_change_shares"], agg["net_share_chg_pct"], agg["funds_adding"], agg["funds_trimming"]))
    con.commit()


def stamp_technical_signals(symbol: str, agg: dict, con) -> None:
    # Point-in-time: apply only to rows on/after the disclosure was public (date >= floor),
    # NULL on older rows — same anti-look-ahead discipline as the ET_Stats fetchers.
    floor = _floor(agg.get("as_of_date"))
    con.cursor().execute("""
        UPDATE technical_signals SET
            mf_net_share_chg_pct = CASE WHEN date >= ? THEN COALESCE(?, mf_net_share_chg_pct) ELSE NULL END,
            mf_fund_count        = CASE WHEN date >= ? THEN COALESCE(?, mf_fund_count)        ELSE NULL END
        WHERE symbol = ?
    """, (floor, agg.get("net_share_chg_pct"), floor, agg.get("num_funds"), symbol))
    con.commit()


# ── Per-stock ──────────────────────────────────────────────────────────────────────

def process_stock(symbol: str, company_id: str, session: requests.Session, con) -> dict | None:
    try:
        r = session.get(MF_URL.format(cid=company_id), timeout=15)
        if r.status_code != 200:
            return None
        data = r.json()
    except Exception:
        return None
    agg = aggregate(data.get("searchresult"), (data.get("pagesummary") or {}).get("totalRecords"))
    if not agg or not agg.get("as_of_date"):
        return None
    upsert(symbol, agg, con)
    stamp_technical_signals(symbol, agg, con)
    return agg


def load_stocks(symbol_filter, limit):
    rows = sorted(load_companyid_map().items())
    if symbol_filter:
        rows = [(s, c) for s, c in rows if s == symbol_filter.upper()]
    if limit:
        rows = rows[:limit]
    return rows


def main() -> None:
    parser = argparse.ArgumentParser(description="Per-stock mutual-fund ownership flow")
    parser.add_argument("--symbol", default=None)
    parser.add_argument("--limit", type=int, default=None)
    args = parser.parse_args()

    con = connect()
    ensure_schema(con)
    stocks = load_stocks(args.symbol, args.limit)
    if not stocks:
        print("[MFHoldings] No stocks with a companyid found.")
        con.close(); return

    print(f"[MFHoldings] Processing {len(stocks)} stocks — per-stock MF ownership flow…")
    session = requests.Session(); session.headers.update(HEADERS)
    ok = accumulating = 0
    for i, (symbol, cid) in enumerate(stocks, 1):
        try:
            agg = process_stock(symbol, cid, session, con)
            if not agg:
                continue
            ok += 1
            if (agg.get("net_share_chg_pct") or 0) > 0:
                accumulating += 1
            chg = agg.get("net_share_chg_pct")
            print(f"  [{i}/{len(stocks)}] {symbol}: {agg['num_funds']} funds | "
                  f"net {chg:+.2f}%" if chg is not None else f"  [{i}/{len(stocks)}] {symbol}: {agg['num_funds']} funds")
        except Exception as e:
            print(f"  [{i}/{len(stocks)}] {symbol}: ERROR — {e}")
    print(f"[MFHoldings] Done. {ok} stocks; {accumulating} with net MF accumulation.")
    con.close()


if __name__ == "__main__":
    main()
