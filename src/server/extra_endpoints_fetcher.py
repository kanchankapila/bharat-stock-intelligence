#!/usr/bin/env python3
"""
Extra Endpoints Fetcher
=======================
Fetches data from 12 financial endpoints (Indiatimes, MarketsMojo, Trading80)
using companyid and stockid (sid) from scripts/stocklist.json.
Stores responses in the 'extra_endpoint_responses' table.

Usage:
  python src/server/extra_endpoints_fetcher.py           # Fetch all stocks
  python src/server/extra_endpoints_fetcher.py --limit 5  # Fetch only 5 stocks (for testing)
  python src/server/extra_endpoints_fetcher.py --symbol BEL # Fetch a specific stock
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

# HTTP fetch is I/O-bound; a bounded thread pool turns ~20k sequential requests
# (2-3h, overran the queue's 30-min budget) into a run that fits. Override via env.
MAX_WORKERS = int(os.environ.get("EXTRA_ENDPOINTS_WORKERS", "8"))

# Endpoints Config
STOCK_ENDPOINTS = {
    "marketservices_shareholding": "https://marketservices.indiatimes.com/marketservices/shareholding?companyid={companyid}",
    "mfapps_mfsInvestingInStock": "https://mfapps.indiatimes.com/Ulip/mfsInvestingInStock.htm?pagesize=25&sortby=numberOfSharesHeld&companyid={companyid}&marketcap=&callback=ajaxResponse&pageno=1",
    "et_companypagedata": "https://json.bselivefeeds.indiatimes.com/ET_Community/companypagedata?companyid={companyid}",
    "et_bsensejson": "https://json.bselivefeeds.indiatimes.com/ET_Community/bsensejson?companyid={companyid}",
    "trading80_header_info": "https://frapi.trading80.com/stocks_stocksid/header_info?sid={stockid}&exchange=0",
    "trading80_technical_card": "https://www.trading80.com/technical_card/getCardInfo?sid={stockid}&se=bse&cardlist=sectPrice_techScore,sectPrice_indiScale,sectIndigraph_graph,sectMacd_macd_w,sectMacd_macd_m,sectRsi_rsi_w,sectRsi_rsi_m,sectBb_bb_w,sectBb_bb_m,sectMa_ma_w,sectKst_kst_w,sectKst_kst_m,sectDow_dow_w,sectDow_dow_m,sectObv_obv_w,sectObv_obv_m",
    "marketsmojo_quality_vcard": "https://frapi.marketsmojo.com/stocks_quality/vcardinfo?sid={stockid}",
    "marketsmojo_thingsknow": "https://frapi.marketsmojo.com/Stocks_Thingsknow/thingsknow?sid={stockid}&exchange=0",
    "marketsmojo_return_contribution": "https://frapi.marketsmojo.com/stocks_Stocksid/returnContri_info?se=&cardlist=&period=&alphabet=&sid={stockid}&stockID={stockid}&exchange=0&",
    "marketsmojo_header_info": "https://frapi.marketsmojo.com/stocks_stocksid/header_info?sid={stockid}&exchange=0"
}

MARKET_ENDPOINTS = {
    "marketsmojo_marketaction": "https://frapi.marketsmojo.com/market_marketaction/getData?",
    "trading80_call_alerts": "https://frapi.trading80.com/callsapi/getCallAlerts?w=yes"
}

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
    con.commit()

def fetch_url(url: str) -> str:
    ctx = ssl.create_default_context()
    ctx.check_hostname = False
    ctx.verify_mode = ssl.CERT_NONE
    req = urllib.request.Request(url, headers={'User-Agent': 'Mozilla/5.0'})
    with urllib.request.urlopen(req, context=ctx, timeout=10) as response:
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

    # Fetch market-wide endpoints first (only 2 — keep sequential)
    print("Fetching market-wide endpoints...")
    for name, url in MARKET_ENDPOINTS.items():
        try:
            print(f"Fetching {name}...")
            data = fetch_url(url)
            save_response(cur, "MARKET", name, data)
        except Exception as e:
            print(f"Error fetching market-wide endpoint {name}: {e}")
    con.commit()

    # Build the full request list up front, skipping rows missing the id a template needs.
    tasks = []  # (symbol, endpoint_name, url)
    for stock in stocks:
        symbol = stock.get("symbol")
        companyid = stock.get("companyid")
        stockid = stock.get("stockid")
        if not symbol:
            continue
        for name, url_template in STOCK_ENDPOINTS.items():
            if "{companyid}" in url_template and not companyid:
                continue
            if "{stockid}" in url_template and not stockid:
                continue
            tasks.append((symbol, name, url_template.format(companyid=companyid, stockid=stockid)))

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
