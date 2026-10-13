"""
sync_tl_index_map.py
====================
Syncs Trendlyne index tlids into index_provider_map using the live endpoint:

  https://trendlyne.com/equity/global-indices-analysis/
     → body.tableData  (global + Indian major indices)

The `id` / `stock_id` field is the tlid used by Trendlyne chart-data APIs.

The former sector-industry-analysis endpoint was retired (HTTP 404, confirmed
2026-10-10). Its trendlyne_sector/trendlyne_industry rows are historical reference
data with no code reader. Stock sector/industry classifications are maintained in
nse_stocks from MoneyControl with Yahoo as a fallback; they are not Trendlyne ids.
This sync refreshes only the still-live, consumed `trendlyne` id family and does not
delete the historical provider-specific rows.

Run:
  python sync_tl_index_map.py            # sync all, print diff
  python sync_tl_index_map.py --dry-run  # print only, no writes
"""

import argparse
import re

import requests

from db_compat import executemany, query_all

TL_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json, text/javascript, */*; q=0.01",
    "X-Requested-With": "XMLHttpRequest",
    "Referer": "https://trendlyne.com/",
}

GLOBAL_URL = "https://trendlyne.com/equity/global-indices-analysis/"

# NSEcode → our canonical index_name (used for the 'trendlyne' provider).
# Only needed where the NSEcode differs from our canonical symbol.
NSECODE_TO_NAME: dict[str, str] = {
    "NIFTY":            "NIFTY50",
    "NIFTYNXT50":       "NIFTYNEXT50",
    "LIX15":            "NIFTY100LIQ15",
    "NIFTYMIDCAPLIQUID15": "NIFTYMIDCAPLIQ15",
    "NIFTY100":         "NIFTY100",
    "NIFTY200":         "NIFTY200",
    "NIFTY500":         "NIFTY500",
    "NIFTYMIDCAP50":    "NIFTYMIDCAP50",
    "NIFTYMIDCAP100":   "NIFTYMIDCAP100",
    "NIFTYSMALL100":    "NIFTYSMALLCAP100",
    "NIFTYAUTO":        "NIFTYAUTO",
    "BANKNIFTY":        "NIFTYBANK",
    "NIFTYENERGY":      "NIFTYENERGY",
    "FINNIFTY":         "NIFTYFINSRV",
    "NIFTYFMCG":        "NIFTYFMCG",
    "NIFTYIT":          "NIFTYIT",
    "NIFTYMEDIA":       "NIFTYMEDIA",
    "NIFTYMETAL":       "NIFTYMETAL",
    "NIFTYPHARMA":      "NIFTYPHARMA",
    "NIFTYPSUBANK":     "NIFTYPSUBANK",
    "NIFTYREALTY":      "NIFTYREALTY",
    "NIFTYCOMMODITIES": "NIFTYCOMDTY",
    "NIFTYCONSUMPTION": "NIFTYCONSUMP",
    "NIFTYCPSE":        "NIFTYCPSE",
    "NIFTYINFRA":       "NIFTYINFRA",
    "NIFTYMNC":         "NIFTYMNC",
    "NIFTYPSE":         "NIFTYPSE",
    "NIFTYSERVSECTOR":  "NIFTYSRVR",
    "NIFPVTBANK":       "NIFTYPVTBANK",
    "BSESENSEX":        "SENSEX",
    "BSE100":           "BSE100",
    "BSE200":           "BSE200",
    "BSE500":           "BSE500",
    "BSEBANKEX":        "BSEBANKEX",
    "BSEAUTO":          "BSEAUTO",
    "BSECG":            "BSECAPGOODS",
    "BSECD":            "BSECONSDURABLES",
    "BSEMETAL":         "BSEMETAL",
    "BSEOIL&GAS":       "BSEOILGAS",
    "BSEPOWER":         "BSEPOWER",
    "BSEREALTY":        "BSEREALTY",
    "BSETECK":          "BSETECK",
    "BSEPSU":           "BSEPSU",
    "BSEIT":            "BSEIT",
    "BSEFMCG":          "BSEFMCG",
    "BSEHEALTHCARE":    "BSEHEALTHCARE",
    "BSEUTILITIES":     "BSEUTILITIES",
    "BSEFINANCE":       "BSEFINSRV",
    "BSEINDUSTRIALS":   "BSEINDUSTRIALS",
    "BSEENERGY":        "BSEENERGY",
    "BSECOMDTY":        "BSECOMDTY",  # doesn't exist but fallback
    "BSECOMMODITIES":   "BSECOMDTY",
    "BSETELECOM":       "BSETELECOM",
    "SGXNIFTY-CFD":     "GIFTNIFTY",
    # Global indices
    "DJI-CFD":          "DOW",
    "GSPC-CFD":         "SP500",
    "IXIX-CFD":         "NASDAQ",
    "GDAXI-CFD":        "DAX",
    "FTSE-CFD":         "FTSE100",
    "N225-CFD":         "NIKKEI225",
    "HSI-CFD":          "HANGSENG",
    "FCHI-CFD":         "CAC40",
    "AXJO-CFD":         "ASX200",
    "TWII-CFD":         "TWII",
    "000001.SS-CFD":    "SHANGHAI",
    "DOWFUTURES-CFD":   "DOWFUTURES",
}


def _canonical(nsecode: str, display_name: str) -> str:
    """Derive our internal index_name from nsecode or display name."""
    if nsecode in NSECODE_TO_NAME:
        return NSECODE_TO_NAME[nsecode]
    # If nsecode is purely numeric (BSE scheme), use display name normalised
    if re.match(r'^\d+$', nsecode):
        return re.sub(r'[^A-Za-z0-9]', '', display_name).upper()
    # Otherwise uppercase NSEcode is a reasonable canonical name
    return nsecode.upper().replace("&", "").replace("-", "").replace(".", "")


def fetch_all() -> dict[str, list[tuple[str, str, str]]]:
    """Fetch the live global endpoint and return its Trendlyne index ids."""
    rows: dict[str, list] = {"trendlyne": []}
    seen: set = set()

    # Global indices page (the required, consumed provider-id family).
    r2 = requests.get(GLOBAL_URL, headers=TL_HEADERS, timeout=20)
    r2.raise_for_status()
    for entry in r2.json().get("body", {}).get("tableData", []):
        sc   = entry.get("stock_column", {})
        tlid = sc.get("stock_id") or sc.get("pk")
        if tlid in seen:
            continue
        seen.add(tlid)
        nsecode  = sc.get("NSEcode", "")
        name     = sc.get("stockName") or sc.get("get_full_name", "")
        idx_name = _canonical(nsecode, name)
        rows["trendlyne"].append((idx_name, "trendlyne", str(tlid)))

    if not rows["trendlyne"] or "NIFTY50" not in {row[0] for row in rows["trendlyne"]}:
        raise RuntimeError("Trendlyne global-index response has no usable NIFTY50 mapping")

    return rows


def sync(dry_run: bool = False) -> None:
    print("[sync_tl_index_map] Fetching Trendlyne global-index endpoint ...")
    all_rows = fetch_all()

    # Load existing for diff
    existing = {
        (r["index_name"], r["provider"]): r["provider_id"]
        for r in query_all(
            "SELECT index_name, provider, provider_id FROM index_provider_map "
            "WHERE provider IN ('trendlyne','trendlyne_sector','trendlyne_industry')"
        )
    }

    new_count = updated_count = unchanged_count = 0
    for provider, rows in all_rows.items():
        for idx_name, prov, pid in rows:
            key = (idx_name, prov)
            old = existing.get(key)
            if old is None:
                new_count += 1
                if dry_run:
                    print(f"  + {prov:<25} {idx_name:<40} tlid={pid}")
            elif old != pid:
                updated_count += 1
                print(f"  ~ {prov:<25} {idx_name:<40} {old} -> {pid}")
            else:
                unchanged_count += 1

    print(f"\n  New: {new_count}  Updated: {updated_count}  Unchanged: {unchanged_count}")

    if dry_run:
        print("[dry-run] No writes.")
        return

    flat = [row for rows in all_rows.values() for row in rows]
    executemany("""
        INSERT INTO index_provider_map (index_name, provider, provider_id)
        VALUES (?, ?, ?)
        ON CONFLICT (index_name, provider) DO UPDATE SET provider_id = excluded.provider_id
    """, flat)

    total = query_all("SELECT COUNT(*) as c FROM index_provider_map")[0]["c"]
    tl_n  = query_all(
        "SELECT COUNT(*) as c FROM index_provider_map WHERE provider LIKE 'trendlyne%'"
    )[0]["c"]
    print(f"\n[sync_tl_index_map] Done. {len(flat)} rows upserted. "
          f"Total index_provider_map: {total}  (trendlyne*: {tl_n})")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sync(dry_run=args.dry_run)
