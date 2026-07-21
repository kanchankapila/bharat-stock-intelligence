"""
Credit Rating Event Fetcher
============================
Fetches CRISIL/CARE/ICRA/India Ratings credit rating change announcements from NSE's
corporate-credit-rating API and writes high-conviction upgrade/downgrade signals to
technical_signals.

Rating upgrades predict 3-6 month positive drift; downgrades predict negative drift.

Run:  python credit_rating_fetcher.py
      python credit_rating_fetcher.py --days 90
"""

import argparse
import datetime

import requests
import pandas as pd

from db_compat import connect, read_df, executemany, safe_alter, execute

# ---------------------------------------------------------------------------
# NSE API
# ---------------------------------------------------------------------------
# BSE's Corpfiling API (the previous source) started returning an HTML bot-check page
# instead of JSON. NSE's corporate-credit-rating feed gives the same information with a
# cleaner structure — RatingAction/NameOfCRAgency/ISIN/Symbol are already structured
# fields, no more free-text headline parsing needed — and supports real date-range
# queries (from_date/to_date, DD-MM-YYYY, verified live against a 6-month window).
NSE_CREDIT_RATING_URL = (
    "https://www.nseindia.com/api/corporate-credit-rating"
    "?from_date={from_date}&to_date={to_date}"
)
NSE_HOME_URL = "https://www.nseindia.com/"

NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
    "Accept-Language": "en-US,en;q=0.9",
    "Referer": "https://www.nseindia.com/",
}

# NSE's own RatingAction values map straight onto our 4-bucket scheme.
_ACTION_MAP = {
    "upgrade": "UPGRADE",
    "downgrade": "DOWNGRADE",
    "reaffirm": "REAFFIRM",
}


def classify_rating_action(action: str) -> str:
    """Returns 'UPGRADE', 'DOWNGRADE', 'REAFFIRM', or 'UNKNOWN' from NSE's RatingAction field."""
    return _ACTION_MAP.get((action or "").strip().lower(), "UNKNOWN")


# ---------------------------------------------------------------------------
# Schema helpers
# ---------------------------------------------------------------------------
def ensure_credit_rating_table(conn) -> None:
    execute("""
        CREATE TABLE IF NOT EXISTS credit_rating_events (
            bse_code          TEXT,
            symbol            TEXT,
            isin              TEXT,
            announcement_date TEXT NOT NULL,
            rating_agency     TEXT,
            action            TEXT,
            instrument_type   TEXT,
            headline          TEXT,
            fetched_at        TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (bse_code, announcement_date, rating_agency)
        )
    """)
    # Note: `bse_code` now holds NSE's per-filing AppID (source switched from BSE to NSE;
    # column kept as-is to avoid a schema migration for a purely internal uniqueness key).


def ensure_technical_signals_columns(conn) -> None:
    """Add credit-rating feature columns to technical_signals if absent."""
    new_cols = [
        ("rating_upgrade_180d",   "INTEGER DEFAULT 0"),
        ("rating_downgrade_180d", "INTEGER DEFAULT 0"),
        ("days_since_upgrade",    "INTEGER"),
    ]
    for col, definition in new_cols:
        safe_alter(None, f"ALTER TABLE technical_signals ADD COLUMN {col} {definition}")


# ---------------------------------------------------------------------------
# NSE fetch
# ---------------------------------------------------------------------------
def fetch_nse_rating_announcements(from_date: str, to_date: str) -> list[dict]:
    """
    Fetch credit-rating events from NSE's corporate-credit-rating API.
    from_date / to_date format: 'DD-MM-YYYY'
    Returns list of raw event dicts.
    """
    url = NSE_CREDIT_RATING_URL.format(from_date=from_date, to_date=to_date)
    session = requests.Session()
    session.headers.update(NSE_HEADERS)

    # Prime the NSE session cookie (same pattern used by other NSE-sourced fetchers).
    try:
        session.get(NSE_HOME_URL, timeout=10)
    except Exception as e:
        print(f"[CreditRating] NSE session prime warning: {e}")

    try:
        resp = session.get(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[CreditRating] NSE API error: {e}")
        return []

    return data if isinstance(data, list) else []


# ---------------------------------------------------------------------------
# Symbol bridge: ISIN → NSE symbol (fallback for events where NSE's own Symbol is blank)
# ---------------------------------------------------------------------------
def build_bse_to_nse_map(conn) -> dict[str, dict]:
    """
    Build a map of isin -> {symbol, isin} using nse_stocks table, used as a fallback
    when NSE's own event Symbol field is missing/"NOTLISTED" (debt-only issuers).
    """
    mapping: dict[str, dict] = {}

    try:
        df = read_df(
            "SELECT DISTINCT symbol, isin FROM nse_stocks WHERE isin IS NOT NULL"
        )
        if not df.empty:
            for _, row in df.iterrows():
                isin = str(row.get("isin", "")).strip()
                if isin:
                    mapping[isin] = {
                        "symbol": row.get("symbol", ""),
                        "isin":   isin,
                    }
            print(f"[CreditRating] Loaded {len(mapping)} ISIN->NSE mappings from nse_stocks (fallback)")
    except Exception as e:
        print(f"[CreditRating] nse_stocks isin fallback warning: {e}")

    return mapping


# ---------------------------------------------------------------------------
# Parse announcements
# ---------------------------------------------------------------------------
def parse_announcements(rows: list[dict], bse_nse_map: dict[str, dict]) -> list[dict]:
    """
    Convert raw NSE corporate-credit-rating rows into structured credit_rating_events
    records. NSE already gives structured fields (RatingAction/NameOfCRAgency/ISIN/
    Symbol), so no more free-text headline parsing is needed.
    """
    events = []
    for row in rows:
        app_id = str(row.get("AppID") or "").strip()
        if not app_id:
            continue

        ann_date = str(row.get("DateofCR") or "").strip()
        try:
            ann_date = datetime.datetime.strptime(ann_date, "%d-%m-%Y").strftime("%Y-%m-%d")
        except ValueError:
            continue

        action = classify_rating_action(row.get("RatingAction"))
        agency = (row.get("NameOfCRAgency") or "").strip()

        isin   = str(row.get("ISIN") or "").strip()
        symbol = str(row.get("Symbol") or "").strip()
        # NSE uses several different sentinel values for "no listed equity symbol"
        # (verified live: '', 'NA', 'NOT LISTED', 'NOTLISTED', 'NOT APPLICABLE') —
        # a single exact-match check misses most of them.
        if not symbol or symbol.upper().replace(" ", "") in ("NA", "NOTLISTED", "NOTAPPLICABLE"):
            resolved = bse_nse_map.get(isin)
            symbol = resolved.get("symbol", "") if resolved else ""

        headline = f"{row.get('CompanyName', '')} — {agency} {row.get('CreditRating', '')} ({row.get('RatingAction', '')})".strip()

        events.append({
            "bse_code":         app_id,
            "symbol":           symbol,
            "isin":             isin,
            "announcement_date": ann_date,
            "rating_agency":    agency,
            "action":           action,
            "instrument_type":  "",
            "headline":         headline,
        })

    return events


# ---------------------------------------------------------------------------
# Persist events
# ---------------------------------------------------------------------------
def upsert_events(conn, events: list[dict]) -> None:
    if not events:
        return

    # A single ?-placeholder SQL works for both backends via db_compat's translate() —
    # ON CONFLICT/excluded is supported natively by both SQLite (3.24+) and Postgres, so
    # no per-backend branch (and no raw %s, which db_compat's translator doesn't convert
    # and Postgres rejects) is needed here.
    sql = """
        INSERT INTO credit_rating_events
            (bse_code, symbol, isin, announcement_date, rating_agency,
             action, instrument_type, headline)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT (bse_code, announcement_date, rating_agency) DO UPDATE SET
            symbol          = excluded.symbol,
            isin            = excluded.isin,
            action          = excluded.action,
            instrument_type = excluded.instrument_type,
            headline        = excluded.headline
    """

    params = [
        (
            e["bse_code"], e["symbol"], e["isin"], e["announcement_date"],
            e["rating_agency"], e["action"], e["instrument_type"], e["headline"],
        )
        for e in events
    ]
    executemany(sql, params)


# ---------------------------------------------------------------------------
# Update technical_signals
# ---------------------------------------------------------------------------
def update_technical_signals(conn, lookback_days: int = 180) -> int:
    """
    For each symbol with events in the last `lookback_days`, compute:
      - rating_upgrade_180d   (1/0)
      - rating_downgrade_180d (1/0)
      - days_since_upgrade    (int or NULL)
    and write to the most-recent technical_signals row per symbol.
    Returns count of updated symbols.
    """
    cutoff = (datetime.date.today() - datetime.timedelta(days=lookback_days)).isoformat()

    df = read_df(f"""
        SELECT symbol, action, announcement_date
        FROM credit_rating_events
        WHERE symbol != ''
          AND announcement_date >= '{cutoff}'
    """)

    if df.empty:
        return 0

    df["announcement_date"] = pd.to_datetime(df["announcement_date"], errors="coerce")
    today = pd.Timestamp.today().normalize()

    updates = []
    for symbol, grp in df.groupby("symbol"):
        upgrades   = grp[grp["action"] == "UPGRADE"]
        downgrades = grp[grp["action"] == "DOWNGRADE"]

        has_upgrade   = int(not upgrades.empty)
        has_downgrade = int(not downgrades.empty)

        days_since_upgrade = None
        if has_upgrade:
            last_upg = upgrades["announcement_date"].max()
            if pd.notna(last_upg):
                days_since_upgrade = (today - last_upg).days

        updates.append((has_upgrade, has_downgrade, days_since_upgrade, symbol))

    if not updates:
        return 0

    # date = ? guard (2026-07-19) instead of MAX(date) -- see bse_event_classifier.py's
    # run_daily docstring for why matching the latest row isn't the same as matching today.
    # Single ?-placeholder SQL for both backends — see comment in upsert_events().
    sql = """
        UPDATE technical_signals
        SET rating_upgrade_180d   = ?,
            rating_downgrade_180d = ?,
            days_since_upgrade    = ?
        WHERE symbol = ? AND date = ?
    """
    today_str = today.strftime("%Y-%m-%d")
    params = [(u[0], u[1], u[2], u[3], today_str) for u in updates]

    executemany(sql, params)
    return len(updates)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Fetch NSE credit rating events")
    parser.add_argument("--days", type=int, default=180,
                        help="Lookback window in days (default: 180)")
    args = parser.parse_args()

    conn = connect()
    ensure_credit_rating_table(conn)
    ensure_technical_signals_columns(conn)

    # Build ISIN→NSE symbol fallback map
    bse_nse_map = build_bse_to_nse_map(conn)

    # Date range for NSE API (DD-MM-YYYY format)
    today     = datetime.date.today()
    from_dt   = today - datetime.timedelta(days=args.days)
    to_date   = today.strftime("%d-%m-%Y")
    from_date = from_dt.strftime("%d-%m-%Y")

    print(f"[CreditRating] Fetching NSE rating announcements {from_date} -> {to_date} ...")
    raw_rows = fetch_nse_rating_announcements(from_date, to_date)
    print(f"[CreditRating] Raw announcements received: {len(raw_rows)}")

    events = parse_announcements(raw_rows, bse_nse_map)

    # Tally actions
    action_counts = {"UPGRADE": 0, "DOWNGRADE": 0, "REAFFIRM": 0, "UNKNOWN": 0}
    for e in events:
        action_counts[e["action"]] = action_counts.get(e["action"], 0) + 1

    upsert_events(conn, events)

    updated = update_technical_signals(conn, lookback_days=args.days)

    conn.close()

    print(
        f"[CreditRating] Fetched {len(events)} rating events ({args.days}d). "
        f"Upgrades: {action_counts['UPGRADE']}, "
        f"Downgrades: {action_counts['DOWNGRADE']}, "
        f"Reaffirms: {action_counts['REAFFIRM']}. "
        f"{updated} stocks updated in technical_signals."
    )


if __name__ == "__main__":
    main()
