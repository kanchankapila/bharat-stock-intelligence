import os
import psycopg2
from psycopg2.extras import RealDictCursor

def main():
    pg_url = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel")
    try:
        conn = psycopg2.connect(pg_url)
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        tables = ['stock_ohlcv', 'technical_signals', 'unified_recommendations']
        for t in tables:
            cur.execute(f"SELECT column_name, data_type FROM information_schema.columns WHERE table_name = '{t}' AND column_name IN ('date', 'computed_at', 'signal_date');")
            print(f"Table {t}:", cur.fetchall())
            
            cur.execute(f"SELECT * FROM {t} LIMIT 3;")
            rows = cur.fetchall()
            print(f"Sample rows from {t}:")
            for r in rows:
                print({k: r[k] for k in list(r.keys())[:5]})
            print("-" * 50)
            
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
