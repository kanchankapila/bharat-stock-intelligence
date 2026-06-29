#!/usr/bin/env python3
"""
Create Fundamental Screener URLs Table
======================================
This script filters all extracted stock details inside `mc_tl_explore.db` for URLs 
matching the pattern `trendlyne.com/fundamentals` (or `trendlyne.com/fundamental`), 
creates a new database table named `trendlyne_fundamental_screener_urls`, and inserts 
the distinct set of matching URLs.

Usage:
  python scripts/create_fundamental_urls_table.py
"""

import sqlite3
import os
import sys

db_path = "mc_tl_explore.db"

if not os.path.exists(db_path):
    print(f"Error: Database file '{db_path}' not found in current directory.")
    sys.exit(1)

conn = sqlite3.connect(db_path)
cursor = conn.cursor()

# 1. Create the new table (drop first for a fresh schema reset)
cursor.execute("DROP TABLE IF EXISTS trendlyne_fundamental_screener_urls")
cursor.execute("""
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
# Check both flag_url_with_domain and flag_url columns for safety
cursor.execute("""
    SELECT DISTINCT flag_label, flag_url_with_domain 
    FROM trendlyne_screener_stocks_extracted 
    WHERE flag_url_with_domain LIKE '%trendlyne.com/fundamental%'
       OR flag_url_with_domain LIKE '%trendlyne.com/fundamentals%'
""")
rows = cursor.fetchall()

if not rows:
    print("No matching fundamental screener URLs found in 'trendlyne_screener_stocks_extracted'.")
    conn.close()
    sys.exit(0)

# 3. Insert unique URLs into the new table
inserted_count = 0
for flag_label, url in rows:
    if not url:
        continue
    try:
        cursor.execute("""
            INSERT OR IGNORE INTO trendlyne_fundamental_screener_urls (flag_label, url)
            VALUES (?, ?)
        """, (flag_label, url))
        if cursor.rowcount > 0:
            inserted_count += 1
    except sqlite3.Error as e:
        print(f"Error inserting {url}: {e}")

conn.commit()
print(f"Successfully processed {len(rows)} raw rows and inserted {inserted_count} unique fundamental screener URLs.")

# 4. Display the populated table content
print("\n--- Populated Table: trendlyne_fundamental_screener_urls ---")
cursor.execute("SELECT id, flag_label, url FROM trendlyne_fundamental_screener_urls ORDER BY id")
for row_id, label, url in cursor.fetchall():
    print(f"[{row_id}] Label: {label:<22} | URL: {url}")

conn.close()
print("\nExecution complete.")
