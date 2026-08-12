// Shared ephemeral-Postgres pattern for integration tests: run against the
// real migrated schema, inside a transaction that is always rolled back, so
// tests never leave state behind and never need a separate scratch database.
// BUILD_STAGE_0_2_SPEC.md Task 0.4 explicitly allows this as an alternative to
// Testcontainers.
import pg from 'pg';
import { createPool } from '@greenfield/db';

export async function withScratchTransaction<T>(
  fn: (client: pg.PoolClient) => Promise<T>,
): Promise<T> {
  const pool = createPool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    return await fn(client);
  } finally {
    await client.query('ROLLBACK');
    client.release();
    await pool.end();
  }
}
