import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockDbAll = vi.hoisted(() => vi.fn());
const mockDbRun = vi.hoisted(() => vi.fn());
const mockSend = vi.hoisted(() => vi.fn());
vi.mock('../dbAsync', () => ({ dbAll: mockDbAll, dbRun: mockDbRun }));
vi.mock('../telegramService', () => ({
  sanitizeMarkdown: (s: string) => s,
  telegramService: { sendMarkdownMessage: mockSend },
}));

import { checkRecPlanHits, detectPlanHits, type PlanBarRow } from '../recPlanAlerts';

const row = (o: Partial<PlanBarRow>): PlanBarRow => ({
  id: 1, symbol: 'ABC', stop_loss: 95, trailing_stop: null, target_1: 110,
  stop_alerted_at: null, target_alerted_at: null, day_low: 100, day_high: 105, ...o,
});

describe('detectPlanHits (AF-20261117-15)', () => {
  it('uses the trailing stop when it has ratcheted above the published stop', () => {
    const [hit] = detectPlanHits([row({ trailing_stop: 101, day_low: 100.5 })]);
    expect(hit).toMatchObject({ kind: 'TRAILING_STOP', level: 101, price: 100.5 });
  });

  it('flags a target reached and stays silent when no level is touched', () => {
    expect(detectPlanHits([row({ day_high: 111 })])).toEqual([
      expect.objectContaining({ kind: 'TARGET', level: 110 }),
    ]);
    expect(detectPlanHits([row({})])).toEqual([]);
  });

  it('never re-alerts, and sends no target alert after a stop-out', () => {
    expect(detectPlanHits([row({ day_low: 90, stop_alerted_at: '2026-11-18' })])).toEqual([]);
    expect(detectPlanHits([row({ day_high: 120, stop_alerted_at: '2026-11-18' })])).toEqual([]);
    expect(detectPlanHits([row({ day_high: 120, target_alerted_at: '2026-11-18' })])).toEqual([]);
  });
});

describe('checkRecPlanHits delivery', () => {
  beforeEach(() => { mockDbAll.mockReset(); mockDbRun.mockReset(); mockSend.mockReset(); });

  it('stamps the alerted rows only after Telegram accepts the message', async () => {
    mockDbAll.mockResolvedValue([row({ id: 7, day_low: 90 }), row({ id: 8, day_high: 112 })]);
    mockSend.mockResolvedValue(true);
    const res = await checkRecPlanHits(new Date('2026-11-18T06:00:00Z'));
    expect(res.alerted).toBe(2);
    expect(String(mockSend.mock.calls[0][0])).toContain('2026-11-18');
    const sql = mockDbRun.mock.calls.map(c => [String(c[0]), c[1]]);
    expect(sql).toEqual([
      [expect.stringContaining('stop_alerted_at = now()'), [7]],
      [expect.stringContaining('target_alerted_at = now()'), [8]],
    ]);
    expect(mockDbAll.mock.calls[0][1]).toEqual(['2026-11-18T09:15:00+05:30', '2026-11-18']);
  });

  it('throws and leaves rows unstamped when delivery fails, so the next tick retries', async () => {
    mockDbAll.mockResolvedValue([row({ day_low: 90 })]);
    mockSend.mockResolvedValue(false);
    await expect(checkRecPlanHits()).rejects.toThrow(/delivery failed/);
    expect(mockDbRun).not.toHaveBeenCalled();
  });
});
