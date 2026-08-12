#!/usr/bin/env python3
import requests
import json
import time
import argparse
import sys
import os
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect as db_connect
from sql_translate import use_postgres

RATE_LIMIT_SEC = 0.5
TIMEOUT = 15

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/124.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
    "Referer": "https://kayal.trendlyne.com/",
}

ALIASES = {
    "current_url": ["current_url", "current url", "url"],
    "primary_exchange": ["primary_exchange", "primary exchange", "exchange"],
    "stock_name": ["get_full_name", "stock", "stock_name", "name", "stock name"],
    "symbol": ["nsecode", "nse symbol", "nse_code", "symbol", "nse"],
    "bse_code": ["bsecode", "bse_code", "bse code", "bse"],
    "stock_id": ["stock_id", "stock id", "id"],
    "isin": ["isin", "isin code", "isin_code"],
    "ema_20": ["ema_20", "ema20", "day ema20", "day_ema20"],
    "ema_200": ["ema_200", "ema200", "day ema200", "day_ema200"],
    "current_price": ["currentprice", "current price", "ltp", "price"],
    "market_cap": ["mcap_q", "market capitalization", "market cap", "mcap"],
    "pe_ttm": ["pe_ttm", "pe ttm", "pe ttm price to earnings", "pe"],
    "pbv_a": ["pbv_a", "pbv adjusted", "price to book value adjusted", "pbv", "pb"],
    "rev_qoq_growth": ["rev1q_q", "revenue qoq growth %", "revenue qoq growth", "revenue growth"],
    "net_profit_qoq_growth": ["ni1q_q", "net profit qoq growth %", "net profit qoq growth", "profit growth"],
    "knse_token": ["client3_nse_code", "kayal nse code", "knsecode", "knsetoken"],
    "kbse_token": ["client3_bse_code", "kayal bse code", "kbsecode", "kbsetoken"]
}

def setup_db(conn):
    if use_postgres():
        conn.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_screener_stocks_extracted (
            id                      SERIAL PRIMARY KEY,
            screener_id             TEXT,
            screener_name           TEXT,
            query_text              TEXT,
            stock_id                INTEGER,
            symbol                  TEXT,
            bse_code                TEXT,
            stock_name              TEXT,
            isin                    TEXT,
            current_price           DOUBLE PRECISION,
            market_cap              DOUBLE PRECISION,
            pe_ttm                  DOUBLE PRECISION,
            pbv_a                   DOUBLE PRECISION,
            rev_qoq_growth          DOUBLE PRECISION,
            net_profit_qoq_growth   DOUBLE PRECISION,
            ema_20                  DOUBLE PRECISION,
            ema_200                 DOUBLE PRECISION,
            knse_token              TEXT,
            kbse_token              TEXT,
            current_url             TEXT,
            flag_label              TEXT,
            flag_shorttext          TEXT,
            flag_url                TEXT,
            flag_url_with_domain    TEXT,
            flag_color              TEXT,
            all_flags_json          TEXT,
            fetched_at              TEXT,
            response_id             INTEGER
        )
        """)
    else:
        conn.execute("""
        CREATE TABLE IF NOT EXISTS trendlyne_screener_stocks_extracted (
            id                      INTEGER PRIMARY KEY AUTOINCREMENT,
            screener_id             TEXT,
            screener_name           TEXT,
            query_text              TEXT,
            stock_id                INTEGER,
            symbol                  TEXT,
            bse_code                TEXT,
            stock_name              TEXT,
            isin                    TEXT,
            current_price           REAL,
            market_cap              REAL,
            pe_ttm                  REAL,
            pbv_a                   REAL,
            rev_qoq_growth          REAL,
            net_profit_qoq_growth   REAL,
            ema_20                  REAL,
            ema_200                 REAL,
            knse_token              TEXT,
            kbse_token              TEXT,
            current_url             TEXT,
            flag_label              TEXT,
            flag_shorttext          TEXT,
            flag_url                TEXT,
            flag_url_with_domain    TEXT,
            flag_color              TEXT,
            all_flags_json          TEXT,
            fetched_at              TEXT,
            response_id             INTEGER
        )
        """)
    conn.commit()

def find_col_idx(headers, field_key):
    possible_names = ALIASES[field_key]
    for i, h in enumerate(headers):
        if isinstance(h, dict):
            u_name = str(h.get("unique_name") or "").lower()
            name = str(h.get("name") or "").lower()
            if u_name in possible_names or name in possible_names:
                return i
        elif isinstance(h, str):
            if h.lower() in possible_names:
                return i
    return None

def clean_float(val):
    if val is None or val == "" or val == "-":
        return None
    try:
        return float(val)
    except ValueError:
        return None

def clean_str(val):
    if val is None or val == "":
        return None
    return str(val).strip()

def main():
    parser = argparse.ArgumentParser(description="Trendlyne Screener Live Extractor")
    parser.add_argument("--limit", type=int, default=None, help="Limit number of screeners to fetch")
    args = parser.parse_args()

    conn = db_connect()
    setup_db(conn)

    rows = conn.execute("""
        SELECT id, url, fetched_at 
        FROM api_responses 
        WHERE url LIKE 'https://kayal.trendlyne.com/%'
          AND category = 'screeners'
          AND http_status = 200
        ORDER BY id
    """).fetchall()
    
    if args.limit:
        rows = rows[:args.limit]
        print(f"Limiting fetch to the first {args.limit} screeners.")

    total_screeners = len(rows)
    print(f"Processing {total_screeners} screener API endpoints...")

    inserted_count = 0
    start_time = time.time()

    for idx, (resp_id, url, fetched_at) in enumerate(rows):
        print(f"\n[{idx + 1}/{total_screeners}] Fetching: {url[:100]}...")
        time.sleep(RATE_LIMIT_SEC)

        try:
            res = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
            if res.status_code != 200:
                print(f"  [ERROR] Failed with HTTP Status {res.status_code}")
                continue
            data = res.json()
        except Exception as e:
            print(f"  [ERROR] Request/JSON parse failed: {e}")
            continue

        body = data.get("body", {})
        table_headers = body.get("tableHeaders", [])
        table_data = body.get("tableData", [])

        if not table_headers or not table_data:
            print("  [WARNING] Empty table data or headers. Skipping.")
            continue

        screen_obj = body.get("screenObj", {})
        screener_name = screen_obj.get("title") or "Unknown Screener"
        screener_id = str(screen_obj.get("screenId") or "")
        query_text = screen_obj.get("query") or ""

        if not screener_id or screener_id == "":
            if "screenpk=" in url:
                parts = url.split("screenpk=")
                if len(parts) > 1:
                    screener_id = parts[1].split("&")[0]

        print(f"  [INFO] Screener: '{screener_name}' (ID: {screener_id}) | Stocks: {len(table_data)}")
        indices = {field_key: find_col_idx(table_headers, field_key) for field_key in ALIASES.keys()}
        stocks_meta = body.get("stocksMetaData", {})

        screener_stocks = []
        for row_data in table_data:
            if not isinstance(row_data, (list, tuple)):
                continue
            row_len = len(row_data)

            def get_val(key):
                col_idx = indices.get(key)
                if col_idx is not None and col_idx < row_len:
                    return row_data[col_idx]
                return None

            stk_id = get_val("stock_id")
            if stk_id is None:
                continue

            stock_id_str = str(stk_id)
            symbol = clean_str(get_val("symbol"))
            bse_code = clean_str(get_val("bse_code"))
            stock_name = clean_str(get_val("stock_name"))
            isin = clean_str(get_val("isin"))
            current_url = clean_str(get_val("current_url"))
            current_price = clean_float(get_val("current_price"))
            market_cap = clean_float(get_val("market_cap"))
            pe_ttm = clean_float(get_val("pe_ttm"))
            pbv_a = clean_float(get_val("pbv_a"))
            rev_qoq_growth = clean_float(get_val("rev_qoq_growth"))
            net_profit_qoq_growth = clean_float(get_val("net_profit_qoq_growth"))
            ema_20 = clean_float(get_val("ema_20"))
            ema_200 = clean_float(get_val("ema_200"))
            knse_token = clean_str(get_val("knse_token"))
            kbse_token = clean_str(get_val("kbse_token"))

            flag_label = flag_shorttext = flag_url = flag_url_with_domain = flag_color = all_flags_json = None
            stock_meta = stocks_meta.get(stock_id_str, {})
            if stock_meta:
                flag_data = stock_meta.get("flagData", [])
                if flag_data:
                    all_flags_json = json.dumps(flag_data)
                    first_flag = flag_data[0]
                    if isinstance(first_flag, dict):
                        flag_label = clean_str(first_flag.get("label"))
                        flag_shorttext = clean_str(first_flag.get("shorttext"))
                        flag_url = clean_str(first_flag.get("url"))
                        flag_url_with_domain = clean_str(first_flag.get("urlWithDomain"))
                        flag_color = clean_str(first_flag.get("color"))

            # Upsert behavior
            conn.execute("""
                DELETE FROM trendlyne_screener_stocks_extracted 
                WHERE screener_id = ? AND stock_id = ?
            """, (screener_id, int(stk_id)))

            screener_stocks.append((
                screener_id, screener_name, query_text, int(stk_id), symbol, bse_code,
                stock_name, isin, current_price, market_cap, pe_ttm, pbv_a,
                rev_qoq_growth, net_profit_qoq_growth, ema_20, ema_200,
                knse_token, kbse_token, current_url, flag_label, flag_shorttext,
                flag_url, flag_url_with_domain, flag_color, all_flags_json,
                fetched_at, resp_id
            ))

        if screener_stocks:
            conn.executemany("""
                INSERT INTO trendlyne_screener_stocks_extracted (
                    screener_id, screener_name, query_text, stock_id, symbol, bse_code,
                    stock_name, isin, current_price, market_cap, pe_ttm, pbv_a,
                    rev_qoq_growth, net_profit_qoq_growth, ema_20, ema_200,
                    knse_token, kbse_token, current_url, flag_label, flag_shorttext,
                    flag_url, flag_url_with_domain, flag_color, all_flags_json,
                    fetched_at, response_id
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            """, screener_stocks)
            conn.commit()
            inserted_count += len(screener_stocks)
            print(f"  [SUCCESS] Extracted & stored {len(screener_stocks)} stock records.")

    conn.close()
    elapsed = time.time() - start_time
    print(f"\n[INFO] Extraction Complete! Successfully populated {inserted_count} rows.")
    print(f"[INFO] Total Time Elapsed: {elapsed:.2f} seconds.")

if __name__ == "__main__":
    main()
