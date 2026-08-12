import re
import os
import sys
import json
import time
import requests
import argparse
from concurrent.futures import ThreadPoolExecutor, as_completed
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect as db_connect
from sql_translate import use_postgres

CONCURRENCY = 15
TIMEOUT = 15

HEADERS = {
    "User-Agent": (
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
        "AppleWebKit/537.36 (KHTML, like Gecko) "
        "Chrome/120.0.0.0 Safari/537.36"
    ),
    "Accept": "application/json, text/plain, */*",
}

def init_db():
    conn = db_connect()
    
    # Drop tables to recreate fresh exploring schema
    conn.execute("DROP TABLE IF EXISTS screeners")
    conn.execute("DROP TABLE IF EXISTS stocks")
    conn.execute("DROP TABLE IF EXISTS screener_results")
    conn.execute("DROP TABLE IF EXISTS stock_metrics")
    
    # Create Tables - Use dialect-aware DDL
    if use_postgres():
        conn.execute("""
        CREATE TABLE screeners (
            screenpk INTEGER PRIMARY KEY,
            title TEXT,
            query TEXT,
            description TEXT,
            last_fetched TEXT
        )
        """)
        conn.execute("""
        CREATE TABLE stocks (
            symbol TEXT PRIMARY KEY,
            name TEXT,
            isin TEXT,
            sector TEXT,
            last_fetched TEXT
        )
        """)
    else:
        conn.execute("""
        CREATE TABLE screeners (
            screenpk INTEGER PRIMARY KEY,
            title TEXT,
            query TEXT,
            description TEXT,
            last_fetched TEXT
        )
        """)
        conn.execute("""
        CREATE TABLE stocks (
            symbol TEXT PRIMARY KEY,
            name TEXT,
            isin TEXT,
            sector TEXT,
            last_fetched TEXT
        )
        """)

    conn.execute("""
    CREATE TABLE screener_results (
        screenpk INTEGER,
        symbol TEXT,
        fetched_date TEXT,
        PRIMARY KEY (screenpk, symbol, fetched_date)
    )
    """)

    conn.execute("""
    CREATE TABLE stock_metrics (
        symbol TEXT,
        date TEXT,
        metric_name TEXT,
        metric_value REAL,
        metric_label TEXT,
        PRIMARY KEY (symbol, date, metric_name)
    )
    """)
    
    conn.commit()
    return conn

def parse_screenpk(url):
    m = re.search(r"screenpk=(\d+)", url)
    return int(m.group(1)) if m else None

def fetch_url(url, screenpk):
    try:
        t0 = time.time()
        res = requests.get(url, headers=HEADERS, timeout=TIMEOUT)
        latency = int((time.time() - t0) * 1000)
        if res.status_code == 200:
            return {"screenpk": screenpk, "data": res.json(), "status": 200, "latency": latency}
        else:
            return {"screenpk": screenpk, "data": None, "status": res.status_code, "latency": latency, "error": f"HTTP {res.status_code}"}
    except Exception as e:
        return {"screenpk": screenpk, "data": None, "status": -1, "latency": 0, "error": str(e)}

def parse_row_value(val):
    if val is None:
        return None, None
    if isinstance(val, (int, float)):
        return float(val), None
    try:
        f_val = float(str(val).strip('%').replace(',', ''))
        return f_val, str(val)
    except ValueError:
        return None, str(val)

def process_results(fetched_data, conn):
    date_today = time.strftime("%Y-%m-%d")
    
    screeners_to_insert = []
    stocks_to_insert = {}
    results_to_insert = []
    metrics_to_insert = {}
    
    for item in fetched_data:
        screenpk = item["screenpk"]
        res_json = item["data"]
        if not res_json or "body" not in res_json:
            continue
            
        body = res_json["body"]
        screen_obj = body.get("screenObj", {})
        title = screen_obj.get("title") or f"Screener {screenpk}"
        query = screen_obj.get("simplifiedQuery") or screen_obj.get("query") or ""
        description = screen_obj.get("description") or ""
        
        screeners_to_insert.append((screenpk, title, query, description, date_today))
        
        headers = body.get("tableHeaders", [])
        data_rows = body.get("tableData", [])
        
        sym_idx = -1
        name_idx = -1
        isin_idx = -1
        sector_idx = -1
        date_idx = -1
        
        for idx, h in enumerate(headers):
            uname = (h.get("unique_name") or "").lower()
            name = (h.get("name") or "").lower()
            
            if uname in ("nsecode", "client3_nse_code", "symbol") or "nse symbol" in name:
                sym_idx = idx
            elif uname in ("get_full_name", "stock", "name") or "stock name" in name:
                name_idx = idx
            elif uname in ("isin", "isin_code") or "isin" in name:
                isin_idx = idx
            elif uname in ("sector_name", "sector") or "sector" in name:
                sector_idx = idx
            elif uname in ("sholding_date", "shareholding date", "date"):
                date_idx = idx
                
        if sym_idx == -1:
            for idx, h in enumerate(headers):
                uname = (h.get("unique_name") or "").lower()
                if "code" in uname or "sym" in uname:
                    sym_idx = idx
                    break
        
        for row in data_rows:
            if not isinstance(row, list) or len(row) < len(headers):
                continue
                
            symbol = row[sym_idx] if sym_idx != -1 else None
            if not symbol or not isinstance(symbol, str) or symbol.strip() == "":
                continue
            symbol = symbol.strip().upper()
            
            name = row[name_idx] if name_idx != -1 else None
            isin = row[isin_idx] if isin_idx != -1 else None
            sector = row[sector_idx] if sector_idx != -1 else None
            
            if symbol not in stocks_to_insert:
                stocks_to_insert[symbol] = {
                    "name": name,
                    "isin": isin,
                    "sector": sector,
                    "last_fetched": date_today
                }
            else:
                if name and not stocks_to_insert[symbol]["name"]:
                    stocks_to_insert[symbol]["name"] = name
                if isin and not stocks_to_insert[symbol]["isin"]:
                    stocks_to_insert[symbol]["isin"] = isin
                if sector and not stocks_to_insert[symbol]["sector"]:
                    stocks_to_insert[symbol]["sector"] = sector
            
            row_date = date_today
            if date_idx != -1 and row[date_idx]:
                row_date = str(row[date_idx]).strip()
                
            results_to_insert.append((screenpk, symbol, row_date))
            
            for col_idx, h in enumerate(headers):
                if col_idx in (sym_idx, name_idx, isin_idx, sector_idx, date_idx):
                    continue
                    
                metric_name = h.get("unique_name")
                if not metric_name:
                    continue
                    
                raw_val = row[col_idx]
                m_val, m_label = parse_row_value(raw_val)
                
                metric_key = (symbol, row_date, metric_name)
                metrics_to_insert[metric_key] = (m_val, m_label)

    # Use ON CONFLICT for Postgres/SQLite compatibility
    # INSERT OR REPLACE -> ON CONFLICT (...) DO UPDATE SET ...
    
    # Insert into screeners
    conn.executemany(
        """INSERT INTO screeners (screenpk, title, query, description, last_fetched)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (screenpk) DO UPDATE SET
             title=EXCLUDED.title, query=EXCLUDED.query,
             description=EXCLUDED.description, last_fetched=EXCLUDED.last_fetched""",
        screeners_to_insert
    )
    
    # Insert into stocks
    stocks_rows = [(sym, d["name"], d["isin"], d["sector"], d["last_fetched"]) for sym, d in stocks_to_insert.items()]
    conn.executemany(
        """INSERT INTO stocks (symbol, name, isin, sector, last_fetched)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (symbol) DO UPDATE SET
             name=EXCLUDED.name, isin=EXCLUDED.isin,
             sector=EXCLUDED.sector, last_fetched=EXCLUDED.last_fetched""",
        stocks_rows
    )
    
    # Insert into screener_results
    # INSERT OR IGNORE -> ON CONFLICT DO NOTHING
    conn.executemany(
        """INSERT INTO screener_results (screenpk, symbol, fetched_date)
           VALUES (?, ?, ?)
           ON CONFLICT DO NOTHING""",
        results_to_insert
    )
    
    # Insert into stock_metrics
    metrics_rows = [(k[0], k[1], k[2], v[0], v[1]) for k, v in metrics_to_insert.items()]
    conn.executemany(
        """INSERT INTO stock_metrics (symbol, date, metric_name, metric_value, metric_label)
           VALUES (?, ?, ?, ?, ?)
           ON CONFLICT (symbol, date, metric_name) DO UPDATE SET
             metric_value=EXCLUDED.metric_value, metric_label=EXCLUDED.metric_label""",
        metrics_rows
    )
    
    conn.commit()
    return len(screeners_to_insert), len(stocks_rows), len(results_to_insert), len(metrics_rows)

def analyze_data_gaps(conn):
    screeners = conn.execute("SELECT screenpk, title, query, description FROM screeners").fetchall()
    
    gap_keywords = {
        "Promoter Pledge": ["pledge", "pledged"],
        "Bulk & Block Deals": ["deal", "block", "bulk", "insider_trades"],
        "Insider Holdings & SAST": ["insider", "sast", "promoter_holding", "promoter holding"],
        "Shareholding Changes (FII/DII/MF)": ["fii", "dii", "mutual fund", "mfpct", "fiipct", "shareholding", "holding"],
        "Analyst Consensus & Ratings": ["analyst", "upside", "target price", "consensus", "reco", "rating"],
        "Earnings & Results": ["earnings", "result", "qtr", "quarterly", "eps"]
    }
    
    gap_matches = {gap: [] for gap in gap_keywords}
    
    for pk, title, query, desc in screeners:
        text = f"{title} {query} {desc}".lower()
        for gap, keywords in gap_keywords.items():
            for kw in keywords:
                if kw in text:
                    gap_matches[gap].append((pk, title))
                    break
                    
    print("\n" + "="*80)
    print("                    DATA GAP ANALYSIS FROM SCREENER INGEST")
    print("="*80)
    for gap, matches in gap_matches.items():
        print(f"\n📂 DATA GAP: {gap} ({len(matches)} screeners match)")
        if not matches:
            print("   - No matching screeners found")
        else:
            for pk, title in matches[:6]:
                print(f"   • [screenpk={pk}] {title}")
            if len(matches) > 6:
                print(f"   • ... and {len(matches) - 6} more screeners")
    print("="*80 + "\n")

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("--limit", type=int, default=None, help="Limit the number of URLs to crawl for testing")
    args = parser.parse_args()
    
    if not os.path.exists("urls.txt"):
        print("[ERROR] urls.txt not found in workspace root.")
        sys.exit(1)
        
    urls = []
    with open("urls.txt", "r") as f:
        for line in f:
            url = line.strip()
            if url:
                pk = parse_screenpk(url)
                if pk:
                    urls.append((url, pk))
                    
    if args.limit:
        print(f"Limiting crawl to first {args.limit} URLs.")
        urls = urls[:args.limit]
        
    print(f"Loaded {len(urls)} unique screeners from urls.txt.")
    
    conn = init_db()
    print("Database initialized successfully via db_compat.")
    
    print(f"Fetching screeners concurrently (concurrency={CONCURRENCY})...")
    fetched_results = []
    
    with ThreadPoolExecutor(max_workers=CONCURRENCY) as executor:
        future_to_url = {executor.submit(fetch_url, url, pk): (url, pk) for url, pk in urls}
        
        count = 0
        success_count = 0
        for future in as_completed(future_to_url):
            url, pk = future_to_url[future]
            try:
                res = future.result()
                fetched_results.append(res)
                if res["status"] == 200:
                    success_count += 1
            except Exception as e:
                print(f"Future error for {pk}: {e}")
                
            count += 1
            if count % 100 == 0 or count == len(urls):
                print(f"  Progress: {count}/{len(urls)} fetched ({success_count} succeeded)...")
                
    print(f"\nCrawling complete. {success_count}/{len(urls)} URLs returned 200 OK.")
    
    print("Processing and storing data in normalized schema...")
    num_scr, num_stk, num_res, num_met = process_results(fetched_results, conn)
    print(f"Stored:")
    print(f"  • {num_scr} Screeners")
    print(f"  • {num_stk} Unique Stocks")
    print(f"  • {num_res} Screener Results associations")
    print(f"  • {num_met} Stock-date metrics")
    
    analyze_data_gaps(conn)
    
    conn.close()
    print("Crawl and Ingest session completed successfully.")

if __name__ == "__main__":
    main()
