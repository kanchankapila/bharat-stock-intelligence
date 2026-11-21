"""AF-20261120-06: screener_appearances was keyed (screener_id, symbol, appeared_date) although
ETnow and MoneyControl issue overlapping screener ids (20 shared on 2026-11-20), so a same-day
entry from the second provider was silently ignored. data-sources.md: a provider-issued id needs
the provider in the key."""
import os
import re

SCHEMA = os.path.join(os.path.dirname(__file__), "..", "..", "..", "db", "schema.postgres.sql")
MIGRATION_PREFIX = "20261121120000_screener-appearances-source-in-pk."


def test_screener_appearances_primary_key_includes_source():
    text = open(SCHEMA, encoding="utf-8").read()
    block = re.search(r'CREATE TABLE IF NOT EXISTS "screener_appearances" \((.*?)\n\);', text, re.S)
    assert block, "screener_appearances missing from the schema snapshot"
    pk = re.search(r"PRIMARY KEY \(([^)]*)\)", block.group(1))
    cols = [c.strip().strip('"') for c in pk.group(1).split(",")]
    assert cols == ["source", "screener_id", "symbol", "appeared_date"]


def test_screener_appearances_pk_migration_uses_concurrent_index():
    migration_dir = os.path.join(os.path.dirname(__file__), "..", "..", "..", "migrations")
    migration_path = next(
        os.path.join(migration_dir, name)
        for name in os.listdir(migration_dir)
        if name.startswith(MIGRATION_PREFIX)
    )
    migration = open(migration_path, encoding="utf-8").read()
    assert "pgm.noTransaction()" in migration
    assert re.search(r"CREATE UNIQUE INDEX CONCURRENTLY", migration, re.I)
    assert re.search(r"PRIMARY KEY USING INDEX", migration, re.I)
