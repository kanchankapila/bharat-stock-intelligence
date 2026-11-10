import { test } from 'node:test';
import assert from 'node:assert/strict';
import { testDatabaseConfig, inspectTestDatabase } from './test_database_preflight.mjs';

test('requires an explicit database name and keeps production URL out of the connection', () => {
  assert.throws(() => testDatabaseConfig({}), /PGTEST_DB/);
  assert.throws(() => testDatabaseConfig({ PGTEST_DB: '  ' }), /PGTEST_DB/);
  const config = testDatabaseConfig({ PGTEST_DB: 'separate_test', POSTGRES_URL: 'postgresql://production/real' });
  assert.equal(config.database, 'separate_test');
  assert.equal(config.host, '127.0.0.1');
  assert.equal(config.connectionString, undefined);
});

test('rejects a database with user tables, even when the name looks like a test database', async () => {
  const client = { query: async () => ({ rows: [{ schema_name: 'public', relation_name: 'unified_recommendations' }] }) };
  const result = await inspectTestDatabase(client);
  assert.equal(result.ok, false);
  assert.match(result.reason, /public\.unified_recommendations/);
});

test('an empty user-table inventory passes only this preflight', async () => {
  const client = { query: async () => ({ rows: [] }) };
  assert.equal((await inspectTestDatabase(client)).ok, true);
});

test('database inspection errors cannot be mistaken for an empty target', async () => {
  const client = { query: async () => { throw new Error('permission denied'); } };
  await assert.rejects(inspectTestDatabase(client), /permission denied/);
});
