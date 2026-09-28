import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRelease = vi.fn();
const mockClient = { query: vi.fn(), release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
const parsers: Record<number, (val: string) => unknown> = {};
vi.mock('pg', () => ({
  // `end` is not optional: vitest.setup.ts's afterAll calls closePool() for every file, and a
  // Pool mock without it fails the whole suite with "pool.end is not a function".
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect, on: vi.fn(), end: vi.fn() })),
  types: {
    setTypeParser: vi.fn((oid: number, fn: (val: string) => unknown) => { parsers[oid] = fn; }),
    builtins: { INT8: 20, TIMESTAMP: 1114, NUMERIC: 1700 },
  },
}));

const { withClient, withTransientRetry, alterMigrationName, isTransientConnError } = await import('../pgClient');

describe('pgClient', () => {
  beforeEach(() => {
    mockRelease.mockClear();
    mockConnect.mockClear();
  });

  it('withClient releases client after success', async () => {
    const result = await withClient(async (c) => {
      return 42;
    });
    expect(result).toBe(42);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('withClient releases client even when fn throws', async () => {
    mockRelease.mockClear();
    await expect(
      withClient(async () => {
        throw new Error('boom');
      }),
    ).rejects.toThrow('boom');
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('retries a transient pool checkout before returning a client', async () => {
    mockConnect
      .mockRejectedValueOnce(new Error('timeout exceeded when trying to connect'))
      .mockResolvedValueOnce(mockClient);
    const result = await withClient(async () => 'after-retry');
    expect(result).toBe('after-retry');
    expect(mockConnect).toHaveBeenCalledTimes(2);
    expect(mockRelease).toHaveBeenCalledTimes(1);
  });

  it('classifies the exact pg-pool checkout timeout as transient', () => {
    expect(isTransientConnError(new Error('timeout exceeded when trying to connect'))).toBe(true);
  });

  // AF-20260929-02: pgQuery/pgClient() each hand-rolled this loop; it was extracted so callers
  // with a longer tolerance for pool starvation (the data-quality sweep, the monitor's
  // getLastRunAt probes) can pass a wider schedule instead of duplicating it. These pin the
  // semantics those callers now depend on.
  describe('withTransientRetry', () => {
    it('retries a transient error and returns the eventual value', async () => {
      let calls = 0;
      const result = await withTransientRetry(async () => {
        calls += 1;
        if (calls === 1) throw new Error('timeout exceeded when trying to connect');
        return 'after-retry';
      }, [0, 0]);
      expect(result).toBe('after-retry');
      expect(calls).toBe(2);
    });

    it('does NOT retry a non-transient error (a real bug must surface immediately)', async () => {
      let calls = 0;
      await expect(withTransientRetry(async () => {
        calls += 1;
        throw new Error('column "foo" does not exist');
      }, [0, 0])).rejects.toThrow('does not exist');
      expect(calls).toBe(1);
    });

    it('exhausts the budget then rethrows the LAST transient error', async () => {
      let calls = 0;
      await expect(withTransientRetry(async () => {
        calls += 1;
        throw new Error(`timeout exceeded when trying to connect (attempt ${calls})`);
      }, [0, 0])).rejects.toThrow('attempt 3'); // delays.length + 1 attempts
      expect(calls).toBe(3);
    });
  });

  it('parses naive TIMESTAMP columns as UTC, not host local time', () => {
    const parse = parsers[1114];
    expect(parse).toBeTypeOf('function');
    const d = parse('2026-07-17 10:00:00.000') as Date;
    expect(d.toISOString()).toBe('2026-07-17T10:00:00.000Z');
    expect(parse(null as unknown as string)).toBeNull();
  });

  it('parses NUMERIC columns as JS numbers, not strings (e.g. ROUND()-produced growth_pct)', () => {
    const parse = parsers[1700];
    expect(parse).toBeTypeOf('function');
    const parsed = parse('12.34');
    expect(parsed).toBe(12.34);
    expect(typeof parsed).toBe('number');
    expect((parsed as number).toFixed(2)).toBe('12.34');
    expect(parse(null as unknown as string)).toBeNull();
  });

  it('derives a stable migration name from an ALTER ADD COLUMN statement', () => {
    expect(alterMigrationName('ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS beta_1y            DOUBLE PRECISION'))
      .toBe('alter_quant_scores_beta_1y');
    expect(() => alterMigrationName('DROP TABLE foo')).toThrow();
  });

  it('derives a stable migration name from an ALTER ADD CONSTRAINT statement', () => {
    expect(alterMigrationName(
      "ALTER TABLE confluence_signals ADD CONSTRAINT chk_confluence_signals_symbol_not_url CHECK (symbol NOT LIKE '%://%')"
    )).toBe('alter_confluence_signals_chk_confluence_signals_symbol_not_url');
  });
});
