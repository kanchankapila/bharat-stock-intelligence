#!/usr/bin/env python3
import os
import json
import csv
import time
import sys
from concurrent.futures import ThreadPoolExecutor, as_completed
import requests

# Target outputs
OUTPUT_FILE = os.path.join(os.path.dirname(__file__), "finology_mappings.json")
STOCKLIST_FILE = os.path.join(os.path.dirname(__file__), "stocklist.json")

# NSE equities list URL
NSE_EQUITIES_URL = "https://archives.nseindia.com/content/equities/EQUITY_L.csv"

# Finology search endpoint
FINOLOGY_SEARCH_URL = "https://ticker.finology.in/GetSearchData.ashx"

# Request headers for Finology to bypass 403 Forbidden
HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Referer": "https://ticker.finology.in/",
    "X-Requested-With": "XMLHttpRequest",
    "Accept": "*/*",
    "Accept-Language": "en-US,en;q=0.9",
}

# Request headers for NSE
NSE_HEADERS = {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,image/apng,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
}

def load_stocklist_symbols():
    """Load stock symbols from local stocklist.json"""
    symbols = set()
    if os.path.exists(STOCKLIST_FILE):
        try:
            with open(STOCKLIST_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                for entry in data:
                    sym = entry.get("symbol")
                    if sym:
                        symbols.add(sym.strip().upper())
            print(f"Loaded {len(symbols)} symbols from local stocklist.json")
        except Exception as e:
            print(f"Warning: Could not read stocklist.json: {e}")
    else:
        print("Warning: stocklist.json not found")
    return symbols

def fetch_nse_symbols():
    """Fetch active equities from NSE archive CSV"""
    symbols = set()
    print("Attempting to fetch latest NSE equities list...")
    try:
        response = requests.get(NSE_EQUITIES_URL, headers=NSE_HEADERS, timeout=15)
        if response.status_code == 200:
            lines = response.text.splitlines()
            reader = csv.reader(lines)
            header = next(reader)
            # Find the symbol column (usually first, indexed as 0)
            symbol_idx = 0
            for i, col in enumerate(header):
                if "symbol" in col.lower():
                    symbol_idx = i
                    break
            
            for row in reader:
                if row and len(row) > symbol_idx:
                    sym = row[symbol_idx].strip().upper()
                    if sym and sym != "SYMBOL":
                        symbols.add(sym)
            print(f"Successfully fetched {len(symbols)} symbols from NSE EQUITY_L.csv")
        else:
            print(f"Warning: NSE URL returned status code {response.status_code}")
    except Exception as e:
        print(f"Warning: Failed to fetch symbols from NSE: {e}")
    return symbols

def get_existing_mappings():
    """Load already fetched mappings to support resume functionality"""
    mappings = {}
    if os.path.exists(OUTPUT_FILE):
        try:
            with open(OUTPUT_FILE, "r", encoding="utf-8") as f:
                data = json.load(f)
                # Handle list of dicts format
                if isinstance(data, list):
                    for entry in data:
                        sym = entry.get("symbol")
                        if sym:
                            mappings[sym.upper()] = entry
                elif isinstance(data, dict):
                    # Handle dict format
                    for sym, entry in data.items():
                        mappings[sym.upper()] = entry
            print(f"Loaded {len(mappings)} existing mappings from {OUTPUT_FILE}")
        except Exception as e:
            print(f"Warning: Failed to read existing mappings: {e}")
    return mappings

def fetch_finology_data(symbol, session):
    """Query finology for a single symbol and extract fincode/scripcode"""
    try:
        params = {"q": symbol}
        response = session.get(FINOLOGY_SEARCH_URL, headers=HEADERS, params=params, timeout=10)
        if response.status_code == 403:
            return {"status": "forbidden", "error": "403 Forbidden"}
        elif response.status_code != 200:
            return {"status": "error", "error": f"HTTP {response.status_code}"}
        
        try:
            results = response.json()
        except Exception:
            # Check if response contains HTML error page
            if "Forbidden" in response.text or "Access is denied" in response.text:
                return {"status": "forbidden", "error": "403 Forbidden Page"}
            return {"status": "error", "error": "Invalid JSON response"}
            
        if not results:
            return {"status": "not_found"}
            
        # Try to find exact symbol match
        exact_match = None
        for item in results:
            item_symbol = str(item.get("SYMBOL", "")).strip().upper()
            if item_symbol == symbol:
                exact_match = item
                break
                
        # If no exact symbol match, find case-insensitive contains or any first entry
        if not exact_match:
            for item in results:
                item_symbol = str(item.get("SYMBOL", "")).strip().upper()
                if symbol in item_symbol or item_symbol in symbol:
                    exact_match = item
                    break
                    
        # Fallback to first entry if only one entry is returned
        if not exact_match and len(results) == 1:
            exact_match = results[0]
            
        if exact_match:
            return {
                "status": "success",
                "symbol": symbol,
                "compname": exact_match.get("compname"),
                "fincode": exact_match.get("FINCODE"),
                "scripcode": exact_match.get("SCRIPCODE"),
                "raw_symbol": exact_match.get("SYMBOL")
            }
        
        return {"status": "not_found"}
    except Exception as e:
        return {"status": "error", "error": str(e)}

def save_mappings(mappings):
    """Save mappings dict to Output File as a sorted list"""
    sorted_mappings = [mappings[sym] for sym in sorted(mappings.keys())]
    try:
        # Create temp file and rename to avoid corruption
        temp_file = OUTPUT_FILE + ".tmp"
        with open(temp_file, "w", encoding="utf-8") as f:
            json.dump(sorted_mappings, f, indent=2)
        if os.path.exists(OUTPUT_FILE):
            os.remove(OUTPUT_FILE)
        os.rename(temp_file, OUTPUT_FILE)
    except Exception as e:
        print(f"Error saving mappings: {e}")

def main():
    # 1. Gather all symbols
    stocklist_symbols = load_stocklist_symbols()
    nse_symbols = fetch_nse_symbols()
    
    all_symbols = sorted(list(stocklist_symbols.union(nse_symbols)))
    if not all_symbols:
        print("Error: No symbols found. Please verify stocklist.json exists or check internet connection.")
        sys.exit(1)
        
    print(f"Total unique symbols to fetch: {len(all_symbols)}")
    
    # 2. Get already fetched mappings
    mappings = get_existing_mappings()
    
    # Filter symbols that need fetching
    symbols_to_fetch = [s for s in all_symbols if s not in mappings]
    print(f"Symbols remaining to fetch: {len(symbols_to_fetch)}")
    
    if not symbols_to_fetch:
        print("All symbols have already been fetched!")
        return

    # 3. Fetch mappings using ThreadPool
    max_workers = 5
    print(f"Starting fetch with {max_workers} threads...")
    
    session = requests.Session()
    # Establish session by visiting home page first
    try:
        session.get("https://ticker.finology.in/", headers={"User-Agent": HEADERS["User-Agent"]}, timeout=10)
    except Exception as e:
        print(f"Warning: Failed to pre-fetch home page: {e}")
        
    count = 0
    total = len(symbols_to_fetch)
    success_count = 0
    not_found_count = 0
    error_count = 0
    
    # Simple delay function for rate limiting (0.2s between launches)
    def worker_task(sym):
        time.sleep(0.2)
        return sym, fetch_finology_data(sym, session)
        
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
                            "name": result["compname"],
                            "fincode": result["fincode"],
                            "scripcode": result["scripcode"],
                            "finology_symbol": result["raw_symbol"]
                        }
                        success_count += 1
                        print(f"[{count}/{total}] {symbol} -> Fincode: {result['fincode']}, Scripcode: {result['scripcode']}")
                    elif result["status"] == "not_found":
                        not_found_count += 1
                        print(f"[{count}/{total}] {symbol} -> NOT FOUND")
                    elif result["status"] == "forbidden":
                        print(f"[{count}/{total}] {symbol} -> BLOCKED (403 Forbidden). Stopping fetch.")
                        # Save current state and exit
                        save_mappings(mappings)
                        sys.exit(1)
                    else:
                        error_count += 1
                        print(f"[{count}/{total}] {symbol} -> ERROR: {result.get('error')}")
                        
                    # Periodically save mappings (every 20 items)
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
