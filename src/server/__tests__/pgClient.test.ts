import { describe, it, expect, beforeEach, vi } from 'vitest';

const mockRelease = vi.fn();
const mockClient = { query: vi.fn(), release: mockRelease };
const mockConnect = vi.fn().mockResolvedValue(mockClient);
const parsers: Record<number, (val: string) => unknown> = {};
vi.mock('pg', () => ({
  Pool: vi.fn().mockImplementation(() => ({ connect: mockConnect, on: vi.fn() })),
  types: {
    setTypeParser: vi.fn((oid: number, fn: (val: string) => unknown) => { parsers[oid] = fn; }),
    builtins: { INT8: 20, TIMESTAMP: 1114 },
  },
}));

const { withClient, alterMigrationName } = await import('../pgClient');

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

  it('parses naive TIMESTAMP columns as UTC, not host local time', () => {
    const parse = parsers[1114];
    expect(parse).toBeTypeOf('function');
    const d = parse('2026-07-17 10:00:00.000') as Date;
    expect(d.toISOString()).toBe('2026-07-17T10:00:00.000Z');
    expect(parse(null as unknown as string)).toBeNull();
  });

  it('derives a stable migration name from an ALTER statement', () => {
    expect(alterMigrationName('ALTER TABLE quant_scores ADD COLUMN IF NOT EXISTS beta_1y            DOUBLE PRECISION'))
      .toBe('alter_quant_scores_beta_1y');
    expect(() => alterMigrationName('DROP TABLE foo')).toThrow();
  });
});
