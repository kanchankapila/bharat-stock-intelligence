"""
sync_nt_fno_symbols.py
======================
Syncs NiftyTrader F&O universe into:
  1. index_provider_map  (provider='nt_index')  — maps our canonical index_name
     to the lowercase symbol param used by NT APIs (e.g. NIFTY50 → 'nifty').
  2. nse_stocks           (fno_eligible, lot_size) — marks all 212 F&O stocks
     with their current lot size from /psymbol-list.

APIs used:
  https://webapi.niftytrader.in/webapi/symbol/stock-index-data
  https://webapi.niftytrader.in/webapi/symbol/psymbol-list?exchange=false

Run:
  python sync_nt_fno_symbols.py
  python sync_nt_fno_symbols.py --dry-run
"""

import argparse
from datetime import datetime

import requests

from db_compat import execute, executemany, query_all

NT_HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Origin": "https://www.niftytrader.in",
    "Referer": "https://www.niftytrader.in/",
}

INDEX_DATA_URL  = "https://webapi.niftytrader.in/webapi/symbol/stock-index-data"
PSYMBOL_URL     = "https://webapi.niftytrader.in/webapi/symbol/psymbol-list?exchange=false"

# NT display name → (canonical index_name, api_symbol, provider)
# provider 'nt_index'     = NSE exchange  (reqType=nse_pcr_data, exchange=nse)
# provider 'nt_index_bse' = BSE exchange  (reqType=bse_pcr_data, exchange=bse)
_NT_INDEX_MAP: dict[str, tuple[str, str, str]] = {
    "NIFTY 50":          ("NIFTY50",       "nifty",      "nt_index"),
    "NIFTY BANK":        ("NIFTYBANK",      "banknifty",  "nt_index"),
    "NIFTY FIN SERVICE": ("NIFTYFINSRV",    "finnifty",   "nt_index"),
    "NIFTY MID SELECT":  ("NIFTYMIDSELECT", "midcpnifty", "nt_index"),
    "GIFT NIFTY":        ("GIFTNIFTY",      "giftnifty",  "nt_index"),
    # BSE indices — use exchange=bse in OI/PCR calls
    "SENSEX":            ("SENSEX",         "sensex",     "nt_index_bse"),
}

# BSE-only indices not in stock-index-data but discoverable via symbol-expiry-all?exchange=bse
_BSE_EXTRA: list[tuple[str, str, str]] = [
    ("BANKEX",  "bankex", "nt_index_bse"),
    ("FOCIT",   "focit",  "nt_index_bse"),
]


def _fetch(url: str) -> list | None:
    try:
        r = requests.get(url, headers=NT_HEADERS, timeout=15)
        d = r.json()
        if d.get("result") != 1:
            print(f"[sync_nt_fno] API error: {d.get('resultMessage')}")
            return None
        return d.get("resultData", [])
    except Exception as e:
        print(f"[sync_nt_fno] fetch error for {url}: {e}")
        return None


def sync_index_map(dry_run: bool = False) -> int:
    """Upsert 6 NT index entries into index_provider_map."""
    data = _fetch(INDEX_DATA_URL)
    if data is None:
        return 0

    rows: list[tuple[str, str, str]] = []
    for entry in data:
        nt_name = entry.get("symbol_name", "").strip()
        if nt_name not in _NT_INDEX_MAP:
            print(f"  [skip] unknown NT index: {nt_name!r}")
            continue
        canonical, api_sym, provider = _NT_INDEX_MAP[nt_name]
        rows.append((canonical, provider, api_sym))

    # Add BSE-only indices not in stock-index-data
    for canonical, api_sym, provider in _BSE_EXTRA:
        rows.append((canonical, provider, api_sym))

    if not rows:
        print("[sync_nt_fno] No index rows to upsert.")
        return 0

    for canonical, provider, api_sym in rows:
        print(f"  {provider:<18} {canonical:<20} -> {api_sym!r}")

    if not dry_run:
        executemany("""
            INSERT INTO index_provider_map (index_name, provider, provider_id)
            VALUES (?, ?, ?)
            ON CONFLICT (index_name, provider) DO UPDATE SET provider_id = excluded.provider_id
        """, rows)
        print(f"[sync_nt_fno] Upserted {len(rows)} index rows.")

    return len(rows)


def sync_fno_symbols(dry_run: bool = False) -> int:
    """Mark F&O eligible stocks + upsert lot sizes into nse_stocks."""
    data = _fetch(PSYMBOL_URL)
    if data is None:
        return 0

    now = datetime.utcnow().isoformat()
    rows: list[tuple] = []
    for entry in data:
        sym = (entry.get("symbol_name") or "").strip().upper()
        if not sym:
            continue
        lot = entry.get("lot_size")
        try:
            lot = int(float(lot)) if lot else None
        except (TypeError, ValueError):
            lot = None
        rows.append((sym, lot, now))

    print(f"[sync_nt_fno] {len(rows)} F&O symbols from psymbol-list.")

    if not dry_run:
        # Only UPDATE existing rows — don't INSERT (nse_stocks.name is NOT NULL and NT
        # doesn't provide company names; new symbols are added by syncNSEStocks instead).
        from db_compat import execute as _exec
        updated = 0
        for sym, lot, ts in rows:
            _exec("""
                UPDATE nse_stocks SET
                    fno_eligible       = 1,
                    lot_size           = ?,
                    fno_lot_updated_at = ?
                WHERE symbol = ?
            """, (lot, ts, sym))
            updated += 1
        print(f"[sync_nt_fno] Updated {updated} nse_stocks rows (fno_eligible + lot_size).")

    return len(rows)


def sync_fno_expiries(dry_run: bool = False) -> int:
    """Fetch active F&O expiries from NiftyTrader and upsert into nt_fno_expiry."""
    url = "https://webapi.niftytrader.in/webapi/Symbol/symbol-expiry-all?symbol=nifty&exchange=nse"
    data = _fetch(url)
    if data is None:
        return 0

    rows: list[tuple] = []
    for entry in data:
        sym = (entry.get("symbol_name") or "").strip().upper()
        expiry_raw = (entry.get("expiry_date") or "")[:10]
        lot = entry.get("lot_size")
        try:
            lot = int(float(lot)) if lot else None
        except (TypeError, ValueError):
            lot = None

        if sym and expiry_raw:
            rows.append((sym, "NSE", expiry_raw, lot))

    print(f"[sync_nt_fno] Found {len(rows)} symbol-expiry combinations from NT symbol-expiry-all.")

    if not dry_run and rows:
        from db_compat import executemany as _exec_many
        _exec_many("""
            INSERT INTO nt_fno_expiry (symbol, exchange, expiry, lot_size)
            VALUES (?, ?, ?, ?)
            ON CONFLICT (symbol, exchange, expiry) DO UPDATE SET
                lot_size = EXCLUDED.lot_size
        """, rows)
        print(f"[sync_nt_fno] Upserted {len(rows)} rows into nt_fno_expiry.")

    return len(rows)


def sync(dry_run: bool = False) -> None:
    print("[sync_nt_fno_symbols] Syncing NT F&O universe ...")
    n_idx = sync_index_map(dry_run)
    n_sym = sync_fno_symbols(dry_run)
    n_exp = sync_fno_expiries(dry_run)
    mode = "dry-run" if dry_run else "done"
    print(f"[sync_nt_fno_symbols] {mode}. Indices={n_idx}  Stocks={n_sym}  Expiries={n_exp}")


if __name__ == "__main__":
    parser = argparse.ArgumentParser()
    parser.add_argument("--dry-run", action="store_true")
    args = parser.parse_args()
    sync(dry_run=args.dry_run)
