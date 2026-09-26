"""Read-only SQL against production Postgres, for diagnosis.

    backend-python/venv/Scripts/python.exe scripts/sql.py "SELECT count(*) FROM stock_ohlcv WHERE date = current_date - 1"
    backend-python/venv/Scripts/python.exe scripts/sql.py -f query.sql --timeout 120 --csv

Why this exists: sessions kept hand-writing throwaway query scripts (scratch_verify/ holds
hundreds). Every one of them had to re-solve the same three things this does once:
  * READ-ONLY transaction — a diagnostic query cannot write, drop, or take a DDL lock.
  * SERVER-side statement_timeout — a client-side timeout orphans the query and can hold a
    lock for hours (recurring-bugs.md, "Investigating production without breaking it").
  * Prints the resolved target to stderr first — never trust numbers from a DB you did not name.
"""
import argparse
import csv
import os
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "src", "server"))
import psycopg2  # noqa: E402
from db_compat import database_url  # noqa: E402  (also loads .env)


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("sql", nargs="?", help="SQL text (or use -f)")
    ap.add_argument("-f", "--file", help="read SQL from a file")
    ap.add_argument("--timeout", type=int, default=60, help="server-side statement_timeout, seconds (default 60)")
    ap.add_argument("--limit", type=int, default=200, help="max rows printed (default 200; 0 = all)")
    ap.add_argument("--csv", action="store_true", help="CSV output instead of a | table")
    a = ap.parse_args()

    sql = open(a.file, encoding="utf-8").read() if a.file else a.sql
    if not sql:
        ap.error("give SQL text or -f FILE")

    dsn = database_url().replace("postgresql+psycopg2://", "postgresql://", 1)
    conn = psycopg2.connect(
        dsn,
        options=f"-c default_transaction_read_only=on -c statement_timeout={a.timeout * 1000}",
        application_name="claude-sql-readonly",
    )
    info = conn.get_dsn_parameters()
    print(f"[sql] {info.get('host')}:{info.get('port')}/{info.get('dbname')} read-only, timeout {a.timeout}s",
          file=sys.stderr)
    try:
        with conn.cursor() as cur:
            cur.execute(sql)
            if cur.description is None:
                print(f"[sql] ok, {cur.rowcount} row(s) affected", file=sys.stderr)
                return 0
            cols = [d.name for d in cur.description]
            rows = cur.fetchall() if a.limit == 0 else cur.fetchmany(a.limit + 1)
            more = a.limit and len(rows) > a.limit
            rows = rows[: a.limit] if more else rows
            if a.csv:
                w = csv.writer(sys.stdout)
                w.writerow(cols)
                w.writerows(rows)
            else:
                print(" | ".join(cols))
                for r in rows:
                    print(" | ".join("NULL" if v is None else str(v) for v in r))
            print(f"[sql] {len(rows)} row(s){' (truncated; raise --limit)' if more else ''}", file=sys.stderr)
    finally:
        conn.rollback()
        conn.close()
    return 0


if __name__ == "__main__":
    sys.exit(main())
