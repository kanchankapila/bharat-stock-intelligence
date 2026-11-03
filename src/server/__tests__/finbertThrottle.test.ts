import { vi, describe, test, expect, beforeEach } from 'vitest';
import fs from 'fs';

const dbAll = vi.fn();
const dbRun = vi.fn();
vi.mock('../dbAsync', () => ({
  dbGet: vi.fn().mockResolvedValue(undefined),
  dbAll: (...a: unknown[]) => dbAll(...a),
  dbRun: (...a: unknown[]) => dbRun(...a),
  dbTransaction: vi.fn(),
}));
const runPython = vi.fn();
vi.mock('../pythonRunner', () => ({ runPython: (...a: unknown[]) => runPython(...a) }));

const HOUR = 60 * 60 * 1000;
const ITEMS = [
  { id: 'a', title: 'Profit jumps', summary: 'x', category: 'EARNINGS' },
  { id: 'b', title: 'Fraud probe', summary: 'y', category: 'GENERAL' },
];

async function load() {
  vi.resetModules();
  return import('../newsSentimentService');
}

describe('shouldRunFinBERT', () => {
  test('nothing pending never runs', async () => {
    const { shouldRunFinBERT } = await load();
    expect(shouldRunFinBERT(10 * HOUR, null, 0)).toBe(false);
    expect(shouldRunFinBERT(10 * HOUR, 0, 0)).toBe(false);
  });
  test('pending inside the interval waits', async () => {
    const { shouldRunFinBERT, FINBERT_MIN_INTERVAL_MS } = await load();
    expect(FINBERT_MIN_INTERVAL_MS).toBe(HOUR);
    expect(shouldRunFinBERT(HOUR - 1, 0, 5)).toBe(false);
  });
  test('pending past the interval runs', async () => {
    const { shouldRunFinBERT } = await load();
    expect(shouldRunFinBERT(HOUR, 0, 5)).toBe(true);
  });
  test('no previous run means run', async () => {
    const { shouldRunFinBERT } = await load();
    expect(shouldRunFinBERT(1, null, 1)).toBe(true);
  });
});

describe('enrichPendingFinBERT', () => {
  beforeEach(() => {
    dbAll.mockReset().mockResolvedValue(ITEMS);
    dbRun.mockReset();
    runPython.mockReset().mockResolvedValue({ stdout: '[]', stderr: '' });
  });

  test('loads the model at most once per interval even though unscored rows persist', async () => {
    const { enrichPendingFinBERT } = await load();
    const t0 = 1_000 * HOUR;
    await enrichPendingFinBERT(t0);
    await enrichPendingFinBERT(t0 + 15 * 60_000);
    await enrichPendingFinBERT(t0 + 45 * 60_000);
    expect(runPython).toHaveBeenCalledTimes(1);
    await enrichPendingFinBERT(t0 + HOUR);
    expect(runPython).toHaveBeenCalledTimes(2);
  });

  test('a failed attempt still counts, so a broken model does not reload every cycle', async () => {
    const { enrichPendingFinBERT } = await load();
    runPython.mockRejectedValue(new Error('boom'));
    const t0 = 1_000 * HOUR;
    await enrichPendingFinBERT(t0);
    await enrichPendingFinBERT(t0 + 15 * 60_000);
    expect(runPython).toHaveBeenCalledTimes(1);
  });

  test('skipped cycles leave rows eligible: selection is every unscored HIGH row, not this cycle\'s arrivals', async () => {
    const { enrichPendingFinBERT, FINBERT_BATCH_LIMIT } = await load();
    await enrichPendingFinBERT(1_000 * HOUR);
    const sql = String(dbAll.mock.calls[0][0]);
    expect(sql).toMatch(/impact = 'HIGH' AND ai_scored = 0/);
    expect(sql).toContain(`LIMIT ${FINBERT_BATCH_LIMIT}`);
    expect(sql).not.toMatch(/fetched_at\s*>/);
    expect(dbRun).not.toHaveBeenCalled();
  });

  test('batch is sized above the measured p95 hourly arrival rate (114/h, 14d to 2026-11-03)', async () => {
    const { FINBERT_BATCH_LIMIT } = await load();
    expect(FINBERT_BATCH_LIMIT).toBeGreaterThan(114);
  });

  test('payload travels in a file, not argv: 150 items overflow the 32,767-char Windows command line', async () => {
    const { enrichPendingFinBERT } = await load();
    let seen: unknown;
    runPython.mockImplementation(async (_s: string, args: string[]) => {
      expect(args).toHaveLength(1);
      expect(args[0].startsWith('@')).toBe(true);
      seen = JSON.parse(fs.readFileSync(args[0].slice(1), 'utf-8'));
      return { stdout: '[{"id":"a","sentiment":"BULLISH","score":0.9}]', stderr: '' };
    });
    await enrichPendingFinBERT(1_000 * HOUR);
    expect((seen as { id: string }[]).map(p => p.id)).toEqual(['a', 'b']);
    expect(dbRun).toHaveBeenCalledWith(expect.stringContaining('ai_scored=1'), ['BULLISH', 0.9, 'a']);
    const file = (runPython.mock.calls[0][1] as string[])[0].slice(1);
    expect(fs.existsSync(file)).toBe(false);
  });

  test('nothing pending does not touch the model', async () => {
    const { enrichPendingFinBERT } = await load();
    dbAll.mockResolvedValue([]);
    await enrichPendingFinBERT(1_000 * HOUR);
    expect(runPython).not.toHaveBeenCalled();
  });
});
