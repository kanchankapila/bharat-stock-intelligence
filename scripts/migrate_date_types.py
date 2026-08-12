import os
import psycopg2
import logging

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger("MigrateDates")

def main():
    pg_url = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel")
    try:
        conn = psycopg2.connect(pg_url)
        conn.autocommit = False
        cur = conn.cursor()
        
        migrations = [
            ("technical_signals", "date", "DATE", "CAST(NULLIF(date, '') AS DATE)"),
            ("unified_recommendations", "computed_at", "TIMESTAMPTZ", "CAST(NULLIF(computed_at, '') AS TIMESTAMPTZ)"),
            ("block_deals", "date", "DATE", "CAST(NULLIF(date, '') AS DATE)"),
            ("early_hours_predictions", "date", "DATE", "CAST(NULLIF(date, '') AS DATE)"),
        ]
        
        for table, col, target_type, using_expr in migrations:
            logger.info(f"Migrating {table}.{col} to {target_type}...")
            try:
                # Check current type
                cur.execute(f"SELECT data_type FROM information_schema.columns WHERE table_name = '{table}' AND column_name = '{col}';")
                res = cur.fetchone()
                if not res:
                    logger.warning(f"Column {col} not found in {table}, skipping.")
                    continue
                curr_type = res[0]
                if curr_type.upper() == target_type.upper():
                    logger.info(f"{table}.{col} is already {target_type}. Skipping.")
                    continue
                
                alter_query = f"""
                ALTER TABLE {table} 
                ALTER COLUMN {col} TYPE {target_type} 
                USING {using_expr};
                """
                cur.execute(alter_query)
                conn.commit()
                logger.info(f"Successfully migrated {table}.{col} to {target_type}.")
            except Exception as e:
                conn.rollback()
                logger.error(f"Failed to migrate {table}.{col}: {e}")
                
        cur.close()
        conn.close()
    except Exception as e:
        logger.error(f"Database connection error: {e}")

if __name__ == "__main__":
    main()
