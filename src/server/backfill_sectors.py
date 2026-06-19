"""
Sector Backfill
===============
Populates the canonical nse_stocks.sector (95% empty: only 106/2366 filled) from
sector data the confluence engine already resolved into confluence_signals
(~1,939 symbols with real sectors), then propagates to historical signal tables.

This is offline (no API), idempotent, and only fills MISSING sectors — it never
overwrites a real value. Because reward_engine._get_sector and the scoring engine
read nse_stocks.sector, every NEW signal self-heals once this has run.

Run:  python backfill_sectors.py
      python backfill_sectors.py --dry-run
"""

import argparse

from db_compat import connect, use_postgres, ConnWrapper

MISSING = ('', 'Unknown', 'OTHER', 'NA', 'NaN')


def _has_column(conn: ConnWrapper, table: str, col: str) -> bool:
    if use_postgres():
        rows = conn.execute(
            "SELECT column_name FROM information_schema.columns WHERE table_name = ?",
            (table,),
        ).fetchall()
        return any(r[0] == col for r in rows)
    return any(r[1] == col for r in conn.execute(f"PRAGMA table_info({table})").fetchall())


def backfill(conn: ConnWrapper, dry_run: bool = False) -> dict:
    ph = ",".join("?" * len(MISSING))

    # 1. Best (latest) non-empty sector per symbol from confluence_signals.
    #    A window function picks the row holding MAX(computed_at) per symbol on both engines
    #    (the old bare-column + MAX() GROUP BY relied on SQLite-only semantics PG rejects).
    rows = conn.execute(f"""
        SELECT symbol, sector FROM (
            SELECT symbol, sector,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY computed_at DESC) AS rn
            FROM confluence_signals
            WHERE sector IS NOT NULL AND sector NOT IN ({ph})
        ) t
        WHERE rn = 1
    """, MISSING).fetchall()
    sector_map = {sym: sec for sym, sec in rows if sym and sec}
    print(f"[Sectors] Resolved {len(sector_map)} symbol->sector pairs from confluence_signals.")

    # 2. Fill nse_stocks where sector is missing.
    to_fill = conn.execute(f"""
        SELECT symbol FROM nse_stocks
        WHERE sector IS NULL OR sector IN ({ph})
    """, MISSING).fetchall()
    updates = [(sector_map[s[0]], s[0]) for s in to_fill if s[0] in sector_map]

    if dry_run:
        print(f"[Sectors] [DRY] Would fill {len(updates)} nse_stocks rows.")
    else:
        conn.executemany(
            "UPDATE nse_stocks SET sector = ?, last_updated = CURRENT_TIMESTAMP WHERE symbol = ?",
            updates,
        )
        print(f"[Sectors] Filled {len(updates)} nse_stocks rows.")

    # 3. Propagate to historical signal tables that carry their own sector column.
    propagated = {}
    for table in ('recommendation_log', 'unified_signals', 'signals'):
        if not _has_column(conn, table, 'sector'):
            continue
        if dry_run:
            n = conn.execute(f"""
                SELECT COUNT(*) FROM {table} t
                WHERE (t.sector IS NULL OR t.sector IN ({ph}))
                  AND EXISTS (SELECT 1 FROM nse_stocks n
                              WHERE n.symbol = t.symbol AND n.sector IS NOT NULL
                                AND n.sector NOT IN ({ph}))
            """, MISSING + MISSING).fetchone()[0]
            propagated[table] = n
        else:
            cur = conn.execute(f"""
                UPDATE {table}
                SET sector = (SELECT n.sector FROM nse_stocks n WHERE n.symbol = {table}.symbol)
                WHERE (sector IS NULL OR sector IN ({ph}))
                  AND EXISTS (SELECT 1 FROM nse_stocks n
                              WHERE n.symbol = {table}.symbol AND n.sector IS NOT NULL
                                AND n.sector NOT IN ({ph}))
            """, MISSING + MISSING)
            propagated[table] = cur.rowcount

    if not dry_run:
        conn.commit()
    print(f"[Sectors] Propagated to historical tables: {propagated}")
    return {'nse_stocks_filled': len(updates), 'propagated': propagated}


def run(dry_run: bool = False):
    conn = connect()
    try:
        return backfill(conn, dry_run=dry_run)
    finally:
        conn.close()


if __name__ == "__main__":
    p = argparse.ArgumentParser()
    p.add_argument("--dry-run", action="store_true")
    args = p.parse_args()
    run(dry_run=args.dry_run)
