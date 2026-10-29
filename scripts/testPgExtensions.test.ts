import { describe, expect, it, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import type pg from 'pg';
import { bootstrapTestExtensions } from '../vitest.globalSetup';

const lock = "SELECT pg_advisory_lock(hashtext('bsi_test_extensions'), 0)";
const unlock = "SELECT pg_advisory_unlock(hashtext('bsi_test_extensions'), 0)";

describe('test-only extension bootstrap', () => {
  it('serializes extension creation in public, outside disposable schemas', async () => {
    const query = vi.fn().mockResolvedValue({ rows: [] });
    await bootstrapTestExtensions({ query } as unknown as pg.Client,
      'CREATE EXTENSION IF NOT EXISTS pg_trgm;\nCREATE EXTENSION IF NOT EXISTS pg_stat_statements;');
    expect(query.mock.calls.map(([sql]) => sql)).toEqual([
      lock,
      'CREATE EXTENSION IF NOT EXISTS "pg_stat_statements" WITH SCHEMA public',
      'CREATE EXTENSION IF NOT EXISTS "pg_trgm" WITH SCHEMA public',
      unlock,
    ]);
  });

  it('releases the shared lock and preserves an extension creation failure', async () => {
    const error = new Error('extension installation failed');
    const query = vi.fn().mockImplementation(async (sql: string) => {
      if (sql.startsWith('CREATE EXTENSION')) throw error;
      return { rows: [] };
    });
    await expect(bootstrapTestExtensions({ query } as unknown as pg.Client,
      'CREATE EXTENSION IF NOT EXISTS pg_trgm;')).rejects.toBe(error);
    expect(query.mock.calls.at(-1)?.[0]).toBe(unlock);
  });

  it('uses the same database-scoped lock as Python rather than independent runner locks', () => {
    const python = readFileSync(new URL('../src/server/pg_test_support.py', import.meta.url), 'utf8');
    expect(python).toContain(lock);
    expect(python).toContain(unlock);
  });
});
