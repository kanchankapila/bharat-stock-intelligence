"""
Credit Rating Event Fetcher
============================
Fetches CRISIL/CARE/ICRA/India Ratings credit rating change announcements from BSE
corporate announcements API and writes high-conviction upgrade/downgrade signals to
technical_signals.

Rating upgrades predict 3-6 month positive drift; downgrades predict negative drift.

Run:  python credit_rating_fetcher.py
      python credit_rating_fetcher.py --days 90
"""

import argparse
import datetime
import re
import time

import requests
import pandas as pd

from db_compat import connect, use_postgres, read_df, executemany, safe_alter, execute

# ---------------------------------------------------------------------------
# BSE API
# ---------------------------------------------------------------------------
BSE_CORP_URL = (
    "https://api.bseindia.com/BseIndiaAPI/api/Corpfiling/w"
    "?scripcode=&flagtype=C&Category=Rating&subcategory="
    "&Fdate={from_date}&Tdate={to_date}&pageno=1&recordno=500"
)

BSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.bseindia.com",
    "Referer": "https://www.bseindia.com/",
}

# ---------------------------------------------------------------------------
# Rating classification
# ---------------------------------------------------------------------------
RATING_AGENCIES = ["CRISIL", "CARE", "ICRA", "India Ratings", "Brickwork", "SMERA"]
UPGRADE_WORDS   = ["upgrade", "revised upward", "enhanced", "improved"]
DOWNGRADE_WORDS = ["downgrade", "revised downward", "lowered", "reduced", "withdrawn"]
REAFFIRM_WORDS  = ["reaffirm", "maintain", "affirm", "unchanged", "stable"]


def classify_rating_action(headline: str) -> str:
    """Returns 'UPGRADE', 'DOWNGRADE', 'REAFFIRM', or 'UNKNOWN'."""
    h = headline.lower()
    if any(w in h for w in UPGRADE_WORDS):
        return "UPGRADE"
    if any(w in h for w in DOWNGRADE_WORDS):
        return "DOWNGRADE"
    if any(w in h for w in REAFFIRM_WORDS):
        return "REAFFIRM"
    return "UNKNOWN"


def extract_agency(headline: str) -> str | None:
    for agency in RATING_AGENCIES:
        if agency.lower() in headline.lower():
            return agency
    return None


def extract_instrument_type(headline: str) -> str | None:
    """Heuristic extraction of instrument type from headline."""
    patterns = [
        r"\b(NCD|Non[- ]Convertible Debenture)\b",
        r"\b(Bank Loan|Term Loan)\b",
        r"\b(Issuer Rating)\b",
        r"\b(Commercial Paper|CP)\b",
        r"\b(Fixed Deposit|FD)\b",
        r"\b(Subordinated Debt|Sub[- ]Debt)\b",
        r"\b(Preference Share)\b",
    ]
    for pat in patterns:
        m = re.search(pat, headline, re.IGNORECASE)
        if m:
            return m.group(0).strip()
    return None


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
# BSE fetch
# ---------------------------------------------------------------------------
def fetch_bse_rating_announcements(from_date: str, to_date: str) -> list[dict]:
    """
    Fetch rating-category corporate announcements from BSE.
    from_date / to_date format: 'DD/MM/YYYY'
    Returns list of raw announcement dicts.
    """
    url = BSE_CORP_URL.format(from_date=from_date, to_date=to_date)
    session = requests.Session()
    session.headers.update(BSE_HEADERS)

    # Prime the BSE cookie
    try:
        session.get("https://www.bseindia.com", timeout=10)
        time.sleep(1)
    except Exception as e:
        print(f"[CreditRating] BSE session prime warning: {e}")

    try:
        resp = session.get(url, timeout=20)
        resp.raise_for_status()
        data = resp.json()
    except Exception as e:
        print(f"[CreditRating] BSE API error: {e}")
        return []

    # BSE wraps results in Table key or directly as a list
    if isinstance(data, dict):
        rows = data.get("Table", data.get("data", []))
    elif isinstance(data, list):
        rows = data
    else:
        rows = []

    return rows


# ---------------------------------------------------------------------------
# Symbol bridge: BSE code → NSE symbol
# ---------------------------------------------------------------------------
def build_bse_to_nse_map(conn) -> dict[str, dict]:
    """
    Build a map of bse_code -> {symbol, isin} using nse_stocks table.
    Falls back to isin-keyed lookup from nse_stocks if bse_code column absent.
    """
    mapping: dict[str, dict] = {}

    # Primary: nse_stocks table keyed on bse_code
    try:
        df = read_df(
            "SELECT symbol, isin, bse_code FROM nse_stocks WHERE bse_code IS NOT NULL"
        )
        if not df.empty:
            for _, row in df.iterrows():
                key = str(row.get("bse_code", "")).strip()
                if key:
                    mapping[key] = {
                        "symbol": row.get("symbol", ""),
                        "isin":   row.get("isin", ""),
                    }
            print(f"[CreditRating] Loaded {len(mapping)} BSE->NSE mappings from nse_stocks")
            if mapping:
                return mapping
    except Exception as e:
        print(f"[CreditRating] nse_stocks bse_code lookup warning: {e}")

    # Fallback: isin-keyed map from nse_stocks (isin column confirmed present)
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
    Convert raw BSE announcement rows into structured credit_rating_events records.
    """
    events = []
    for row in rows:
        # BSE field names vary; try common variants
        headline = (
            row.get("HEADLINE") or row.get("headline") or
            row.get("Subject") or row.get("subject") or ""
        ).strip()
        if not headline:
            continue

        bse_code = str(
            row.get("SCRIP_CD") or row.get("scripcd") or row.get("ScripCode") or ""
        ).strip()

        ann_date = (
            row.get("DT_TM") or row.get("NewsDate") or row.get("DT") or ""
        ).strip()
        # Normalise date to YYYY-MM-DD
        for fmt in ("%d/%m/%Y %H:%M:%S", "%d/%m/%Y", "%Y-%m-%dT%H:%M:%S", "%Y-%m-%d"):
            try:
                ann_date = datetime.datetime.strptime(ann_date[:len(fmt) + 4], fmt).strftime("%Y-%m-%d")
                break
            except ValueError:
                continue

        action          = classify_rating_action(headline)
        agency          = extract_agency(headline)
        instrument_type = extract_instrument_type(headline)

        # Resolve NSE symbol via bse_code, then ISIN
        isin   = str(row.get("ISIN") or row.get("isin") or "").strip()
        symbol = ""
        resolved = bse_nse_map.get(bse_code) or bse_nse_map.get(isin)
        if resolved:
            symbol = resolved.get("symbol", "")
            if not isin:
                isin = resolved.get("isin", "")

        events.append({
            "bse_code":         bse_code,
            "symbol":           symbol,
            "isin":             isin,
            "announcement_date": ann_date,
            "rating_agency":    agency or "",
            "action":           action,
            "instrument_type":  instrument_type or "",
            "headline":         headline,
        })

    return events


# ---------------------------------------------------------------------------
# Persist events
# ---------------------------------------------------------------------------
def upsert_events(conn, events: list[dict]) -> None:
    if not events:
        return

    if use_postgres():
        sql = """
            INSERT INTO credit_rating_events
                (bse_code, symbol, isin, announcement_date, rating_agency,
                 action, instrument_type, headline)
            VALUES (%s, %s, %s, %s, %s, %s, %s, %s)
            ON CONFLICT (bse_code, announcement_date, rating_agency) DO UPDATE SET
                symbol          = EXCLUDED.symbol,
                isin            = EXCLUDED.isin,
                action          = EXCLUDED.action,
                instrument_type = EXCLUDED.instrument_type,
                headline        = EXCLUDED.headline
        """
    else:
        sql = """
            INSERT OR REPLACE INTO credit_rating_events
                (bse_code, symbol, isin, announcement_date, rating_agency,
                 action, instrument_type, headline)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        """

    params = [
        (
            e["bse_code"], e["symbol"], e["isin"], e["announcement_date"],
            e["rating_agency"], e["action"], e["instrument_type"], e["headline"],
        )
        for e in events
    ]
    executemany(conn, sql, params)
    conn.commit()


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

    if use_postgres():
        sql = """
            UPDATE technical_signals
            SET rating_upgrade_180d   = %s,
                rating_downgrade_180d = %s,
                days_since_upgrade    = %s
            WHERE symbol = %s
              AND date = (
                  SELECT MAX(date) FROM technical_signals ts2 WHERE ts2.symbol = %s
              )
        """
        params = [(u[0], u[1], u[2], u[3], u[3]) for u in updates]
    else:
        sql = """
            UPDATE technical_signals
            SET rating_upgrade_180d   = ?,
                rating_downgrade_180d = ?,
                days_since_upgrade    = ?
            WHERE symbol = ?
              AND date = (
                  SELECT MAX(date) FROM technical_signals ts2 WHERE ts2.symbol = ?
              )
        """
        params = [(u[0], u[1], u[2], u[3], u[3]) for u in updates]

    executemany(sql, params)
    conn.commit()
    return len(updates)


# ---------------------------------------------------------------------------
# Main
# ---------------------------------------------------------------------------
def main():
    parser = argparse.ArgumentParser(description="Fetch BSE credit rating events")
    parser.add_argument("--days", type=int, default=180,
                        help="Lookback window in days (default: 180)")
    args = parser.parse_args()

    conn = connect()
    ensure_credit_rating_table(conn)
    ensure_technical_signals_columns(conn)

    # Build BSE→NSE symbol map
    bse_nse_map = build_bse_to_nse_map(conn)

    # Date range for BSE API  (DD/MM/YYYY format)
    today     = datetime.date.today()
    from_dt   = today - datetime.timedelta(days=args.days)
    to_date   = today.strftime("%d/%m/%Y")
    from_date = from_dt.strftime("%d/%m/%Y")

    print(f"[CreditRating] Fetching BSE rating announcements {from_date} -> {to_date} ...")
    raw_rows = fetch_bse_rating_announcements(from_date, to_date)
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
