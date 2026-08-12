// Task 0.4: "a trivial integration test creates a security row and reads it
// back." Runs against the real docker-compose Postgres (migrated schema),
// wrapped in BEGIN/ROLLBACK so it is ephemeral -- a per-run scratch state on
// a real database, per the alternative BUILD_STAGE_0_2_SPEC.md §Task 0.4 allows
// ("Testcontainers or a per-run scratch schema").
import { afterAll, beforeAll, expect, test } from 'vitest';
import pg from 'pg';
import { createPool } from './index.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

let pool: pg.Pool;
let client: pg.PoolClient;

beforeAll(async () => {
  pool = createPool();
  client = await pool.connect();
  await client.query('BEGIN');
});

afterAll(async () => {
  await client.query('ROLLBACK');
  client.release();
  await pool.end();
});

test('creates a security row and reads it back', async () => {
  await client.query(
    `INSERT INTO security (symbol, name, exchange, status, listed_from)
     VALUES ($1, $2, 'NSE', 'listed', $3)`,
    ['ZZZTESTCO', 'ZZZ Test Company', '2021-01-04'],
  );

  const { rows } = await client.query('SELECT symbol, name, status FROM security WHERE symbol = $1', ['ZZZTESTCO']);

  expect(rows).toHaveLength(1);
  expect(rows[0]).toEqual({ symbol: 'ZZZTESTCO', name: 'ZZZ Test Company', status: 'listed' });
});
