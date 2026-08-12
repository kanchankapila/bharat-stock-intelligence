
import os
import sys
from pathlib import Path

# Add src/server to path
sys.path.insert(0, os.path.join(os.path.dirname(__file__), '..', 'src', 'server'))

from db_compat import connect, use_postgres, database_url

def test_connection():
    print(f"USE_POSTGRES env: {os.environ.get('USE_POSTGRES')}")
    print(f"use_postgres() result: {use_postgres()}")
    print(f"Database URL: {database_url()}")
    
    try:
        conn = connect()
        print("Successfully connected to the database!")
        
        # Check database type
        res = conn.execute("SELECT version()").fetchone()
        if res:
            print(f"Database version: {res[0]}")
        else:
            # Fallback for SQLite
            res = conn.execute("SELECT sqlite_version()").fetchone()
            print(f"SQLite version: {res[0]}")
            
        conn.close()
    except Exception as e:
        print(f"Failed to connect: {e}")

if __name__ == "__main__":
    test_connection()
