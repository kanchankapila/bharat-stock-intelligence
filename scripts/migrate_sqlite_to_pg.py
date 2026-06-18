"""
SQLite -> PostgreSQL/TimescaleDB data migration (ETL)
=====================================================
Copies every row from database.sqlite into the Postgres schema produced by
generate_pg_schema.py. Idempotent: each target table is TRUNCATEd then reloaded.
Validates source vs loaded row counts and reports any mismatch.

Prereqs: the schema must already be applied (db/schema.postgres.sql), and psycopg2
installed. Connection comes from POSTGRES_URL (.env) or the default localhost:5433.

Run:  python scripts/migrate_sqlite_to_pg.py
      python scripts/migrate_sqlite_to_pg.py --only stock_ohlcv,feature_store
"""

from pathlib import Path
import sqlite3, os, sys, argparse
import psycopg2
from psycopg2 import sql
from psycopg2.extras import execute_values

ROOT = Path(__file__).parent.parent
SQLITE_PATH = ROOT / "database.sqlite"
PG_URL = os.environ.get("POSTGRES_URL", "postgresql://bharat:bharat@localhost:5433/bharat_intel")

# Not data tables: app-managed migration ledger + Timescale internals.
SKIP = {"_migrations"}

# PG types that must reject empty-string -> use NULL instead.
NON_TEXT = ("timestamp", "date", "time", "integer", "bigint", "smallint",
            "numeric", "double", "real", "boolean")

BATCH = 5000


def pg_columns(pg, table: str):
    """Return [(name, data_type)] in ordinal order for a public table."""
    with pg.cursor() as cur:
        cur.execute("""
            SELECT column_name, data_type
            FROM information_schema.columns
            WHERE table_schema='public' AND table_name=%s
            ORDER BY ordinal_position
        """, (table,))
        return cur.fetchall()


def coerce(val, data_type: str):
    if val is None:
        return None
    if isinstance(val, str):
        s = val.strip()
        # SQLite is typeless, so numeric columns can hold junk ('N/A', '', '-'); Postgres
        # is strict. Parse what we can, NULL the rest (the value was never a valid number).
        if any(k in data_type for k in ("integer", "bigint", "smallint")):
            try:
                return int(float(s))
            except ValueError:
                return None
        if any(k in data_type for k in ("numeric", "double", "real")):
            try:
                return float(s)
            except ValueError:
                return None
        if s == "" and any(k in data_type for k in ("timestamp", "date", "time")):
            return None
    if "boolean" in data_type and isinstance(val, (int, float)):
        return bool(val)
    return val


def migrate_table(sqlite_conn, pg, table: str) -> tuple[int, int]:
    cols = pg_columns(pg, table)
    if not cols:
        print(f"  [skip] {table}: no target columns")
        return (0, 0)
    col_names = [c[0] for c in cols]
    col_types = {c[0]: c[1] for c in cols}

    src_count = sqlite_conn.execute(f"SELECT COUNT(*) FROM '{table}'").fetchone()[0]

    # Pull source rows; select only columns that exist in target, by name.
    sq_cols = [r[1] for r in sqlite_conn.execute(f"PRAGMA table_info('{table}')").fetchall()]
    use_cols = [c for c in col_names if c in sq_cols]
    quoted_src = ", ".join(f'"{c}"' for c in use_cols)
    cur = sqlite_conn.execute(f"SELECT {quoted_src} FROM '{table}'")

    insert_sql = sql.SQL("INSERT INTO {} ({}) VALUES %s").format(
        sql.Identifier(table),
        sql.SQL(", ").join(sql.Identifier(c) for c in use_cols),
    )

    with pg.cursor() as pcur:
        pcur.execute(sql.SQL("TRUNCATE TABLE {} ").format(sql.Identifier(table)))
        loaded = 0
        batch = []
        for row in cur:
            batch.append(tuple(coerce(row[i], col_types[use_cols[i]]) for i in range(len(use_cols))))
            if len(batch) >= BATCH:
                execute_values(pcur, insert_sql.as_string(pg), batch, page_size=BATCH)
                loaded += len(batch)
                batch = []
        if batch:
            execute_values(pcur, insert_sql.as_string(pg), batch, page_size=BATCH)
            loaded += len(batch)
    pg.commit()
    return (src_count, loaded)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", type=str, default="", help="comma-separated table allowlist")
    args = ap.parse_args()
    only = set(t.strip() for t in args.only.split(",") if t.strip())

    sqlite_conn = sqlite3.connect(SQLITE_PATH)
    pg = psycopg2.connect(PG_URL)

    tables = [r[0] for r in sqlite_conn.execute(
        "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
    ).fetchall() if r[0] not in SKIP and (not only or r[0] in only)]

    print(f"[ETL] migrating {len(tables)} tables -> {PG_URL.split('@')[-1]}")
    mismatches = []
    for t in tables:
        try:
            src, loaded = migrate_table(sqlite_conn, pg, t)
            flag = "" if src == loaded else "  *** MISMATCH ***"
            if src != loaded:
                mismatches.append((t, src, loaded))
            print(f"  {t:38s} src={src:>8} loaded={loaded:>8}{flag}")
        except Exception as e:
            pg.rollback()
            mismatches.append((t, "ERR", str(e)[:80]))
            print(f"  {t:38s} ERROR: {str(e)[:120]}")

    sqlite_conn.close()
    pg.close()

    # Post-load fixups (idempotent). Inserting surrogate ids does NOT advance the IDENTITY
    # sequence, and the non-PK UNIQUE constraints aren't added to an already-created table —
    # without both, app INSERTs and ON CONFLICT(<unique cols>) break after a fresh ETL.
    if not only:
        try:
            import pg_reset_identity_sequences as seqfix
            seqfix.main()
        except Exception as e:  # noqa: BLE001
            print(f"[ETL] sequence reset failed: {e}", file=sys.stderr)
        try:
            import pg_sync_unique_constraints as uqfix
            uqfix.main()
        except SystemExit:
            pass
        except Exception as e:  # noqa: BLE001
            print(f"[ETL] unique-constraint sync failed: {e}", file=sys.stderr)

    print("\n[ETL] done." if not mismatches else f"\n[ETL] {len(mismatches)} tables need attention:")
    for m in mismatches:
        print("  ", m)
    sys.exit(1 if mismatches else 0)


if __name__ == "__main__":
    main()
