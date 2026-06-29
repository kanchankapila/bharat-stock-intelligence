#!/usr/bin/env python3
import sqlite3
import json
import os
import sys

db_path = "mc_tl_explore.db"

if not os.path.exists(db_path):
    print(f"Error: {db_path} not found in current directory.")
    sys.exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# Drop existing table to ensure a clean slate and prevent schema conflicts
cursor.execute("DROP TABLE IF EXISTS trendlyne_screener_stocks_extracted")

# Create the extraction table
cursor.execute("""
CREATE TABLE trendlyne_screener_stocks_extracted (
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
    response_id             INTEGER,
    FOREIGN KEY(response_id) REFERENCES api_responses(id) ON DELETE CASCADE
)
""")
conn.commit()

# Field name aliases for bulletproof column matching
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

def find_col_idx(headers, field_key):
    possible_names = ALIASES[field_key]
    for i, h in enumerate(headers):
        if isinstance(h, dict):
            u_name = h.get("unique_name", "").lower()
            name = h.get("name", "").lower()
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

# Query all Trendlyne screener api responses
cursor.execute("""
    SELECT id, url, raw_json, fetched_at 
    FROM api_responses 
    WHERE (domain = 'kayal_trendlyne' OR domain = 'trendlyne')
      AND category = 'screeners'
      AND http_status = 200
""")

api_rows = cursor.fetchall()
print(f"Found {len(api_rows)} Trendlyne screener responses in api_responses.")

extracted_rows = []

for resp_id, url, raw_json, fetched_at in api_rows:
    if not raw_json:
        continue
    try:
        data = json.loads(raw_json)
    except Exception as e:
        # Invalid JSON
        continue
        
    body = data.get("body", {})
    if not body:
        continue
        
    # Get tableHeaders and tableData
    table_headers = body.get("tableHeaders", [])
    table_data = body.get("tableData", [])
    if not table_headers or not table_data:
        continue
        
    # Get screener object info
    screen_obj = body.get("screenObj", {})
    screener_name = screen_obj.get("title") or "Unknown"
    screener_id = str(screen_obj.get("screenId") or "")
    query_text = screen_obj.get("query")
    
    # Try to parse screener_id from URL if not found in screenObj
    if not screener_id or screener_id == "":
        # Look for screenpk in URL query params
        if "screenpk=" in url:
            parts = url.split("screenpk=")
            if len(parts) > 1:
                screener_id = parts[1].split("&")[0]
                
    # Build header indices mapping
    indices = {}
    for field_key in ALIASES.keys():
        indices[field_key] = find_col_idx(table_headers, field_key)
        
    # Get stocksMetaData (flags, Dividends, upgrades, etc.)
    stocks_meta = body.get("stocksMetaData", {})
    
    for row in table_data:
        if not isinstance(row, (list, tuple)):
            continue
            
        row_len = len(row)
        
        # Helper to safely retrieve value from row
        def get_row_val(field_key):
            idx = indices.get(field_key)
            if idx is not None and idx < row_len:
                return row[idx]
            return None

        # Extract values
        stk_id = get_row_val("stock_id")
        if stk_id is None:
            continue
            
        stock_id_str = str(stk_id)
        
        # Extract stock identity
        symbol = clean_str(get_row_val("symbol"))
        bse_code = clean_str(get_row_val("bse_code"))
        stock_name = clean_str(get_row_val("stock_name"))
        isin = clean_str(get_row_val("isin"))
        current_url = clean_str(get_row_val("current_url"))
        
        # Extract indicators
        current_price = clean_float(get_row_val("current_price"))
        market_cap = clean_float(get_row_val("market_cap"))
        pe_ttm = clean_float(get_row_val("pe_ttm"))
        pbv_a = clean_float(get_row_val("pbv_a"))
        rev_qoq_growth = clean_float(get_row_val("rev_qoq_growth"))
        net_profit_qoq_growth = clean_float(get_row_val("net_profit_qoq_growth"))
        ema_20 = clean_float(get_row_val("ema_20"))
        ema_200 = clean_float(get_row_val("ema_200"))
        
        # Extract broker tokens
        knse_token = clean_str(get_row_val("knse_token"))
        kbse_token = clean_str(get_row_val("kbse_token"))
        
        # Flag and Catalysts extraction
        flag_label = None
        flag_shorttext = None
        flag_url = None
        flag_url_with_domain = None
        flag_color = None
        all_flags_json = None
        
        # Look up stock_id in metadata
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
                    
        extracted_rows.append((
            screener_id,
            screener_name,
            query_text,
            int(stk_id),
            symbol,
            bse_code,
            stock_name,
            isin,
            current_price,
            market_cap,
            pe_ttm,
            pbv_a,
            rev_qoq_growth,
            net_profit_qoq_growth,
            ema_20,
            ema_200,
            knse_token,
            kbse_token,
            current_url,
            flag_label,
            flag_shorttext,
            flag_url,
            flag_url_with_domain,
            flag_color,
            all_flags_json,
            fetched_at,
            resp_id
        ))

# Batch insertion into SQLite
batch_size = 500
total_inserted = 0

for i in range(0, len(extracted_rows), batch_size):
    batch = extracted_rows[i:i+batch_size]
    cursor.executemany("""
        INSERT INTO trendlyne_screener_stocks_extracted (
            screener_id, screener_name, query_text, stock_id, symbol, bse_code,
            stock_name, isin, current_price, market_cap, pe_ttm, pbv_a,
            rev_qoq_growth, net_profit_qoq_growth, ema_20, ema_200,
            knse_token, kbse_token, current_url, flag_label, flag_shorttext,
            flag_url, flag_url_with_domain, flag_color, all_flags_json,
            fetched_at, response_id
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    """, batch)
    conn.commit()
    total_inserted += len(batch)

print(f"Successfully extracted and inserted {total_inserted} stock rows into trendlyne_screener_stocks_extracted table in {db_path}!")
conn.close()
