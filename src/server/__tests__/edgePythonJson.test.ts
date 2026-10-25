import { beforeEach, describe, expect, it, vi } from 'vitest';

const { rows } = vi.hoisted(() => ({ rows: vi.fn() }));
vi.mock('../dbAsync', () => ({ dbAll: rows, dbGet: vi.fn() }));
const { edgeRouter } = await import('../routers/edge.router');
const caller = edgeRouter.createCaller({} as any);

describe('edge report Python JSON boundary', () => {
  beforeEach(() => rows.mockReset());
  it('normalizes bare non-finite numbers without rewriting quoted keys or string values', async () => {
    const value = JSON.stringify({ note: 'NaN and Infinity and -Infinity', Infinity: 'NaN',
      metric: '__RAW_NAN__', other: ['__RAW_INF__', '__RAW_NEG_INF__'], escaped: 'quoted "NaN" and slash \\' })
      .replace('"__RAW_NAN__"', 'NaN').replace('"__RAW_INF__"', 'Infinity').replace('"__RAW_NEG_INF__"', '-Infinity');
    rows.mockResolvedValue([{ key: 'forward_test_report', asof: '2026-10-25',
      value }]);
    const result = await caller.getEdgeStatus();
    expect(result.forwardTest).not.toBeNull();
    expect(result.forwardTest).toEqual({ note: 'NaN and Infinity and -Infinity', Infinity: 'NaN',
      metric: null, other: [null, null], escaped: 'quoted "NaN" and slash \\' });
  });
  it('keeps valid finite JSON unchanged and rejects malformed input', async () => {
    rows.mockResolvedValue([{ key: 'accuracy_scorecard', asof: null, value: '{"value":0,"note":"Infinity growth"}' }]);
    expect((await caller.getEdgeStatus()).scorecard).toEqual({ value: 0, note: 'Infinity growth' });
    rows.mockResolvedValue([{ key: 'forward_test_report', asof: null, value: '{"broken":' }]);
    expect((await caller.getEdgeStatus()).forwardTest).toBeNull();
  });
});
