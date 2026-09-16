"""
sync_tl_index_map.py
====================
Syncs Trendlyne index tlids into index_provider_map using two live API endpoints:

  1. https://trendlyne.com/equity/sector-industry-analysis/overall/day-changeP/
     → body.index.chart + body.index.tableData  (Indian indices, NSE + BSE)
     → body.sector.chart   (Trendlyne sector IDs → trendlyne_sector provider)
     → body.industry.chart (Trendlyne industry IDs → trendlyne_industry provider)

  2. https://trendlyne.com/equity/global-indices-analysis/
     → body.tableData  (global + Indian major indices)

The `id` / `stock_id` field is the tlid used by Trendlyne chart-data APIs.

Run:
  python sync_tl_index_map.py            # sync all, print diff
  python sync_tl_index_map.py --dry-run  # print only, no writes
"""

import polars as pl
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

SECTOR_URL = "https://trendlyne.com/equity/sector-industry-analysis/overall/day-changeP/"
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


def _extract_nsecode_from_url(url: str) -> str:
    m = re.search(r'/equity/\d+/([^/]+)/', url)
    return m.group(1) if m else ""


def fetch_all() -> dict[str, list[tuple[str, str, str]]]:
    """Fetch both endpoints and return {provider: [(index_name, provider, provider_id)]}."""
    rows: dict[str, list] = {
        "trendlyne":          [],
        "trendlyne_sector":   [],
        "trendlyne_industry": [],
    }
    seen: set = set()

    # ── Sector/Index analysis page ─────────────────────────────────────────────
    r = requests.get(SECTOR_URL, headers=TL_HEADERS, timeout=20)
    r.raise_for_status()
    body = r.json().get("body", {})

    # Index section (NSE + BSE Indian indices)
    index_body = body.get("index", {})
    entries = []
    for e in index_body.get("chart", []):
        url = e.get("cell_url", "")
        nsecode = _extract_nsecode_from_url(url) or e.get("name", "")
        entries.append({"id": e["id"], "nsecode": nsecode, "name": e["name"], "url": url})
    for e in index_body.get("tableData", []):
        sc = e.get("stock_column", e)
        tlid    = sc.get("stock_id") or sc.get("pk") or sc.get("id")
        nsecode = sc.get("NSEcode", "")
        name    = sc.get("stockName") or sc.get("get_full_name") or sc.get("name", "")
        url     = sc.get("absolute_url", "")
        if not nsecode:
            nsecode = _extract_nsecode_from_url(url)
        entries.append({"id": tlid, "nsecode": nsecode, "name": name, "url": url})

    for e in entries:
        tlid    = e["id"]
        if tlid in seen:
            continue
        seen.add(tlid)
        nsecode = e.get("nsecode", "")
        name    = e.get("name", "")
        idx_name = _canonical(nsecode, name)
        rows["trendlyne"].append((idx_name, "trendlyne", str(tlid)))

    # Sector section
    for e in body.get("sector", {}).get("chart", []):
        sid  = e["id"]
        name = re.sub(r'[^A-Za-z0-9]', '', e["name"]).upper()
        rows["trendlyne_sector"].append((name, "trendlyne_sector", str(sid)))

    # Industry section
    for e in body.get("industry", {}).get("chart", []):
        iid  = e["id"]
        name = re.sub(r'[^A-Za-z0-9]', '', e["name"]).upper()
        rows["trendlyne_industry"].append((name, "trendlyne_industry", str(iid)))

    # ── Global indices page ─────────────────────────────────────────────────────
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

    return rows


def sync(dry_run: bool = False) -> None:
    print("[sync_tl_index_map] Fetching Trendlyne endpoints ...")
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

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
