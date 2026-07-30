"""
nse_ipo_calendar_fetcher.py
============================
Fetches NSE's own primary-market IPO calendar (current/upcoming/past issues) via the
`nse` (NseIndiaApi) package -- live-verified 2026-07-30 to be more reliable than the
`nsepython` package (several of its functions have real bugs: undefined `logger`,
KeyError on 'data', 404s on report endpoints tested live). This is genuinely new data:
no existing fetcher in this codebase covers the IPO calendar (confirmed via a full grep
sweep of src/server/*.py before building this).

Writes to nse_ipo_calendar. Two of NSE's three list endpoints (current/upcoming) overlap
heavily -- the same IPO commonly appears in both while its bidding window is open -- so
all three are normalized into one row shape and upserted per (symbol, phase); a consumer
wanting "what's open right now" should filter phase='current', not assume exclusivity
between phases.

Run:
  python nse_ipo_calendar_fetcher.py
"""

from datetime import datetime

from nse import NSE

from db_compat import execute, executemany, connect

PHASES = ("current", "upcoming", "past")


def ensure_schema(con=None) -> None:
    own = con is None
    con = con or connect()
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS nse_ipo_calendar (
            symbol TEXT NOT NULL,
            phase TEXT NOT NULL,
            company_name TEXT,
            issue_start_date TEXT,
            issue_end_date TEXT,
            price_range TEXT,
            issue_size TEXT,
            series TEXT,
            status TEXT,
            subscription_times REAL,
            listing_date TEXT,
            fetched_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, phase)
        )
    """)
    if own:
        con.commit()
        con.close()


def _sf(v):
    try:
        return float(v) if v not in (None, "", "-") else None
    except (TypeError, ValueError):
        return None


def _normalize(record: dict, phase: str) -> tuple | None:
    symbol = record.get("symbol")
    if not symbol:
        return None
    company = record.get("companyName") or record.get("company")
    start = record.get("issueStartDate") or record.get("ipoStartDate")
    end = record.get("issueEndDate") or record.get("ipoEndDate")
    price = record.get("issuePrice") or record.get("priceRange")
    return (
        symbol.upper(), phase, company, start, end, price,
        record.get("issueSize"), record.get("series") or record.get("securityType"),
        record.get("status"), _sf(record.get("noOfTime")), record.get("listingDate"),
    )


def fetch_all() -> dict:
    """Returns {phase: [raw records]} -- kept separate from parsing so a live_datasource
    test can assert on the real NSE response shape directly."""
    out = {}
    with NSE(download_folder=".") as nse:
        out["current"] = nse.listCurrentIPO() or []
        out["upcoming"] = nse.listUpcomingIPO() or []
        out["past"] = nse.listPastIPO() or []
    return out


def save(by_phase: dict) -> int:
    rows = []
    for phase, records in by_phase.items():
        for record in records:
            row = _normalize(record, phase)
            if row:
                rows.append(row)
    if not rows:
        return 0
    executemany("""
        INSERT INTO nse_ipo_calendar
            (symbol, phase, company_name, issue_start_date, issue_end_date, price_range,
             issue_size, series, status, subscription_times, listing_date)
        VALUES (?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT (symbol, phase) DO UPDATE SET
            company_name=excluded.company_name, issue_start_date=excluded.issue_start_date,
            issue_end_date=excluded.issue_end_date, price_range=excluded.price_range,
            issue_size=excluded.issue_size, series=excluded.series, status=excluded.status,
            subscription_times=excluded.subscription_times, listing_date=excluded.listing_date,
            fetched_at=CURRENT_TIMESTAMP
    """, rows)
    return len(rows)


def run() -> int:
    ensure_schema()
    by_phase = fetch_all()
    n = save(by_phase)
    print(f"[nse_ipo] {len(by_phase.get('current', []))} current, "
          f"{len(by_phase.get('upcoming', []))} upcoming, "
          f"{len(by_phase.get('past', []))} past -- {n} rows upserted")
    return n


if __name__ == "__main__":
    run()
