"""
Reset every IDENTITY column's sequence to MAX(id)+1 on the live Postgres DB.

The ETL inserts surrogate-key rows with their original SQLite id values, which does
NOT advance the GENERATED ... AS IDENTITY sequence. The first app INSERT then reuses
id=1 and trips the primary-key constraint. Run once after migrate_sqlite_to_pg.py
(it is also invoked from that script):

    python scripts/pg_reset_identity_sequences.py
"""

import os, sys

PG_URL = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@localhost:5433/bharat_intel")


def main():
    import psycopg2
    conn = psycopg2.connect(PG_URL)
    conn.autocommit = True
    cur = conn.cursor()

    # Every identity column in the public schema (column_default is NULL for IDENTITY,
    # so detect via is_identity).
    cur.execute("""
        SELECT table_name, column_name
        FROM information_schema.columns
        WHERE table_schema = 'public' AND is_identity = 'YES'
        ORDER BY table_name
    """)
    cols = cur.fetchall()
    fixed = 0
    for table, col in cols:
        seq = f'pg_get_serial_sequence(%s, %s)'
        cur.execute(
            f'SELECT setval({seq}, COALESCE((SELECT MAX("{col}") FROM "{table}"), 0) + 1, false)',
            (table, col),
        )
        newval = cur.fetchone()[0]
        fixed += 1
        print(f"  {table}.{col} -> next {newval}")
    print(f"[seq-reset] reset {fixed} identity sequences")
    cur.close()
    conn.close()


if __name__ == "__main__":
    main()
