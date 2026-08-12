import json
import os
import sys
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect

conn = connect()
with open('picks_sample.json') as f:
    syms = json.load(f)

start = '2023-01-01'
end = '2024-12-31'

for s in syms:
    row = conn.execute(
        'SELECT COUNT(1) FROM stock_ohlcv WHERE symbol=? AND date BETWEEN ? AND ?',
        (s, start, end)
    ).fetchone()
    c = row[0]
    print(s, c)

conn.close()
