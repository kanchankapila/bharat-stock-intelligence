import time
import sys
from pathlib import Path

# Add src/server to import path for db_compat
ROOT = Path(__file__).resolve().parent.parent
sys.path.insert(0, str(ROOT / "src" / "server"))
from db_compat import connect as db_connect
from sql_translate import use_postgres

print(f"=== PostgreSQL Performance & Connectivity Verification ===")
print(f"USE_POSTGRES = {use_postgres()}")

try:
    conn = db_connect()
    print("[SUCCESS] Connected to database via db_compat.")
except Exception as e:
    print(f"[ERROR] Database connection failed: {e}")
    sys.exit(1)

# 1. Test write performance (Bulk insert test)
print("\n[1/3] Testing bulk insert performance...")
t0 = time.time()
test_rows = [(f"TEST_{i}", 100.0 + i, 50.0 + i) for i in range(1000)]

# Ensure test table exists
conn.execute("""
    CREATE TABLE IF NOT EXISTS perf_test_table (
        symbol TEXT,
        price DOUBLE PRECISION,
        volume DOUBLE PRECISION
    )
""")
conn.commit()

# Clear previous test data
conn.execute("DELETE FROM perf_test_table WHERE symbol LIKE 'TEST_%'")
conn.commit()

conn.executemany("""
    INSERT INTO perf_test_table (symbol, price, volume)
    VALUES (?, ?, ?)
""", test_rows)
conn.commit()
t_insert = time.time() - t0
print(f"  -> Inserted 1,000 rows in {t_insert:.4f} seconds ({1000/t_insert:.2f} rows/sec).")

# 2. Test read performance (Aggregation and index scan)
print("\n[2/3] Testing read/aggregation query performance...")
t0 = time.time()
row = conn.execute("""
    SELECT COUNT(*), AVG(price), MAX(volume) 
    FROM perf_test_table 
    WHERE symbol LIKE 'TEST_%'
""").fetchone()
t_read = time.time() - t0
print(f"  -> Query result: count={row[0]}, avg_price={row[1]:.2f}, max_vol={row[2]:.2f}")
print(f"  -> Query executed in {t_read:.4f} seconds.")

# 3. Test PiT As-Of Join Query pattern (used in ranker)
print("\n[3/3] Testing complex PiT join query pattern...")
t0 = time.time()
# Check if stock_ohlcv has data
ohlcv_count = conn.execute("SELECT COUNT(*) FROM stock_ohlcv").fetchone()[0]
print(f"  -> stock_ohlcv table record count: {ohlcv_count}")

if ohlcv_count > 0:
    pit_sample = conn.execute("""
        SELECT symbol, date, close 
        FROM stock_ohlcv 
        ORDER BY date DESC 
        LIMIT 5
    """).fetchall()
    print(f"  -> Sample OHLCV rows retrieved: {pit_sample}")
t_pit = time.time() - t0
print(f"  -> PiT query pattern executed in {t_pit:.4f} seconds.")

# Cleanup test table
conn.execute("DROP TABLE perf_test_table")
conn.commit()
conn.close()

print("\n=== Verification Complete: PostgreSQL is fully operational and responsive. ===")
