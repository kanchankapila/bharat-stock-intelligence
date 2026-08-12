import os
import psycopg2
from psycopg2.extras import RealDictCursor

def main():
    pg_url = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel")
    try:
        conn = psycopg2.connect(pg_url)
        cur = conn.cursor(cursor_factory=RealDictCursor)
        
        # Query to find all TEXT columns that might be dates
        query = """
        SELECT table_name, column_name, data_type 
        FROM information_schema.columns 
        WHERE table_schema = 'public' 
          AND data_type = 'text'
          AND (column_name LIKE '%date%' OR column_name LIKE '%at%' OR column_name LIKE '%seen%')
        ORDER BY table_name, column_name;
        """
        cur.execute(query)
        columns = cur.fetchall()
        
        print(f"{'Table':<40} | {'Column':<30} | {'Type'}")
        print("-" * 85)
        for col in columns:
            print(f"{col['table_name']:<40} | {col['column_name']:<30} | {col['data_type']}")
            
        cur.close()
        conn.close()
    except Exception as e:
        print(f"Error: {e}")

if __name__ == "__main__":
    main()
