"""
Sector / Industry Backfill — MoneyControl source
================================================
Fills nse_stocks.sector + industry from MoneyControl's pricefeed, which returns
`main_sector` and `newSubsector` for ~98% of the NSE universe (every stock that has
an mcsymbol). MoneyControl's sector labels are its own granular scheme, so main_sector
is mapped onto the GICS labels the DB column already uses; newSubsector is stored
verbatim in `industry`.

Two phases (the fetch is the slow part, so it's cached to disk):

    python backfill_sector_mc.py --enumerate     # fetch all -> cache JSON + print
                                                  # distinct main_sectors (NO db write)
    python backfill_sector_mc.py --write          # map + write to DB from the cache
    python backfill_sector_mc.py --write --report-unmapped   # list MC sectors with no GICS map

Re-running --write is idempotent. Symbols whose MC main_sector has no GICS mapping get
their `industry` written but `sector` left untouched, and are listed at the end so the
map can be extended.
"""

import argparse
import json
import random
import sys
import time
from pathlib import Path

import requests

sys.path.insert(0, str(Path(__file__).resolve().parent))
from db_compat import query_all, execute  # noqa: E402

_UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36"
)
_PRICEFEED = "https://priceapi.moneycontrol.com/pricefeed/nse/equitycash/{mc}"
_CACHE = Path(__file__).resolve().parent / "mc_sector_cache.json"

# MoneyControl main_sector -> canonical GICS label already present in nse_stocks.sector.
# Built from the full distinct set observed via --enumerate.
_GICS = {
    "Banks": "Financials",
    "Finance": "Financials",
    "Insurance": "Financials",
    "Financial Services": "Financials",
    "Software & IT Services": "Information Technology",
    "IT - Hardware": "Information Technology",
    "Telecom": "Telecommunications",
    "Telecommunication": "Telecommunications",
    "Oil & Gas": "Energy",
    "Power": "Utilities",
    "Utilities": "Utilities",
    "Automobile & Ancillaries": "Consumer Discretionary",
    "Consumer Durables": "Consumer Discretionary",
    "Retailing": "Consumer Discretionary",
    "Textiles": "Consumer Discretionary",
    "Hospitality": "Consumer Discretionary",
    "Media & Entertainment": "Media & Entertainment",
    "FMCG": "Consumer Staples",
    "Agri": "Consumer Staples",
    "Consumer Staples": "Consumer Staples",
    "Healthcare": "Healthcare",
    "Pharmaceuticals": "Healthcare",
    "Metals & Mining": "Materials",
    "Chemicals": "Materials",
    "Construction Materials": "Materials",
    "Diversified": "Industrials",
    "Capital Goods": "Industrials",
    "Infrastructure": "Industrials",
    "Logistics": "Industrials",
    "Services": "Industrials",
    "Trading": "Industrials",
    "Realty": "Real Estate",
    # Found unmapped on the first live --enumerate run against production (2026-08-05) --
    # MC's main_sector labels aren't just the ones probed when this dict was first built.
    "Real Estate": "Real Estate",                 # MC uses this exact label too, not just "Realty"
    "Plastic Products": "Materials",
    "Electricals": "Industrials",                 # electrical equipment, not power generation/utility
    "Paper": "Materials",
    "Diamond & Jewellery": "Consumer Discretionary",
    "Diamond  &  Jewellery": "Consumer Discretionary",  # MC's own feed has a double-space variant
    "Containers & Packaging": "Materials",
    "Aviation": "Industrials",
    "Alcohol": "Consumer Staples",
    "Industrial Gases & Fuels": "Materials",
    "Footwear": "Consumer Discretionary",
    "Manufacturing": "Industrials",
    "Ship Building": "Industrials",
    "Photographic Products": "Consumer Discretionary",
    # "Miscellaneous" deliberately left unmapped -- genuinely not a single GICS sector, and
    # forcing one would be a guess this project's own conventions rule out (industry still
    # gets written for it via `sub`, per write_db()'s COALESCE logic).
}


def _session() -> requests.Session:
    s = requests.Session()
    s.headers.update({"User-Agent": _UA, "Referer": "https://www.moneycontrol.com/"})
    return s


def _fetch(session: requests.Session, mc: str):
    try:
        r = session.get(_PRICEFEED.format(mc=mc), timeout=10)
        if r.status_code != 200:
            return None, None
        data = (r.json() or {}).get("data") or {}
        return (data.get("main_sector") or None), (data.get("newSubsector") or None)
    except Exception:
        return None, None


def _targets():
    rows = query_all(
        "SELECT symbol, mcsymbol FROM nse_stocks "
        "WHERE mcsymbol IS NOT NULL AND mcsymbol <> '' ORDER BY symbol"
    )
    return [(r["symbol"], r["mcsymbol"]) for r in rows]


def enumerate_sectors(base_delay: float):
    targets = _targets()
    print(f"[MC-SECTOR] Enumerating {len(targets)} symbols -> {_CACHE.name}")
    session = _session()
    cache: dict[str, list] = {}
    miss = 0
    for i, (sym, mc) in enumerate(targets, 1):
        main, sub = _fetch(session, mc)
        if not main and not sub:
            miss += 1
        cache[sym] = [main, sub]
        if i % 200 == 0:
            _CACHE.write_text(json.dumps(cache))
            print(f"[MC-SECTOR] {i}/{len(targets)} fetched ({miss} misses)")
        time.sleep(base_delay * (0.7 + 0.6 * random.random()))
    _CACHE.write_text(json.dumps(cache))

    from collections import Counter
    counts = Counter(v[0] for v in cache.values() if v[0])
    print(f"\n[MC-SECTOR] {len(targets)} fetched, {miss} misses. Distinct main_sectors:")
    for name, n in counts.most_common():
        flag = "" if name in _GICS else "  <-- UNMAPPED"
        print(f"  {n:5d}  {name}{flag}")


def write_db(report_unmapped: bool):
    if not _CACHE.exists():
        sys.exit("No cache. Run --enumerate first.")
    cache = json.loads(_CACHE.read_text())
    updated_sector = updated_industry = 0
    unmapped: dict[str, int] = {}
    for sym, (main, sub) in cache.items():
        gics = _GICS.get(main) if main else None
        if main and not gics:
            unmapped[main] = unmapped.get(main, 0) + 1
        if gics or sub:
            execute(
                "UPDATE nse_stocks SET sector = COALESCE(?, sector), "
                "industry = COALESCE(?, industry), last_updated = CURRENT_TIMESTAMP "
                "WHERE symbol = ?",
                (gics, sub, sym),
            )
            if gics:
                updated_sector += 1
            if sub:
                updated_industry += 1
    print(f"[MC-SECTOR] Wrote sector for {updated_sector}, industry for {updated_industry} stocks.")
    if unmapped and report_unmapped:
        print("[MC-SECTOR] Unmapped MC main_sectors (industry written, sector left as-is):")
        for name, n in sorted(unmapped.items(), key=lambda x: -x[1]):
            print(f"  {n:5d}  {name}")


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--enumerate", action="store_true")
    ap.add_argument("--write", action="store_true")
    ap.add_argument("--report-unmapped", action="store_true")
    ap.add_argument("--base-delay", type=float, default=0.25)
    args = ap.parse_args()
    if args.enumerate:
        enumerate_sectors(args.base_delay)
    if args.write:
        write_db(args.report_unmapped)
    if not (args.enumerate or args.write):
        ap.error("pass --enumerate and/or --write")


if __name__ == "__main__":
    main()
