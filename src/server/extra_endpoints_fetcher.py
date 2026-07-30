#!/usr/bin/env python3
"""
Extra Endpoints Fetcher
=======================
Fetches data from validated parser-ready financial endpoints
using companyid and stockid (sid) from scripts/stocklist.json.
Stores responses in the 'extra_endpoint_responses' table.

Usage:
  python src/server/extra_endpoints_fetcher.py           # Fetch all stocks
  python src/server/extra_endpoints_fetcher.py --limit 5  # Fetch only 5 stocks (for testing)
  python src/server/extra_endpoints_fetcher.py --symbol BEL # Fetch a specific stock
  python src/server/extra_endpoints_fetcher.py --registry-only # Validate/sync endpoint registry only
"""

import argparse
import json
import os
import sys
import urllib.request
import ssl
from concurrent.futures import ThreadPoolExecutor, as_completed
from datetime import datetime
from db_compat import connect
from endpoint_registry import (
    ensure_endpoint_registry_schema,
    get_fetchable_endpoints,
    load_endpoint_registry,
    registry_summary,
    render_endpoint_url,
    sync_registry_to_db,
)

# HTTP fetch is I/O-bound; a bounded thread pool turns ~20k sequential requests
# (2-3h, overran the queue's 30-min budget) into a run that fits. Override via env.
MAX_WORKERS = int(os.environ.get("EXTRA_ENDPOINTS_WORKERS", "8"))

STOCKLIST_PATH = os.path.join(os.path.dirname(__file__), "..", "..", "scripts", "stocklist.json")

def ensure_schema(con) -> None:
    cur = con.cursor()
    cur.execute("""
        CREATE TABLE IF NOT EXISTS extra_endpoint_responses (
            symbol TEXT NOT NULL,
            endpoint_name TEXT NOT NULL,
            response_json TEXT,
            updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
            PRIMARY KEY (symbol, endpoint_name)
        )
    """)
    ensure_endpoint_registry_schema(cur)
    con.commit()

def fetch_url(url: str) -> str:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    # 20s, not 10s: Tapetide's api.tapetide.com (promoted 2026-07-30) live-verified needing
    # 10-20s under this fetcher's real 8-worker concurrent load -- 10s silently dropped every
    # tapetide_* fetch (confirmed: 0 rows written, no error surfaced beyond a log line).
    with urllib.request.urlopen(req, context=ctx, timeout=20) as response:
        return response.read().decode('utf-8')

def save_response(cur, symbol: str, endpoint_name: str, data: str) -> None:
    """Write one response. Caller owns the cursor and commits (batched)."""
    cur.execute("""
        DELETE FROM extra_endpoint_responses
        WHERE symbol = ? AND endpoint_name = ?
    """, (symbol, endpoint_name))
    cur.execute("""
        INSERT INTO extra_endpoint_responses (symbol, endpoint_name, response_json, updated_at)
        VALUES (?, ?, ?, ?)
    """, (symbol, endpoint_name, data, datetime.now().isoformat()))

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--symbol", type=str, help="Fetch a single stock by Symbol (e.g. BEL)")
    parser.add_argument("--limit", type=int, help="Limit number of stocks fetched")
    parser.add_argument("--registry-only", action="store_true", help="Validate/sync endpoint registry without fetching")
    args = parser.parse_args()

    # Load stocks
    if not os.path.exists(STOCKLIST_PATH):
        print(f"Error: stocklist.json not found at {STOCKLIST_PATH}")
        sys.exit(1)

    with open(STOCKLIST_PATH, "r", encoding="utf-8") as f:
        stocks = json.load(f)

    if args.symbol:
        stocks = [s for s in stocks if s.get("symbol", "").upper() == args.symbol.upper()]
        if not stocks:
            print(f"No stock found matching symbol: {args.symbol}")
            sys.exit(1)

    if args.limit:
        stocks = stocks[:args.limit]

    # Initialize connection
    con = connect()
    ensure_schema(con)
    cur = con.cursor()
    registry_entries = load_endpoint_registry(
        os.environ.get("AI_ENDPOINT_MEMORY_PATH"),
        os.environ.get("AI_ENDPOINT_REFERENCE_PATH"),
    )
    synced = sync_registry_to_db(cur, registry_entries)
    con.commit()
    summary = registry_summary(registry_entries)
    print(
        "[REGISTRY] Synced "
        f"{synced} endpoints: {summary['curated']} curated, {summary['ai_memory']} from ai_endpoint_memory.json, "
        f"{summary['valid']} valid, {summary['fetchable']} parser-ready fetchable"
    )
    stock_endpoints, market_endpoints = get_fetchable_endpoints(registry_entries)
    if args.registry_only:
        con.close()
        return

    # Fetch market-wide endpoints first (only 2 — keep sequential)
    print("Fetching market-wide endpoints...")
    for endpoint in market_endpoints:
        try:
            name = endpoint.name
            url = render_endpoint_url(endpoint)
            if not url:
                print(f"Skipping {name}: could not render URL")
                continue
            print(f"Fetching {name}...")
            data = fetch_url(url)
            save_response(cur, "MARKET", name, data)
        except Exception as e:
            print(f"Error fetching market-wide endpoint {endpoint.name}: {e}")
    con.commit()

    # Build the full request list up front, skipping rows missing the id a template needs.
    tasks = []  # (symbol, endpoint_name, url)
    for stock in stocks:
        symbol = stock.get("symbol")
        if not symbol:
            continue
        for endpoint in stock_endpoints:
            url = render_endpoint_url(endpoint, stock)
            if not url:
                continue
            tasks.append((symbol, endpoint.name, url))

    print(f"Fetching {len(tasks)} stock-endpoint requests across {len(stocks)} stocks "
          f"with {MAX_WORKERS} workers...")

    # Fetch concurrently (I/O-bound), write on the main thread with batched commits.
    done = 0
    with ThreadPoolExecutor(max_workers=MAX_WORKERS) as ex:
        future_map = {ex.submit(fetch_url, url): (symbol, name)
                      for (symbol, name, url) in tasks}
        for fut in as_completed(future_map):
            symbol, name = future_map[fut]
            try:
                data = fut.result()
                save_response(cur, symbol, name, data)
            except Exception as e:
                print(f"  Error fetching {name} for {symbol}: {e}")
            done += 1
            if done % 500 == 0:
                con.commit()
                print(f"  Progress: {done}/{len(tasks)} requests done")

    con.commit()
    con.close()
    print("Fetching completed successfully.")

    # Parse and update features in technical_signals
    print("Parsing features and updating technical_signals...")
    try:
        import extra_features_parser
        extra_features_parser.run(datetime.today().strftime("%Y-%m-%d"))
    except Exception as e:
        print(f"Error parsing features: {e}")

if __name__ == "__main__":
    main()
