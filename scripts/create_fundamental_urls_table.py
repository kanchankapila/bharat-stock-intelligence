#!/usr/bin/env python3
import os
import sys
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect as db_connect
from sql_translate import use_postgres

conn = db_connect()

# 1. Create the new table (drop first for a fresh schema reset)
conn.execute("DROP TABLE IF EXISTS trendlyne_fundamental_screener_urls")

if use_postgres():
    conn.execute("""
    CREATE TABLE trendlyne_fundamental_screener_urls (
        id             SERIAL PRIMARY KEY,
        flag_label     TEXT,
        url            TEXT UNIQUE,
        created_at     TIMESTAMPTZ DEFAULT CURRENT_TIMESTAMP
    )
    """)
else:
    conn.execute("""
    CREATE TABLE trendlyne_fundamental_screener_urls (
        id             INTEGER PRIMARY KEY AUTOINCREMENT,
        flag_label     TEXT,
        url            TEXT UNIQUE,
        created_at     TEXT DEFAULT CURRENT_TIMESTAMP
    )
    """)
conn.commit()
print("Table 'trendlyne_fundamental_screener_urls' created successfully.")

# 2. Select distinct fundamental URLs from extracted table
rows = conn.execute("""
    SELECT DISTINCT flag_label, flag_url_with_domain 
    FROM trendlyne_screener_stocks_extracted 
    WHERE flag_url_with_domain LIKE '%trendlyne.com/fundamental%'
       OR flag_url_with_domain LIKE '%trendlyne.com/fundamentals%'
""").fetchall()

if not rows:
    print("No matching fundamental screener URLs found in 'trendlyne_screener_stocks_extracted'.")
    conn.close()
    sys.exit(0)

# 3. Insert unique URLs into the new table
inserted_count = 0
for flag_label, url in rows:
    if not url:
        continue
    # Using ON CONFLICT DO NOTHING for portability
    res = conn.execute("""
        INSERT INTO trendlyne_fundamental_screener_urls (flag_label, url)
        VALUES (?, ?)
        ON CONFLICT (url) DO NOTHING
    """, (flag_label, url))
    if res.rowcount > 0:
        inserted_count += 1

conn.commit()
print(f"Successfully processed {len(rows)} raw rows and inserted {inserted_count} unique fundamental screener URLs.")

# 4. Display the populated table content
print("\n--- Populated Table: trendlyne_fundamental_screener_urls ---")
for row in conn.execute("SELECT id, flag_label, url FROM trendlyne_fundamental_screener_urls ORDER BY id").fetchall():
    print(f"[{row[0]}] Label: {row[1]:<22} | URL: {row[2]}")

conn.close()
print("\nExecution complete.")
