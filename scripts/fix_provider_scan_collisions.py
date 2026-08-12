#!/usr/bin/env python3
"""
Provider Scan ID Collision Guard

Verifies that every screener table keyed on a provider-issued scan/screener id includes
the provider (`source`) in its actual PRIMARY KEY -- not just in its columns. See
.claude/rules/data-sources.md's "Composite primary keys for provider-issued ids" rule:
MoneyControl, Trendlyne, ETnow and et_marketstats each hand out their own small-integer
scan_id/screener_id independently and their ranges have collided in practice, which is why
screener_master/screener_reliability/screener_performance_v2 were each migrated to a
composite (source, id) key in 2026-08-03..05.

2026-08-12: replaces a version of this script that only logged a canned "verified"
message without running a single query -- the exact "success heartbeat that checked
nothing" pattern measurement.md warns about. This one queries
information_schema.table_constraints/key_column_usage for real and fails loud.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent / "src" / "server"))
from db_compat import connect  # noqa: E402

# Table -> the provider-discriminator column its PK must include. Extend this list
# deliberately when a new provider-keyed screener table is added -- see data-sources.md.
REQUIRED_COMPOSITE = {
    "screener_master": "source",
    "screener_reliability": "source",
    "screener_performance_v2": "source",
    "screener_performance_history": "source",
}

_PK_QUERY = """
SELECT kcu.column_name
FROM information_schema.table_constraints tc
JOIN information_schema.key_column_usage kcu
  ON tc.constraint_name = kcu.constraint_name AND tc.table_schema = kcu.table_schema
WHERE tc.constraint_type = 'PRIMARY KEY' AND tc.table_name = ?
ORDER BY kcu.ordinal_position
"""


def check_composite_keys(conn, tables: dict[str, str] = REQUIRED_COMPOSITE) -> list[str]:
    """Returns one problem string per table that is missing, has no PK, or has a PK not
    including the required provider column. Empty list = every table is composite-keyed."""
    problems = []
    for table, provider_col in tables.items():
        exists = conn.execute("SELECT to_regclass(?)", (table,)).fetchone()
        if not exists or not exists[0]:
            problems.append(f"{table}: table does not exist")
            continue
        pk_cols = [r[0] for r in conn.execute(_PK_QUERY, (table,)).fetchall()]
        if not pk_cols:
            problems.append(f"{table}: no PRIMARY KEY at all")
        elif provider_col not in pk_cols:
            problems.append(
                f"{table}: PRIMARY KEY is {pk_cols}, missing '{provider_col}' -- a bare "
                f"provider-issued id can collide across sources (see data-sources.md)"
            )
    return problems


def main() -> int:
    conn = connect()
    problems = check_composite_keys(conn)
    if problems:
        print(f"Found {len(problems)} provider-collision risk(s):\n")
        for p in problems:
            print(f"  - {p}")
        return 1
    print(f"Checked {len(REQUIRED_COMPOSITE)} screener table(s); all composite-keyed on their provider column.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
