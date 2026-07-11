#!/usr/bin/env python3
"""Fetch ET (Economic Times) companyid mappings via the etsearch fuzzy-search
endpoint, mirroring fetch_finology_mappings.py.

Endpoint: https://etsearch.indiatimes.com/etspeeds/fuzzy-search?limit=6&ticker={symbol}
Returns companies[].assetId, which is the same `companyid` already used by
et_stats_client.py / stocklist.json.
"""
import os
import json
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "et_mappings.json")
STOCKLIST_FILE = os.path.join(os.path.dirname(__file__), "stocklist.json")

ET_SEARCH_URL = "https://etsearch.indiatimes.com/etspeeds/fuzzy-search"

HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    "Accept": "application/json, text/plain, */*",
}

EQUITY_SUFFIXES = ["EQ", "BE", "BZ", "BL", "BT", "SM", "IL"]


def load_stocklist_symbols():
    """Load stock symbols from local stocklist.json"""
    symbols = set()
    if os.path.exists(STOCKLIST_FILE):
        with open(STOCKLIST_FILE, "r", encoding="utf-8") as f:
            data = json.load(f)
            for entry in data:
                sym = entry.get("symbol")
                if sym:
                    symbols.add(sym.strip().upper())
        print(f"Loaded {len(symbols)} symbols from local stocklist.json")
    else:
        print("Error: stocklist.json not found")
    return symbols


def get_existing_mappings():
    """Load already fetched mappings to support resume functionality"""
    mappings = {}
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                for entry in data:
                    sym = entry.get("symbol")
                    if sym:
                        mappings[sym.upper()] = entry
            print(f"Loaded {len(mappings)} existing mappings from {OUTPUT_FILE}")
        except Exception as e:
            print(f"Warning: Failed to read existing mappings: {e}")
    return mappings


def fetch_et_data(symbol, session, max_retries=3):
    """Query etsearch fuzzy-search for a single symbol and extract assetId (companyid)."""
    for attempt in range(max_retries + 1):
        try:
            response = session.get(
                ET_SEARCH_URL, headers=HEADERS, params={"limit": 6, "ticker": symbol}, timeout=10
            )
            if response.status_code == 429 or response.status_code == 403:
                if attempt < max_retries:
                    time.sleep(10 * (attempt + 1))
                    continue
                return {"status": "forbidden", "error": f"HTTP {response.status_code}"}
            break
        except Exception as e:
            return {"status": "error", "error": str(e)}
    try:
        if response.status_code != 200:
            return {"status": "error", "error": f"HTTP {response.status_code}"}

        try:
            data = response.json()
        except Exception:
            return {"status": "error", "error": "Invalid JSON response"}

        companies = [c for c in data.get("companies", []) if c.get("companyType") == "equity"]
        if not companies:
            return {"status": "not_found"}

        # Prefer exact NSE-series match (symbol + EQ/BE/...), then any startswith match
        match = None
        for suffix in EQUITY_SUFFIXES:
            for c in companies:
                if str(c.get("symbol", "")).upper() == symbol + suffix:
                    match = c
                    break
            if match:
                break
        if not match:
            for c in companies:
                if str(c.get("symbol", "")).upper().startswith(symbol):
                    match = c
                    break
        if not match and len(companies) == 1:
            match = companies[0]

        if match:
            return {
                "status": "success",
                "symbol": symbol,
                "name": match.get("assetName"),
                "companyid": match.get("assetId"),
                "et_symbol": match.get("symbol"),
                "et_seoname": match.get("assetSeoName"),
            }
        return {"status": "not_found"}
    except Exception as e:
        return {"status": "error", "error": str(e)}


def save_mappings(mappings):
    sorted_mappings = [mappings[sym] for sym in sorted(mappings.keys())]
    temp_file = OUTPUT_FILE + ".tmp"
    try:
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(sorted_mappings, f, indent=2, ensure_ascii=False)
        if os.path.exists(OUTPUT_FILE):
            os.remove(OUTPUT_FILE)
        os.rename(temp_file, OUTPUT_FILE)
    except Exception as e:
        print(f"Error saving mappings: {e}")


def main():
    all_symbols = sorted(load_stocklist_symbols())
    if not all_symbols:
        print("Error: No symbols found. Please verify stocklist.json exists.")
        sys.exit(1)

    print(f"Total unique symbols to fetch: {len(all_symbols)}")

    mappings = get_existing_mappings()
    symbols_to_fetch = [s for s in all_symbols if s not in mappings]
    print(f"Symbols remaining to fetch: {len(symbols_to_fetch)}")

    if not symbols_to_fetch:
        print("All symbols have already been fetched!")
        return

    max_workers = 5
    print(f"Starting fetch with {max_workers} threads...")
    session = requests.Session()

    count = 0
    total = len(symbols_to_fetch)
    success_count = 0
    not_found_count = 0
    error_count = 0

    def worker_task(sym):
        time.sleep(0.2)
        return sym, fetch_et_data(sym, session)

    try:
        with ThreadPoolExecutor(max_workers=max_workers) as executor:
            future_to_sym = {executor.submit(worker_task, sym): sym for sym in symbols_to_fetch}

            for future in as_completed(future_to_sym):
                sym = future_to_sym[future]
                try:
                    symbol, result = future.result()
                    count += 1

                    if result["status"] == "success":
                        mappings[symbol] = {
                            "symbol": symbol,
                            "name": result["name"],
                            "companyid": result["companyid"],
                            "et_symbol": result["et_symbol"],
                            "et_seoname": result["et_seoname"],
                        }
                        success_count += 1
                        print(f"[{count}/{total}] {symbol} -> companyid: {result['companyid']}")
                    elif result["status"] == "not_found":
                        not_found_count += 1
                        print(f"[{count}/{total}] {symbol} -> NOT FOUND")
                    elif result["status"] == "forbidden":
                        error_count += 1
                        print(f"[{count}/{total}] {symbol} -> BLOCKED. Skipping -- will retry on next run.")
                    else:
                        error_count += 1
                        print(f"[{count}/{total}] {symbol} -> ERROR: {result.get('error')}")

                    if count % 20 == 0:
                        save_mappings(mappings)

                except KeyboardInterrupt:
                    print("\nFetch interrupted by user. Saving progress...")
                    save_mappings(mappings)
                    raise
                except Exception as exc:
                    print(f"{sym} generated an exception: {exc}")

    finally:
        save_mappings(mappings)
        print("\n--- Summary ---")
        print(f"Total symbols processed: {count}")
        print(f"Successful mappings: {success_count}")
        print(f"Symbols not found: {not_found_count}")
        print(f"Errors: {error_count}")
        print(f"Total mappings in file: {len(mappings)}")
        print(f"Output saved to: {OUTPUT_FILE}")


if __name__ == "__main__":
    main()
