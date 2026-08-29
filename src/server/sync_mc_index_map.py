"""
sync_mc_index_map.py
====================
Syncs MoneyControl index IDs into index_provider_map by calling:
  GET https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list

This is the authoritative source for mc_ohlc and mc_pe provider_ids (the integer
indexId used by the appfeeds OHLC graph and the fundamentals PE/PB graph APIs).

The mc_oi scId mapping (in;NSX, in;nbx, etc.) cannot be derived from this endpoint
and must be managed separately in index_provider_map.

Run:
  python sync_mc_index_map.py            # sync + print diff
  python sync_mc_index_map.py --dry-run  # print what would change, no writes
"""

import polars as pl
import argparse
import re
import time

import requests

from db_compat import executemany, query_all

API_URL = "https://api.moneycontrol.com/mcapi/v1/indices/get-indices-list"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:124.0) Gecko/20100101 Firefox/124.0",
    "Accept": "application/json",
    "Referer": "https://www.moneycontrol.com/",
}

# Manual canonical name overrides: MC display name → our internal index_name.
# Only needed where auto-normalisation produces a wrong or inconsistent result.
NAME_OVERRIDES: dict[str, str] = {
    "NIFTY 50":              "NIFTY50",
    "NIFTY BANK":            "NIFTYBANK",
    "NIFTY Midcap 100":      "NIFTYMIDCAP100",
    "NIFTY NEXT 50":         "NIFTYNEXT50",
    "NIFTY 100":             "NIFTY100",
    "Nifty 200":             "NIFTY200",
    "NIFTY 500":             "NIFTY500",
    "NIFTY Smallcap 100":    "NIFTYSMALLCAP100",
    "NIFTY MIDCAP 50":       "NIFTYMIDCAP50",
    "NIFTY 750 TOTAL MKT":   "NIFTY750",
    "SENSEX":                "SENSEX",
    "BSE 100":               "BSE100",
    "BSE 200":               "BSE200",
    "BSE 500":               "BSE500",
    "BSE BANKEX":            "BSEBANKEX",
    "BSE SENSEX NEXT 30":    "BSESENSEXNEXT30",
    "NIFTY Auto":            "NIFTYAUTO",
    "NIFTY IT":              "NIFTYIT",
    "NIFTY PSU Bank":        "NIFTYPSUBANK",
    "NIFTY Fin Service":     "NIFTYFINSRV",
    "NIFTY Pharma":          "NIFTYPHARMA",
    "NIFTY FMCG":            "NIFTYFMCG",
    "NIFTY Metal":           "NIFTYMETAL",
    "NIFTY Realty":          "NIFTYREALTY",
    "NIFTY Media":           "NIFTYMEDIA",
    "NIFTY Energy":          "NIFTYENERGY",
    "Nifty Pvt Bank":        "NIFTYPVTBANK",
    "NIFTY Infra":           "NIFTYINFRA",
    "NIFTY Commodities":     "NIFTYCOMDTY",
    "NIFTY Consumption":     "NIFTYCONSUMP",
    "NIFTY PSE":             "NIFTYPSE",
    "NIFTY Services":        "NIFTYSRVR",
    "Nifty FinSrv25/50":     "NIFTYFINSRV2550",
    "Nifty Cons Durbl":      "NIFTYCONSDURBL",
    "Nifty Healthcare":      "NIFTYHEALTHCARE",
    "Nifty Oil & Gas":       "NIFTYOILGAS",
    "NIFTY India Mfg":       "NIFTYINDIAMFG",
    "Nifty India Defence":   "NIFTYINDIADEFENCE",
    "BSE Commodities":       "BSECOMDTY",
    "BSE Industrials":       "BSEINDUSTRIALS",
    "BSE Cons Discret":      "BSECONSDISCRET",
    "BSE Energy":            "BSEENERGY",
    "BSE IT":                "BSEIT",
    "BSE Telecom":           "BSETELECOM",
    "BSE Utilities":         "BSEUTILITIES",
    "BSE Auto":              "BSEAUTO",
    "BSE Cons Durables":     "BSECONSDURABLES",
    "BSE Cap Goods":         "BSECAPGOODS",
    "BSE FMCG":              "BSEFMCG",
    "BSE Metal":             "BSEMETAL",
    "BSE Oil & Gas":         "BSEOILGAS",
    "BSE Realty":            "BSEREALTY",
    "BSE Power":             "BSEPOWER",
    "BSE Fin Services":      "BSEFINSRV",
    "BSE Healthcare":        "BSEHEALTHCARE",
    "BSE TECk":              "BSETECK",
    "BSE PSU":               "BSEPSU",
    "BSE Pvt Bank":          "BSEPVTBANK",
    "BSE Services":          "BSESERVICES",
    "BSE PSUBNK":            "BSEPSUBNK",
    "BSE India Defence":     "BSEINDIADEFENCE",
    "NIFTY MIDCAP 150":      "NIFTYMIDCAP150",
    "NIFTY MIDSML 400":      "NIFTYMIDSML400",
    "NIFTY SMLCAP 250":      "NIFTYSMALLCAP250",
    "NIFTY MNC":             "NIFTYMNC",
    "NIFTY AlphaLowVol 30":  "NIFTYALPHALOW30",
    "Nifty200 Momentum 30":  "NIFTY200MOM30",
    "Nifty LargeMid250":     "NIFTYLARGEMID250",
    "Nifty500 Mul50:25:25":  "NIFTY500MUL",
    "NIFTY CPSE":            "NIFTYCPSE",
    "NIFTY MID SELECT":      "NIFTYMIDSELECT",
    "NIFTY IND DIGITAL":     "NIFTYINDDIGITAL",
    "NIFTY M150 QLTY50":     "NIFTYM150QLTY50",
    "Nifty Microcap 250":    "NIFTYMICROCAP250",
    "Nifty Capital Market":  "NIFTYCAPMARKET",
    "BSE BHARAT 22":         "BSEBHARAT22",
    "BSE IPO":               "BSEIPO",
    "BSE SME IPO":           "BSESMEIPO",
    "BSE ALLCAP":            "BSEALLCAP",
    "BSE MIDCAP SELECT":     "BSEMIDCAPSELECT",
    "BSE SMALLCAP SELECT":   "BSESMALLCAPSELECT",
    "BSE SENSEX 50":         "BSESENSEX50",
    "BSE SENSEX NEXT 50":    "BSESENSEXNEXT50",
    "BSE 150 MIDCAP":        "BSE150MIDCAP",
    "BSE 250 SMALLCAP":      "BSE250SMALLCAP",
    "BSE 250 LARGEMIDCAP":   "BSE250LARGEMIDCAP",
    "BSE 400 MIDSMALLCAP":   "BSE400MIDSMALLCAP",
    "BSE 100 LargeCap TMC":  "BSE100LARGECAPTMC",
    "BSE INDIA MANUFACTUR":  "BSEINDIAMFG",
    "BSE INDIA INFRA":       "BSEINDIAINFRA",
    "BSE CPSE":              "BSECPSE",
}


def _canonical(mc_name: str) -> str:
    """Convert MC display name to our canonical index_name (uppercase, no spaces/special chars)."""
    if mc_name in NAME_OVERRIDES:
        return NAME_OVERRIDES[mc_name]
    # Auto-normalise: uppercase, strip non-alphanumeric except nothing
    s = re.sub(r"[^A-Za-z0-9]", "", mc_name).upper()
    return s


def fetch_mc_indices() -> list[dict]:
    """Fetch all indices from MC API. Returns list of {index_name, mc_name, index_id, exchange, category}."""
    r = requests.get(API_URL, headers=HEADERS, timeout=15)
    r.raise_for_status()
    payload = r.json()
    if not payload.get("success"):
        raise ValueError(f"MC API returned success=0: {payload}")

    results = []
    for cat in payload.get("data", []):
        category = cat.get("category", "")
        for exchange, indices in cat.get("indexList", {}).items():
            for idx in indices:
                mc_name  = idx["name"]
                index_id = idx["indexId"]
                results.append({
                    "index_name": _canonical(mc_name),
                    "mc_name":    mc_name,
                    "index_id":   index_id,
                    "exchange":   exchange,
                    "category":   category,
                })
    return results


def sync(dry_run: bool = False) -> None:
    print(f"[sync_mc_index_map] Fetching {API_URL} ...")
    indices = fetch_mc_indices()
    print(f"[sync_mc_index_map] Received {len(indices)} indices from MC API")

    # Load existing mappings for comparison
    existing_ohlc = query_all(
        "SELECT index_name, provider_id FROM index_provider_map WHERE provider='mc_ohlc'"
    )
    existing_map = {r["index_name"]: r["provider_id"] for r in existing_ohlc}

    new_rows, updated_rows, unchanged = [], [], 0
    ohlc_rows = []
    pe_rows   = []

    for idx in indices:
        name  = idx["index_name"]
        id_s  = str(idx["index_id"])
        ohlc_rows.append((name, "mc_ohlc", id_s))
        pe_rows.append((name, "mc_pe",   id_s))

        old = existing_map.get(name)
        if old is None:
            new_rows.append(f"  + {name:<35} mc_ohlc={id_s}  ({idx['mc_name']})")
        elif old != id_s:
            updated_rows.append(f"  ~ {name:<35} mc_ohlc: {old} -> {id_s}  ({idx['mc_name']})")
        else:
            unchanged += 1

    if new_rows:
        print(f"\nNew indices ({len(new_rows)}):")
        for line in new_rows:
            print(line)
    if updated_rows:
        print(f"\nUpdated ({len(updated_rows)}):")
        for line in updated_rows:
            print(line)
    print(f"\nUnchanged: {unchanged}")

    if dry_run:
        print("\n[dry-run] No changes written.")
        return

    all_rows = ohlc_rows + pe_rows
    executemany("""
        INSERT INTO index_provider_map (index_name, provider, provider_id)
        VALUES (?, ?, ?)
        ON CONFLICT (index_name, provider) DO UPDATE SET provider_id = excluded.provider_id
    """, all_rows)

    total = query_all("SELECT COUNT(*) as c FROM index_provider_map")[0]["c"]
    print(f"\n[sync_mc_index_map] Done. {len(ohlc_rows)} mc_ohlc + {len(pe_rows)} mc_pe rows upserted. "
          f"Total index_provider_map rows: {total}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Sync MC index list into index_provider_map")
    parser.add_argument("--dry-run", action="store_true", help="Print diff only, no DB writes")
    args = parser.parse_args()
    sync(dry_run=args.dry_run)

def to_polars_df(data):
    """Converts pandas DataFrame or list of dicts to Polars DataFrame for fast vector operations."""
    if hasattr(data, 'empty') and data.empty:
        return pl.DataFrame()
    return pl.from_pandas(data) if hasattr(data, 'to_numpy') else pl.DataFrame(data)
