#!/usr/bin/env python3
"""NSE corporate announcements: every equity filing with its category and dissemination time (AF-20261120-01).

Replaces trendlyne_market_insight_fetcher.py (trendlyne.com/equity/api/market-insight/, refused with HTTP 405
every night since 2026-11-18). Trendlyne's labels (Order Win, Acquisition, Fundraise, MoU, JV, Capex, Open
Offer) are its reading of these same exchange filings; NSE's own category is kept in `category`
('Bagging/Receiving of orders/contracts', 'Acquisition', 'Allotment of Securities', ...).

Source, probed 2026-11-20 through the shared NSE session:
  https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=DD-MM-YYYY&to_date=DD-MM-YYYY
  -> a list (878 rows for 18-19 Nov 2026) with a unique `seq_id`, `symbol`, `sm_isin`, `desc` (category),
  `attchmntText` (the exchange's one-line summary), `attchmntFile`, `an_dt` and `exchdisstime`
  ('19-Nov-2026 23:50:06', IST). One request covers the whole window.

Rows are keyed on NSE's `seq_id` and dated by the exchange's dissemination time. Each run re-reads the last
--days-back days (default 3), so a night that misses the call is filled on the next run.

    python nse_corporate_announcements_fetcher.py
    python nse_corporate_announcements_fetcher.py --days-back 30      # backfill
"""
from __future__ import annotations

import argparse
import datetime as dt
import sys
from collections import Counter
from zoneinfo import ZoneInfo

from db_compat import connect, executemany_batched
from nse_filings_common import BudgetExhausted, NseBlocked, NseClient, NseFetchError

PREFIX = "[NSE-ANNOUNCEMENTS]"
URL = "https://www.nseindia.com/api/corporate-announcements?index=equities&from_date={f}&to_date={t}"
TABLE = "nse_corporate_announcements"
IST = ZoneInfo("Asia/Kolkata")
COLS = ("seq_id", "symbol", "isin", "company_name", "category", "summary", "attachment_url", "industry",
        "announced_at", "disseminated_at", "has_xbrl")


def ensure_schema(conn) -> None:
    conn.execute(f"""
        CREATE TABLE IF NOT EXISTS {TABLE} (
            seq_id TEXT PRIMARY KEY, symbol TEXT NOT NULL, isin TEXT, company_name TEXT, category TEXT,
            summary TEXT, attachment_url TEXT, industry TEXT, announced_at TIMESTAMPTZ,
            disseminated_at TIMESTAMPTZ NOT NULL, has_xbrl BOOLEAN,
            source TEXT NOT NULL DEFAULT 'nse_api', fetched_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )""")
    conn.execute(f"CREATE INDEX IF NOT EXISTS {TABLE}_symbol_time_idx ON {TABLE} (symbol, disseminated_at DESC)")
    conn.commit()


def _ist(v) -> dt.datetime | None:
    s = (v or "").strip()
    for fmt in ("%d-%b-%Y %H:%M:%S", "%Y-%m-%d %H:%M:%S"):
        try:
            return dt.datetime.strptime(s, fmt).replace(tzinfo=IST)
        except ValueError:
            continue
    return None


def parse(payload) -> list[dict]:
    rows = payload if isinstance(payload, list) else (payload or {}).get("data")
    if not isinstance(rows, list):
        raise NseFetchError(f"announcements: expected a list, got {type(payload).__name__}")
    out = []
    for r in rows:
        seq, symbol = str(r.get("seq_id") or "").strip(), (r.get("symbol") or "").strip().upper()
        disseminated = _ist(r.get("exchdisstime")) or _ist(r.get("an_dt")) or _ist(r.get("sort_date"))
        if not seq or not symbol or disseminated is None:
            raise NseFetchError(f"announcements: row without seq_id/symbol/time: {str(r)[:160]}")
        out.append({
            "seq_id": seq, "symbol": symbol, "isin": (r.get("sm_isin") or "").strip() or None,
            "company_name": r.get("sm_name"), "category": (r.get("desc") or "").strip() or None,
            "summary": (r.get("attchmntText") or "").strip() or None,
            "attachment_url": (r.get("attchmntFile") or "").strip() or None,
            "industry": (r.get("smIndustry") or "").strip() or None,
            "announced_at": _ist(r.get("an_dt")), "disseminated_at": disseminated,
            "has_xbrl": bool(r.get("hasXbrl")),
        })
    return out


def upsert(conn, rows: list[dict]) -> int:
    if not rows:
        return 0
    upd = ", ".join(f"{c} = EXCLUDED.{c}" for c in COLS if c != "seq_id")
    executemany_batched(conn, f"""
        INSERT INTO {TABLE} ({", ".join(COLS)}) VALUES ({", ".join("?" for _ in COLS)})
        ON CONFLICT (seq_id) DO UPDATE SET {upd}, fetched_at = now()""",
        [tuple(r[c] for c in COLS) for r in rows])
    conn.commit()
    return len(rows)


def main(argv=None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--days-back", type=int, default=3)
    ap.add_argument("--min-interval", type=float, default=1.5)
    args = ap.parse_args(argv)
    today = dt.datetime.now(IST).date()
    since = today - dt.timedelta(days=args.days_back)
    conn = connect()
    ensure_schema(conn)
    client = NseClient(4, args.min_interval, log_prefix=PREFIX)
    try:
        rows = parse(client.get_json(URL.format(f=since.strftime("%d-%m-%Y"), t=today.strftime("%d-%m-%Y"))))
        if not rows:
            raise NseFetchError(f"announcements: 0 rows for {since}..{today}; NSE publishes filings every day")
        written = upsert(conn, rows)
    except (BudgetExhausted, NseBlocked, NseFetchError) as exc:
        print(f"{PREFIX} stopped: {exc}", file=sys.stderr)
        return 2
    finally:
        conn.close()
    top = Counter(r["category"] for r in rows).most_common(5)
    print(f"{PREFIX} done {since}..{today}: {written} filings; top categories {top} "
          f"statuses={dict(Counter(client.status_counts))}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
