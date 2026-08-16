---
description: Review a new or pending node-pg-migrate migration against this repo's TimescaleDB hypertable constraints, SQLite/Postgres dual-schema drift, and the "written ≠ applied" gap before it runs against production
---

# Migration Safety Review

Read the "SQL dialect" and "Environment & deploy" sections of `.claude/rules/recurring-bugs.md`
first. `CLAUDE.md` states the live DB is Postgres/TimescaleDB (`USE_POSTGRES=true`, :5433) and
that several tables are **compressed hypertables where a predicate-wide `UPDATE`/`ADD CONSTRAINT`
will fail or destroy compression** — this is a hard constraint specific to this repo's storage
engine, not a generic Postgres concern, and a migration written against a plain local Postgres
instance can look correct and still be wrong in production.

## 1. Identify what the migration actually touches

Read the migration file fully. For each table it alters:

```sql
-- is this table a hypertable, and is it compressed?
SELECT hypertable_name, compression_enabled FROM timescaledb_information.hypertables
WHERE hypertable_name = '<table>';
SELECT * FROM timescaledb_information.compression_settings WHERE hypertable_name = '<table>';
```

## 2. Hypertable-specific hazards

- **`ADD CONSTRAINT`/`ALTER COLUMN` on a compressed hypertable** — check whether it needs the
  chunk to be decompressed first, or whether Timescale rejects it outright. A predicate-wide
  `UPDATE` on a compressed hypertable can also silently degrade compression on touched chunks even
  when it "succeeds." If the migration does this, it needs an explicit decompress → alter →
  recompress sequence, not a bare `ALTER TABLE`.
- **New column on a hypertable expected to be backfilled** — a bare `ADD COLUMN` is fine and fast
  (metadata-only) in Postgres/Timescale, but do not conflate that with the column being
  *populated*; confirm the migration doesn't assume a default backfill happens implicitly.
- **`CREATE TABLE IF NOT EXISTS` used where a column is being added to an existing table** — this
  is a documented no-op in this repo (`recurring-bugs.md`'s SQL-dialect table) if the table already
  exists; needs an explicit `safe_alter` pattern instead.

## 3. Schema drift against live

**Do not read `db.ts` for a live column type.** It is the SQLite dev/test schema, not the live
Postgres shape, and it has been wrong about the tables it does describe. The schema to trust is
`db/schema.postgres.sql`, regenerated from live by `npm run schema:regen`.

⚠ **Corrected 2026-08-16 (second time same day).** An earlier revision of this section said
`db.ts` had been retired and renamed `db.sqlite-legacy.ts`. That was true of an in-flight branch
that was subsequently **discarded** — `db.ts` is present and imported. Check the file exists
before believing any claim here about it, including this one.

Confirm the migration's target table/columns match what's actually live
(`information_schema.columns`) — that file is only as good as its last regeneration, and tables
created by self-creating DDL (`data_quality_history`) or by a migration that was never reflected
back have been missing from it before. Run `npm run schema:drift` after; it is a
test-correctness check now, not just tidiness, because the vitest suite builds its throwaway
schema from that file.

## 4. Data safety on the migrating column/table

- Any `NOT NULL` or `UNIQUE`/PK constraint added to an existing column: query the live table first
  for rows that would violate it (`SELECT COUNT(*) FROM t WHERE <col> IS NULL`, or a duplicate-key
  check) — a migration that fails midway on production because of a pre-existing constraint
  violation is a worse outcome than catching it here first.
- Any `DROP COLUMN`/`DROP TABLE`: confirm nothing in `src/server/` still reads it (grep the exact
  column/table name across the whole tree, not just the obvious call site) before it runs.

## 5. Written ≠ applied — confirm the deploy step is real

A migration verified against a throwaway local cluster is not applied to production. After the
migration is merged/run, this review's job isn't done until:

```bash
npm run migrate:up   # against the REAL POSTGRES_URL — confirm which one is active first
npm run schema:drift
```

and a direct `information_schema` check that the new column/table/constraint exists live. This is
the same "committed ≠ deployed ≠ applied" loop as the `deploy-and-verify` skill — use it directly
for the deploy half of this review rather than duplicating the steps here.

## 6. Report

Per migration: hypertable/compression hazards found (if any), SQLite/Postgres drift introduced or
left unaddressed, pre-existing data that would violate a new constraint (with the count), and
confirmation (or lack of it) that `migrate:up` actually ran against the real `POSTGRES_URL` and
`schema:drift` is clean afterward.
