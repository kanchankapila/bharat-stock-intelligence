import sys
import os
from pathlib import Path

# Add src/server to import path for db_compat
sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect

sym = sys.argv[1] if len(sys.argv) > 1 else 'ADANIPORTS'
conn = connect()
row = conn.execute(
    'SELECT MIN(date), MAX(date), COUNT(1) FROM stock_ohlcv WHERE symbol=?',
    (sym,)
).fetchone()
print(row)
conn.close()
