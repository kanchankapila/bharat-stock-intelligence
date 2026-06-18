"""
Sync UNIQUE constraints from db/schema.postgres.sql onto a LIVE Postgres database.

The schema file declares UNIQUE constraints inline in CREATE TABLE, but those tables
already exist on a running DB (CREATE TABLE IF NOT EXISTS is a no-op), so a plain
re-apply never adds them. This parses every `UNIQUE (...)` line out of the generated
schema and creates a matching `CREATE UNIQUE INDEX IF NOT EXISTS` on the live DB —
idempotent, and exactly what ON CONFLICT(<cols>) needs as an arbiter.

Run after regenerating the schema or standing up a DB that predates the UNIQUE fix:
    python scripts/pg_sync_unique_constraints.py
"""

import os, re, sys
from pathlib import Path

ROOT = Path(__file__).parent.parent
SCHEMA = ROOT / "db" / "schema.postgres.sql"
PG_URL = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@localhost:5433/bharat_intel")

TABLE_RE = re.compile(r'CREATE TABLE IF NOT EXISTS "([^"]+)"\s*\((.*?)\n\);', re.DOTALL)
UNIQUE_RE = re.compile(r'^\s*UNIQUE \(([^)]+)\)\s*,?\s*$', re.MULTILINE)


def parse_unique_constraints(sql: str):
    """-> list of (table, [cols])."""
    out = []
    for tbl, body in TABLE_RE.findall(sql):
        for m in UNIQUE_RE.finditer(body):
            cols = [c.strip().strip('"') for c in m.group(1).split(",")]
            out.append((tbl, cols))
    return out


def main():
    import psycopg2
    sql = SCHEMA.read_text(encoding="utf-8")
    constraints = parse_unique_constraints(sql)
    print(f"[uniq-sync] {len(constraints)} UNIQUE constraints in schema")

    conn = psycopg2.connect(PG_URL)
    conn.autocommit = True
    cur = conn.cursor()
    created, existed, failed = 0, 0, 0
    for tbl, cols in constraints:
        idx = "uq_" + tbl + "_" + "_".join(cols)
        idx = re.sub(r"[^a-zA-Z0-9_]", "_", idx)[:63]
        col_sql = ", ".join(f'"{c}"' for c in cols)
        try:
            cur.execute(f'CREATE UNIQUE INDEX IF NOT EXISTS "{idx}" ON "{tbl}" ({col_sql});')
            # IF NOT EXISTS makes both paths look the same; report from pg_indexes.
            cur.execute("SELECT 1 FROM pg_indexes WHERE indexname = %s", (idx,))
            if cur.fetchone():
                created += 1
                print(f"  OK  {tbl}({col_sql})")
        except Exception as e:  # noqa: BLE001 — surface duplicate-data violations loudly
            failed += 1
            print(f"  FAIL {tbl}({col_sql}): {e}", file=sys.stderr)
    print(f"[uniq-sync] done: {created} present, {failed} failed")
    cur.close()
    conn.close()
    sys.exit(1 if failed else 0)


if __name__ == "__main__":
    main()
