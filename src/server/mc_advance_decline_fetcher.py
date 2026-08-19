"""
MoneyControl Advance/Decline Fetcher
======================================
Fetches NSE and BSE advance/decline data from MoneyControl and upserts into:
  - mc_advance_decline  — raw A/D/U counts per exchange per date
  - market_breadth      — updates adv_decline_ratio only (leaves other columns intact)

API endpoint:
  https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=N   (NSE)
  https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec?ex=B   (BSE)

Run:  python mc_advance_decline_fetcher.py
"""

import datetime
import time

import requests

from db_compat import execute, executemany
import sys

BASE_URL = "https://api.moneycontrol.com/mcapi/v1/indices/chart/exchange-advdec"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://www.moneycontrol.com/",
    "Origin": "https://www.moneycontrol.com",
}

EXCHANGES = [
    ("N", "NSE"),
    ("B", "BSE"),
]

# ── Schema ─────────────────────────────────────────────────────────────────────

def ensure_schema() -> None:
    execute(
        """
        CREATE TABLE IF NOT EXISTS mc_advance_decline (
            date        TEXT NOT NULL,
            exchange    TEXT NOT NULL DEFAULT 'NSE',
            advances    INTEGER,
            declines    INTEGER,
            unchanged   INTEGER,
            adv_dec_ratio REAL,
            fetched_at  TEXT NOT NULL,
            PRIMARY KEY (date, exchange)
        )
        """
    )
    # market_breadth may already exist from other fetchers; add adv_decline_ratio
    # column if it is missing (ALTER TABLE is idempotent via try/except).
    execute(
        """
        CREATE TABLE IF NOT EXISTS market_breadth (
            date              TEXT PRIMARY KEY,
            adv_decline_ratio REAL,
            pct_above_200dma  REAL,
            fetched_at        TEXT
        )
        """
    )
    try:
        execute("ALTER TABLE market_breadth ADD COLUMN adv_decline_ratio REAL")
    except Exception:
        pass   # column already exists


# ── Parse date ─────────────────────────────────────────────────────────────────

def _parse_mc_date(raw: str) -> str:
    """Convert 'Jun 25, 2026' → '2026-06-25'. Falls back to today on parse failure."""
    try:
        dt = datetime.datetime.strptime(raw.strip(), "%b %d, %Y")
        return dt.strftime("%Y-%m-%d")
    except Exception:
        print(f"[A/D] WARN: unparseable date '{raw}', defaulting to today", file=sys.stderr)
        return datetime.date.today().isoformat()


# ── Fetch ──────────────────────────────────────────────────────────────────────

def fetch_adv_dec(session: requests.Session, ex_code: str) -> dict | None:
    """Fetch advance/decline data for one exchange. Returns parsed dict or None."""
    try:
        resp = session.get(BASE_URL, params={"ex": ex_code}, timeout=10)
        resp.raise_for_status()
        payload = resp.json()
    except Exception as e:
        print(f"[A/D] HTTP error ex={ex_code}: {e}", file=sys.stderr)
        return None

    data = payload.get("data", {})
    if not data:
        print(f"[A/D] Empty data for ex={ex_code}")
        return None

    # MC returns a list of intraday ticks — use the first (most recent) entry
    if isinstance(data, list):
        tick = data[0] if data else {}
        advances  = tick.get("advances")
        declines  = tick.get("declines")
        unchanged = tick.get("unchanged")
        raw_date  = ""  # no date in tick; use today
    else:
        advances  = data.get("A") or data.get("advances")
        declines  = data.get("D") or data.get("declines")
        unchanged = data.get("U") or data.get("unchanged")
        raw_date  = data.get("date", "")

    try:
        adv = int(advances)  if advances  is not None else 0
        dec = int(declines)  if declines  is not None else 0
        unc = int(unchanged) if unchanged is not None else 0
    except (TypeError, ValueError):
        adv, dec, unc = 0, 0, 0

    ratio = round(adv / (adv + dec), 4) if (adv + dec) > 0 else None
    date_str = _parse_mc_date(raw_date) if raw_date else datetime.date.today().isoformat()

    return {
        "date":      date_str,
        "advances":  adv,
        "declines":  dec,
        "unchanged": unc,
        "ratio":     ratio,
    }


# ── Upsert ─────────────────────────────────────────────────────────────────────

def upsert_adv_dec(ex_name: str, rec: dict) -> None:
    """Write raw counts to mc_advance_decline and ratio to market_breadth."""
    fetched_at = datetime.datetime.utcnow().strftime("%Y-%m-%d %H:%M:%S")

    # Raw table
    execute(
        """
        INSERT INTO mc_advance_decline
            (date, exchange, advances, declines, unchanged, adv_dec_ratio, fetched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(date, exchange) DO UPDATE SET
            advances      = excluded.advances,
            declines      = excluded.declines,
            unchanged     = excluded.unchanged,
            adv_dec_ratio = excluded.adv_dec_ratio,
            fetched_at    = excluded.fetched_at
        """,
        (rec["date"], ex_name, rec["advances"], rec["declines"],
         rec["unchanged"], rec["ratio"], fetched_at),
    )

    # Update market_breadth adv_decline_ratio only for NSE (the canonical breadth row)
    if ex_name == "NSE":
        execute(
            """
            INSERT INTO market_breadth (date, adv_decline_ratio)
            VALUES (?, ?)
            ON CONFLICT(date) DO UPDATE SET
                adv_decline_ratio = excluded.adv_decline_ratio
            """,
            (rec["date"], rec["ratio"]),
        )


# ── Main ───────────────────────────────────────────────────────────────────────

def main() -> None:
    ensure_schema()

    session = requests.Session()
    session.headers.update(HEADERS)

    for ex_code, ex_name in EXCHANGES:
        rec = fetch_adv_dec(session, ex_code)
        if rec is None:
            print(f"[A/D] {ex_name}: skipped (fetch failed)")
            continue

        upsert_adv_dec(ex_name, rec)

        ratio_str = f"{rec['ratio']:.3f}" if rec["ratio"] is not None else "N/A"
        print(
            f"[A/D] {ex_name} {rec['date']}: "
            f"{rec['advances']} adv / {rec['declines']} dec / {rec['unchanged']} unch "
            f"-> ratio={ratio_str}"
        )
        time.sleep(0.3)

    print("[A/D] Done.")


if __name__ == "__main__":
    main()
