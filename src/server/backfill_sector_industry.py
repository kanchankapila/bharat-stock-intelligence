"""
Sector / Industry Backfill
==========================
nse_stocks.sector is 'Unknown' for ~95% of symbols (only ~106 large-caps were ever
classified). This backfills sector + industry from Yahoo Finance's quoteSummary
`assetProfile` module, which covers the full NSE universe.

Yahoo uses its own sector taxonomy ("Consumer Cyclical", "Basic Materials", ...). We
map it onto the GICS labels the DB already uses ("Consumer Discretionary", "Materials",
...) so the column stays consistent. Industry is written verbatim (free-form, no
existing controlled vocabulary).

Idempotent: only rows where sector='Unknown' (or --all) are fetched; symbols Yahoo
can't classify are left untouched so a re-run retries only the gaps.

Run standalone:
    python backfill_sector_industry.py                 # all Unknown-sector stocks
    python backfill_sector_industry.py --limit 20      # first 20 (smoke test)
    python backfill_sector_industry.py --dry-run       # print, don't write
    python backfill_sector_industry.py --all           # re-fetch every stock
"""

import argparse
import random
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import query_all, execute  # noqa: E402

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
)

# Yahoo sector -> canonical GICS label already present in nse_stocks.sector
_SECTOR_MAP = {
    "Technology": "Information Technology",
    "Financial Services": "Financials",
    "Healthcare": "Healthcare",
    "Consumer Cyclical": "Consumer Discretionary",
    "Consumer Defensive": "Consumer Staples",
    "Industrials": "Industrials",
    "Basic Materials": "Materials",
    "Energy": "Energy",
    "Utilities": "Utilities",
    "Real Estate": "Real Estate",
    "Communication Services": "Communication Services",
}


def _make_session() -> requests.Session:
    """Yahoo needs a cookie + crumb pair before quoteSummary will answer."""
    s = requests.Session()
    s.headers.update({"User-Agent": _UA})  # NB: no Accept:application/json — getcrumb 406s on it
    s.get("https://fc.yahoo.com", timeout=10)
    crumb = s.get(
        "https://query2.finance.yahoo.com/v1/test/getcrumb",
        headers={"Accept": "*/*"},
        timeout=10,
    ).text.strip()
    if not crumb or "{" in crumb or "<html" in crumb.lower():
        raise RuntimeError(f"Failed to obtain Yahoo crumb (got: {crumb[:60]!r})")
    s._crumb = crumb  # type: ignore[attr-defined]
    return s


def _fetch_profile(session: requests.Session, symbol: str):
    """Return (sector, industry) from Yahoo assetProfile, or (None, None)."""
    # crumb can contain URL-significant chars (/, +, =) — pass via params so it's encoded.
    url = f"https://query2.finance.yahoo.com/v10/finance/quoteSummary/{symbol}.NS"
    resp = session.get(
        url,
        params={"modules": "assetProfile", "crumb": session._crumb},  # type: ignore[attr-defined]
        timeout=10,
    )
    if resp.status_code == 401:
        raise PermissionError("crumb expired")
    if resp.status_code != 200:
        return None, None
    result = (resp.json().get("quoteSummary") or {}).get("result")
    if not result:
        return None, None
    profile = result[0].get("assetProfile") or {}
    raw_sector = (profile.get("sector") or "").strip()
    industry = (profile.get("industry") or "").strip()
    sector = _SECTOR_MAP.get(raw_sector, raw_sector) if raw_sector else None
    return (sector or None), (industry or None)


def _targets(fetch_all: bool, limit: int | None):
    where = "" if fetch_all else "WHERE sector IS NULL OR sector = '' OR sector = 'Unknown'"
    rows = query_all(f"SELECT symbol FROM nse_stocks {where} ORDER BY symbol")
    syms = [r["symbol"] for r in rows]
    return syms[:limit] if limit else syms


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--all", action="store_true", help="re-fetch every stock, not just Unknown")
    ap.add_argument("--base-delay", type=float, default=0.35)
    args = ap.parse_args()

    symbols = _targets(args.all, args.limit)
    print(f"[SECTOR-BACKFILL] {len(symbols)} symbols to process "
          f"(dry_run={args.dry_run}, all={args.all})")

    session = _make_session()
    updated = miss = 0
    consecutive_fail = 0

    for i, sym in enumerate(symbols, 1):
        try:
            try:
                sector, industry = _fetch_profile(session, sym)
            except PermissionError:
                session = _make_session()  # refresh crumb and retry once
                sector, industry = _fetch_profile(session, sym)

            if not sector and not industry:
                miss += 1
                consecutive_fail += 1
                if consecutive_fail >= 8:
                    print(f"[SECTOR-BACKFILL] 8 consecutive misses — backing off 30s...")
                    time.sleep(30)
                    consecutive_fail = 0
                continue
            consecutive_fail = 0

            if args.dry_run:
                print(f"  {sym:14s} -> sector={sector!r:28} industry={industry!r}")
            else:
                execute(
                    "UPDATE nse_stocks SET sector = COALESCE(?, sector), "
                    "industry = COALESCE(?, industry), last_updated = CURRENT_TIMESTAMP "
                    "WHERE symbol = ?",
                    (sector, industry, sym),
                )
            updated += 1
        except Exception as e:  # noqa: BLE001
            miss += 1
            print(f"  [warn] {sym}: {e}")

        if i % 100 == 0:
            print(f"[SECTOR-BACKFILL] {i}/{len(symbols)} processed "
                  f"({updated} classified, {miss} missed)")
        time.sleep(args.base_delay * (0.8 + 0.4 * random.random()))

    print(f"[SECTOR-BACKFILL] Done. {updated} classified, {miss} missed.")


if __name__ == "__main__":
    main()
