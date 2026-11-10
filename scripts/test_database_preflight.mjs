#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import pg from 'pg';

export function testDatabaseConfig(env) {
  const database = env.PGTEST_DB?.trim();
  if (!database) throw new Error('Set PGTEST_DB explicitly to a dedicated test database.');
  return {
    host: env.PGTEST_HOST || '127.0.0.1',
    port: Number(env.PGTEST_PORT || 5433),
    user: env.PGTEST_USER || 'bharat',
    password: env.PGTEST_PASSWORD || 'bharat',
    database,
    connectionTimeoutMillis: 5000,
    options: '-c default_transaction_read_only=on -c statement_timeout=5000',
  };
}

export async function inspectTestDatabase(client) {
  const { rows } = await client.query(`
    SELECT n.nspname AS schema_name, c.relname AS relation_name
    FROM pg_catalog.pg_class c
    JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
    WHERE c.relkind IN ('r', 'p', 'f', 'm')
      AND n.nspname NOT LIKE 'pg\\_%' ESCAPE '\\'
      AND n.nspname <> 'information_schema'
      AND n.nspname NOT LIKE '\\_timescaledb\\_%' ESCAPE '\\'
      AND n.nspname NOT LIKE 'timescaledb\\_%' ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1 FROM pg_catalog.pg_depend d
        WHERE d.classid = 'pg_catalog.pg_class'::regclass AND d.objid = c.oid
          AND d.refclassid = 'pg_catalog.pg_extension'::regclass AND d.deptype = 'e'
      )
    ORDER BY n.nspname, c.relname LIMIT 10`);
  if (rows.length) {
    return { ok: false, reason: `User relations exist: ${rows.map(r => `${r.schema_name}.${r.relation_name}`).join(', ')}` };
  }
  return { ok: true, reason: 'No user tables, foreign tables or materialized views found in inspected schemas.' };
}

async function main() {
  const config = testDatabaseConfig(process.env);
  const client = new pg.Client(config);
  try {
    await client.connect();
    const result = await inspectTestDatabase(client);
    console.log(`Test target ${config.host}:${config.port}/${config.database}: ${result.reason}`);
    if (!result.ok) process.exitCode = 1;
    else console.log('This read-only preflight is a snapshot, not proof that every test uses this target or is safe.');
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(err => { console.error(`Test database preflight failed: ${err.message}`); process.exitCode = 1; });
}
