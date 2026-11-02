import { afterEach, describe, expect, it } from 'vitest';
import { dsn } from '../../../vitest.globalSetup';

describe('Vitest database selection', () => {
  const original = process.env.PGTEST_DB;
  afterEach(() => {
    if (original === undefined) delete process.env.PGTEST_DB;
    else process.env.PGTEST_DB = original;
  });

  it('requires an explicit database instead of silently selecting the production default', () => {
    delete process.env.PGTEST_DB;
    expect(() => dsn()).toThrow(/Set PGTEST_DB explicitly/);
    process.env.PGTEST_DB = '  ';
    expect(() => dsn()).toThrow(/Set PGTEST_DB explicitly/);
    process.env.PGTEST_DB = 'dedicated_test_db';
    expect(dsn().database).toBe('dedicated_test_db');
  });
});
