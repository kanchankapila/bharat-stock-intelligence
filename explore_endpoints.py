import sqlite3
import json

con = sqlite3.connect('mc_tl_explore.db')
cur = con.cursor()

queries = {
    "Earnings": "SELECT subcategory, url, raw_json FROM api_responses WHERE category='earnings' AND raw_json IS NOT NULL LIMIT 5",
    "Smart Money (Deals)": "SELECT subcategory, url, raw_json FROM api_responses WHERE category='deals' AND raw_json IS NOT NULL LIMIT 5",
    "Indices": "SELECT subcategory, url, raw_json FROM api_responses WHERE category='indices' AND raw_json IS NOT NULL LIMIT 5",
    "F&O (Moneycontrol)": "SELECT subcategory, url, raw_json FROM api_responses WHERE subcategory LIKE '%fno%' AND raw_json IS NOT NULL LIMIT 5"
}

for name, q in queries.items():
    print(f"\n--- {name} ---")
    cur.execute(q)
    for sub, url, raw in cur.fetchall():
        print(f"[{sub}] URL: {url}")
        print(f"Sample: {raw[:150]}...")
