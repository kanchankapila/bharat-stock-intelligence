import sys
import os
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect

conn = connect()
rows = conn.execute('SELECT DISTINCT symbol FROM stock_ohlcv LIMIT 200').fetchall()
print(len(rows))
for r in rows:
    print(r[0])
conn.close()
