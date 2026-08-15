#!/usr/bin/env tsx
/**
 * Regenerates db/schema.postgres.sql DIRECTLY from live Postgres's own catalogs
 * (pg_attribute/pg_constraint/pg_indexes), not from database.sqlite.
 *
 * Why this exists (2026-08-05, following the checkSchemaDrift.ts audit; that script was finally
 * DELETED 2026-08-15 per docs/SQLITE_DECOMMISSION_PLAN.md Phase 1, this one replaces it outright):
 * scripts/generate_pg_schema.py
 * generates db/schema.postgres.sql from database.sqlite (itself derived from db.ts's CREATE TABLE
 * statements) -- but a large and growing set of tables/columns only ever exist in live Postgres,
 * created via node-pg-migrate migrations or ad-hoc pgEnsureColumns() calls that never touch db.ts.
 * generate_pg_schema.py structurally cannot see those -- it never queries live Postgres at all.
 * The first `npm run schema:drift` run against real production found 45 tables and ~140 columns
 * live but missing from the file (plus 3 columns in the file that don't exist live) -- this script
 * closes that gap by making live Postgres itself the source of truth for this file, instead of the
 * SQLite dev-fallback mirror. db.ts/database.sqlite remain the source of truth for the SQLite dev
 * fallback path (`USE_POSTGRES=false`) -- this script does not touch either of them.
 *
 * Emits output in the house style the checked-in snapshot already uses (CREATE TABLE IF NOT
 * EXISTS "name" (...) with inline PRIMARY KEY/UNIQUE, quoted identifiers, uppercase type keywords)
 * so scripts/checkSchemaDrift.ts's parser -- and any human used to reading this file -- keeps
 * working unchanged. Deliberately does NOT reuse pg_dump: pg_dump's default output uses unquoted
 * lowercase table names, omits IF NOT EXISTS, and emits PRIMARY KEY as a separate trailing
 * `ALTER TABLE ... ADD CONSTRAINT` rather than inline -- all three would silently break
 * checkSchemaDrift.ts's `CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+"([^"]+)"` table-name regex (it would
 * find zero tables in a raw pg_dump file, misreporting 100% drift on the very next run).
 *
 * Deliberately restricted to `pg_class.relkind = 'r'` (ordinary tables only) -- unlike
 * information_schema.columns (what checkSchemaDrift.ts's own live-side query uses for the diff),
 * this excludes views, which this codebase has none of today but which would otherwise show up as
 * spurious "table" drift if one were ever added directly to Postgres.
 *
 * Usage:
 *   npx tsx scripts/generatePgSchemaFromLive.ts
 *   npm run schema:drift          # should report clean immediately after
 *
 * Read-only against Postgres (SELECT-only catalog queries); only mutates db/schema.postgres.sql
 * on disk.
 */
import { writeFileSync } from "fs";
import path from "path";
import { fileURLToPath, pathToFileURL } from "url";

// Static config, not queried: this project's hypertable set changes rarely and deliberately.
// This block is now the SOLE definition -- it previously mirrored scripts/generate_pg_schema.py,
// deleted 2026-08-15 (docs/SQLITE_DECOMMISSION_PLAN.md Phase 1) because it generated the
// Postgres snapshot from database.sqlite and structurally could not see the ~65 Postgres-only
// tables. Cross-check against timescaledb_information.hypertables when changing it.
const HYPERTABLES: Record<string, { timeCol: string; chunk: string; compressAfter: string | null; retainAfter: string | null }> = {
  stock_ohlcv: { timeCol: "date", chunk: "90 days", compressAfter: "180 days", retainAfter: null },
  feature_store: { timeCol: "date", chunk: "90 days", compressAfter: "120 days", retainAfter: null },
  confluence_signals: { timeCol: "computed_at", chunk: "7 days", compressAfter: "30 days", retainAfter: "90 days" },
  intraday_ohlcv: { timeCol: "datetime", chunk: "7 days", compressAfter: "30 days", retainAfter: "365 days" },
  tick_data: { timeCol: "tick_time", chunk: "1 day", compressAfter: "7 days", retainAfter: "30 days" },
  macro_asset_prices: { timeCol: "date", chunk: "365 days", compressAfter: null, retainAfter: null },
};

// Postgres's own format_type() output (lowercase, e.g. "timestamp with time zone") -> this file's
// existing uppercase house-style keyword. Anything not listed here is just uppercased verbatim
// (handles e.g. "character varying(255)" -> "CHARACTER VARYING(255)" without a lookup entry).
const TYPE_ALIASES: Record<string, string> = {
  "timestamp with time zone": "TIMESTAMPTZ",
  "timestamp without time zone": "TIMESTAMP",
  "double precision": "DOUBLE PRECISION",
  bigint: "BIGINT",
  integer: "INTEGER",
  smallint: "SMALLINT",
  text: "TEXT",
  real: "REAL",
  date: "DATE",
};

function pgTypeToHouseStyle(formatTypeOutput: string): string {
  const lower = formatTypeOutput.toLowerCase();
  return TYPE_ALIASES[lower] ?? formatTypeOutput.toUpperCase();
}

interface ColumnRow {
  table_name: string;
  ordinal: number;
  column_name: string;
  data_type: string;
  not_null: boolean;
  identity_flag: string; // 'a' = ALWAYS, 'd' = BY DEFAULT, '' = not an identity column
  default_expr: string | null;
}

interface PkRow {
  table_name: string;
  column_name: string;
  pos: number;
}

interface UniqueRow {
  table_name: string;
  constraint_name: string;
  column_name: string;
  pos: number;
}

interface IndexRow {
  tablename: string;
  indexname: string;
  indexdef: string;
}

// node-pg-migrate's own internal bookkeeping table -- self-created on the first `npm run
// migrate:up` against any target DB, so it doesn't belong in a from-scratch schema snapshot
// (and its legacy `nextval('pgmigrations_id_seq'::regclass)` DEFAULT references a SEQUENCE
// object this generator doesn't emit, which would break the whole file mid-apply). Must stay
// in sync with the identical skip in scripts/checkSchemaDrift.ts's fetchLiveSchema() -- those
// two are now the only copies (generate_pg_schema.py, which also carried one for the
// SQLite-internal tables, was deleted 2026-08-15).
const SKIP_TABLES = new Set(["pgmigrations"]);

async function fetchAll(pool: import("pg").Pool) {
  // Every extension actually installed live (besides the always-present plpgsql) -- e.g.
  // pg_trgm, added 2026-08-03 for news_sentiment_items' trigram indexes. A hardcoded single
  // `CREATE EXTENSION IF NOT EXISTS timescaledb;` line missed this: applying the regenerated
  // file to a scratch DB failed with `operator class "gin_trgm_ops" does not exist for access
  // method "gin"` on the very first verification pass.
  const extRes = await pool.query<{ extname: string }>(
    `SELECT extname FROM pg_extension WHERE extname != 'plpgsql' ORDER BY extname`
  );

  const tablesRes = await pool.query<{ table_name: string }>(
    `SELECT c.relname AS table_name
     FROM pg_class c
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND c.relname != ALL($1)
     ORDER BY c.relname`,
    [[...SKIP_TABLES]]
  );

  const columnsRes = await pool.query<ColumnRow>(
    `SELECT c.relname AS table_name,
            a.attnum AS ordinal,
            a.attname AS column_name,
            pg_catalog.format_type(a.atttypid, a.atttypmod) AS data_type,
            a.attnotnull AS not_null,
            a.attidentity AS identity_flag,
            pg_get_expr(ad.adbin, ad.adrelid) AS default_expr
     FROM pg_attribute a
     JOIN pg_class c ON c.oid = a.attrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     LEFT JOIN pg_attrdef ad ON ad.adrelid = a.attrelid AND ad.adnum = a.attnum
     WHERE n.nspname = 'public' AND c.relkind = 'r' AND a.attnum > 0 AND NOT a.attisdropped
     ORDER BY c.relname, a.attnum`
  );

  const pkRes = await pool.query<PkRow>(
    `SELECT c.relname AS table_name, a.attname AS column_name,
            array_position(con.conkey, a.attnum) AS pos
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
     WHERE con.contype = 'p' AND n.nspname = 'public'
     ORDER BY c.relname, pos`
  );

  const uniqueRes = await pool.query<UniqueRow>(
    `SELECT c.relname AS table_name, con.conname AS constraint_name, a.attname AS column_name,
            array_position(con.conkey, a.attnum) AS pos
     FROM pg_constraint con
     JOIN pg_class c ON c.oid = con.conrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     JOIN pg_attribute a ON a.attrelid = con.conrelid AND a.attnum = ANY(con.conkey)
     WHERE con.contype = 'u' AND n.nspname = 'public'
     ORDER BY c.relname, con.conname, pos`
  );

  // Excludes indexes that merely back a PRIMARY KEY/UNIQUE constraint (already emitted inline
  // above) -- otherwise every composite PK would also re-appear as a redundant CREATE INDEX.
  const indexRes = await pool.query<IndexRow>(
    `SELECT i.tablename, i.indexname, i.indexdef
     FROM pg_indexes i
     WHERE i.schemaname = 'public'
       AND NOT EXISTS (
         SELECT 1 FROM pg_constraint con
         JOIN pg_class ci ON ci.oid = con.conindid
         WHERE ci.relname = i.indexname AND con.contype IN ('p', 'u')
       )
     ORDER BY i.tablename, i.indexname`
  );

  return {
    extensions: extRes.rows.map((r) => r.extname),
    tables: tablesRes.rows.map((r) => r.table_name),
    columns: columnsRes.rows,
    pks: pkRes.rows,
    uniques: uniqueRes.rows,
    indexes: indexRes.rows,
  };
}

function buildTableDdl(
  table: string,
  columns: ColumnRow[],
  pkCols: string[],
  uniqueGroups: Map<string, string[]>
): string {
  const lines: string[] = [];
  for (const col of columns) {
    const isSingleColPk = pkCols.length === 1 && pkCols[0] === col.column_name;
    const pgType = pgTypeToHouseStyle(col.data_type);
    const parts = [`  "${col.column_name}" ${pgType}`];

    if (col.identity_flag === "a") parts.push("GENERATED ALWAYS AS IDENTITY");
    else if (col.identity_flag === "d") parts.push("GENERATED BY DEFAULT AS IDENTITY");

    // NOT NULL is implied for an identity column; skip the redundant explicit keyword.
    if (col.not_null && !col.identity_flag) parts.push("NOT NULL");

    if (col.default_expr && !col.identity_flag) parts.push(`DEFAULT ${col.default_expr}`);

    if (isSingleColPk) parts.push("PRIMARY KEY");

    lines.push(parts.join(" "));
  }

  if (pkCols.length > 1) {
    lines.push(`  PRIMARY KEY (${pkCols.map((c) => `"${c}"`).join(", ")})`);
  }

  for (const [, cols] of uniqueGroups) {
    lines.push(`  UNIQUE (${cols.map((c) => `"${c}"`).join(", ")})`);
  }

  return `CREATE TABLE IF NOT EXISTS "${table}" (\n${lines.join(",\n")}\n);`;
}

function buildHypertableDdls(table: string): string[] {
  const h = HYPERTABLES[table];
  if (!h) return [];
  const out = [
    `SELECT create_hypertable('${table}', '${h.timeCol}', chunk_time_interval => INTERVAL '${h.chunk}', ` +
      `if_not_exists => TRUE, migrate_data => TRUE);`,
  ];
  if (h.compressAfter) {
    out.push(`ALTER TABLE ${table} SET (timescaledb.compress, timescaledb.compress_segmentby = 'symbol');`);
    out.push(`SELECT add_compression_policy('${table}', INTERVAL '${h.compressAfter}', if_not_exists => TRUE);`);
  }
  if (h.retainAfter) {
    out.push(`SELECT add_retention_policy('${table}', INTERVAL '${h.retainAfter}', if_not_exists => TRUE);`);
  }
  return out;
}

export function buildSchemaFile(data: Awaited<ReturnType<typeof fetchAll>>): string {
  const { extensions, tables, columns, pks, uniques, indexes } = data;

  const columnsByTable = new Map<string, ColumnRow[]>();
  for (const col of columns) {
    if (!columnsByTable.has(col.table_name)) columnsByTable.set(col.table_name, []);
    columnsByTable.get(col.table_name)!.push(col);
  }

  const pksByTable = new Map<string, string[]>();
  for (const row of pks) {
    if (!pksByTable.has(row.table_name)) pksByTable.set(row.table_name, []);
    pksByTable.get(row.table_name)!.push(row.column_name);
  }

  const uniquesByTable = new Map<string, Map<string, string[]>>();
  for (const row of uniques) {
    if (!uniquesByTable.has(row.table_name)) uniquesByTable.set(row.table_name, new Map());
    const group = uniquesByTable.get(row.table_name)!;
    if (!group.has(row.constraint_name)) group.set(row.constraint_name, []);
    group.get(row.constraint_name)!.push(row.column_name);
  }

  const indexesByTable = new Map<string, string[]>();
  for (const row of indexes) {
    if (!indexesByTable.has(row.tablename)) indexesByTable.set(row.tablename, []);
    indexesByTable.get(row.tablename)!.push(row.indexdef.endsWith(";") ? row.indexdef : `${row.indexdef};`);
  }

  const blocks: string[] = [
    "-- GENERATED by scripts/generatePgSchemaFromLive.ts from live Postgres — do not edit by hand.",
    "-- Apply with:  psql \"$POSTGRES_URL\" -f db/schema.postgres.sql",
    ...extensions.map((ext) => `CREATE EXTENSION IF NOT EXISTS ${ext};`),
    "",
  ];
  const hyperSection = ["", "-- ── Timescale hypertables / compression / retention ──────────────────────"];

  for (const table of tables) {
    const cols = columnsByTable.get(table) ?? [];
    if (cols.length === 0) continue; // a table with no readable columns — nothing to emit
    blocks.push(`-- ── ${table} ─────────────────────────────────────────────`);
    blocks.push(buildTableDdl(table, cols, pksByTable.get(table) ?? [], uniquesByTable.get(table) ?? new Map()));
    blocks.push(...(indexesByTable.get(table) ?? []));
    blocks.push("");
    hyperSection.push(...buildHypertableDdls(table));
  }

  return blocks.concat(hyperSection).join("\n") + "\n";
}

async function main() {
  const { getPool } = await import("../src/server/pgClient");
  const pool = getPool();
  const data = await fetchAll(pool);
  const outPath = path.join(process.cwd(), "db", "schema.postgres.sql");
  writeFileSync(outPath, buildSchemaFile(data), "utf-8");
  console.log(`[schema] wrote ${outPath}  (${data.tables.length} tables, from live Postgres)`);
  await pool.end();
}

const isMainModule =
  typeof process.argv[1] === "string" && pathToFileURL(process.argv[1]).href === import.meta.url;
if (isMainModule) {
  main().catch((err) => {
    console.error("generatePgSchemaFromLive failed:", err);
    process.exit(1);
  });
}
