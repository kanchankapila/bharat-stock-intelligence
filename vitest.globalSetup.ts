/**
 * Creates one private, throwaway Postgres schema for the whole `unit` vitest project, applies
 * db/schema.postgres.sql into it, and drops it CASCADE when the run ends.
 *
 * This is the TypeScript half of docs/SQLITE_DECOMMISSION_PLAN.md Phase 2. The Python half
 * already exists as the `pg_schema`/`pg_conn` fixtures in src/server/tests/conftest.py; this
 * file follows the same three rules deliberately:
 *
 *   1. ISOLATION IS THE POINT. A test pointed at Postgres without a private schema is pointed
 *      at LIVE PRODUCTION. The schema name goes into VITEST_PG_SCHEMA, and pgClient.getPool()
 *      pins every pooled connection's search_path to it, so an unqualified table name can only
 *      ever shadow a production table, never write to one.
 *   2. THE DSN IS TEST-OWNED (PGTEST_*), never POSTGRES_URL. A stray production URL in the
 *      environment must not silently redirect a schema-creating run at it. Same reasoning, and
 *      the same variable names, as conftest.py's _pg_dsn().
 *   3. A uuid4 name, not a run-derived one -- names collide across repeated runs, and a
 *      leftover schema from a killed run would otherwise be silently reused as if it were empty.
 *
 * Scoped to the `unit` project only. The `live` project (see vite.config.ts) deliberately talks
 * to real production Postgres, because a live_datasource test's whole job is to prove a fetcher
 * writes correct real rows -- data-sources.md calls that write "genuine, correct production
 * data, not test fixture pollution". Keeping the two in separate vitest projects is what makes
 * that safe: separate processes, so the live half cannot leak its dialect or its credentials
 * into the unit half. Under the old single-project layout it could and did -- see
 * pgConfig.vitestSchema()'s comment for the 2,148 fabricated bars that cost.
 */
import { readFileSync } from 'fs';
import { randomUUID } from 'crypto';
import path from 'path';
import pg from 'pg';

function dsn() {
  return {
    host: process.env.PGTEST_HOST || '127.0.0.1',
    port: Number(process.env.PGTEST_PORT || 5433),
    user: process.env.PGTEST_USER || 'bharat',
    password: process.env.PGTEST_PASSWORD || 'bharat',
    database: process.env.PGTEST_DB || 'bharat_intel',
  };
}

let schema: string | null = null;

export async function setup() {
  schema = `vitest_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const client = new pg.Client({ ...dsn(), connectionTimeoutMillis: 10_000 });

  try {
    await client.connect();
  } catch (err) {
    // Loud, not a silent SQLite fallback. A missing test database used to mean "quietly use a
    // stale 3.49 GB local file and print convincing numbers" (recurring-bugs.md, Environment &
    // deploy); making it a hard failure is the entire point of the decommission.
    throw new Error(
      `vitest needs Postgres and could not reach ${dsn().host}:${dsn().port}/${dsn().database} ` +
        `(${(err as Error).message}). Start the container, or point PGTEST_HOST/PGTEST_PORT/` +
        `PGTEST_USER/PGTEST_PASSWORD/PGTEST_DB at one.`,
    );
  }

  // db/schema.postgres.sql is a snapshot of PRODUCTION, and generatePgSchemaFromLive.ts emits its
  // 219 index statements schema-qualified (`CREATE INDEX idx_aar_run_date ON public.
  // agent_audit_reports ...`) while emitting every CREATE TABLE unqualified. Applied as-is with
  // search_path pointed elsewhere, that combination creates the TABLES in the throwaway schema
  // and then tries to index the real PRODUCTION tables. Caught here the first time this ran:
  // `relation "idx_aar_run_date" already exists`, because it does — in production. The whole file
  // executes as one implicit transaction so it rolled back cleanly (verified afterwards: 213
  // public tables / 451 public indexes unchanged, zero leftover schemas), but "it happened to
  // fail loudly" is not isolation. Rewrite the qualification, then assert none survived.
  let ddl = readFileSync(path.resolve(__dirname, 'db/schema.postgres.sql'), 'utf8');
  ddl = ddl.replace(/\bpublic\./g, `"${schema}".`);
  if (/\bpublic\./.test(ddl)) throw new Error('schema rewrite missed a public.-qualified reference');
  // 2026-08-29: create_hypertable/add_compression_policy/add_retention_policy take a bare,
  // unqualified table-name string (never "public.xxx"), so the rewrite above never touches
  // them -- they correctly resolve via search_path into THIS throwaway schema, but the
  // resulting TimescaleDB background job is registered GLOBALLY (no schema scoping in
  // _timescaledb_config.bgw_job). A clean teardown (dropThrowawaySchema) drops the hypertable
  // fine, but a run that crashes before its own teardown leaves a `DROP SCHEMA ... CASCADE`
  // (from crash-recovery cleanup, if any exists on this side, or none at all) that does not
  // reliably fire TimescaleDB's own hypertable-drop hook -- orphaning the job independently of
  // the schema. Confirmed live: this + the pytest-side equivalent (src/server/conftest.py's
  // _apply_schema) together left 16 orphaned compression/retention jobs pointing at
  // hypertable_ids with zero chunks. A throwaway schema that lives seconds to minutes has no
  // use for real compression/retention behavior, so skip creating these here entirely.
  ddl = ddl.replace(
    /^SELECT (create_hypertable|add_compression_policy|add_retention_policy)\(.*?\);\s*$|^ALTER TABLE \w+ SET \(timescaledb\..*?\);\s*$/gm,
    '',
  );

  await client.query(`CREATE SCHEMA "${schema}"`);
  // public stays on the path so extensions (pg_trgm, timescaledb) and their types resolve; the
  // throwaway schema is FIRST, so every unqualified CREATE/INSERT/SELECT lands inside it.
  await client.query(`SET search_path TO "${schema}", public`);
  await client.query(ddl);

  // Assert the substrate is actually there rather than trusting that the DDL "ran". An empty or
  // half-applied schema would otherwise surface as a hundred confusing "relation does not exist"
  // failures in unrelated tests instead of one clear error here.
  const { rows } = await client.query(
    `SELECT count(*)::int AS n FROM pg_tables WHERE schemaname = $1`, [schema],
  );
  if (rows[0].n < 200) {
    throw new Error(`throwaway schema ${schema} has only ${rows[0].n} tables — schema.postgres.sql did not apply`);
  }
  await client.end();

  process.env.VITEST_PG_SCHEMA = schema;
  // Provided so a worker can build its own connection string without reading POSTGRES_URL --
  // which may point somewhere else entirely, and must not win here.
  process.env.VITEST_PG_URL =
    `postgresql://${dsn().user}:${encodeURIComponent(dsn().password)}@${dsn().host}:${dsn().port}/${dsn().database}`;

  return { schema };
}

export async function teardown() {
  if (!schema) return;
  const client = new pg.Client({ ...dsn(), connectionTimeoutMillis: 10_000 });
  await client.connect();
  try {
    await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
  } finally {
    await client.end();
  }
}
