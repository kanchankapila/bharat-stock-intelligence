import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { SignalResult } from '../technicalSignalsService';

/**
 * sendTelegramSignals — the "NSE DAILY SCAN" Telegram digest. It carries a module-level
 * sent-for-this-date marker, so every test re-imports the module fresh (vi.resetModules +
 * dynamic import) to isolate that state. Its four sibling imports are mocked: importing the
 * real module must not open a DB pool or a WebSocket server in a unit test.
 */
const { mockSend } = vi.hoisted(() => ({ mockSend: vi.fn(async (_text: string) => true) }));

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: mockSend },
  sanitizeMarkdown: (s: string) => s,
}));
vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(async () => undefined),
  dbAll: vi.fn(async () => []),
  dbRun: vi.fn(async () => undefined),
  dbTransaction: vi.fn(),
}));
vi.mock('../websocketService', () => ({ wsSignalService: { broadcastNewSignal: vi.fn() } }));
vi.mock('../deliveryFetcher', () => ({ fetchDeliveryMap: vi.fn(async () => new Map()) }));
vi.mock('../atrBarriers', () => ({ getAtrBarriers: vi.fn() }));

function scanResult(over: Partial<SignalResult> = {}): SignalResult {
  return {
    symbol: 'TCS',
    name: 'Test Co',
    cmp: 3500,
    changePct: 1.2,
    rsi: 55,
    sma50: 3400,
    sma200: 3300,
    macd: 1,
    macdSignal: 0.5,
    bbWidth: 0.2,
    volumeRatio: 1.4,
    aboveSma200: true,
    adx: 25,
    niftyRegime: 'BULL',
    signals: [{ type: 'MACD_CROSSOVER', strength: 'HIGH', detail: 'MACD crossed above signal line' }],
    signalScore: 6,
    entryZone: '₹3,480 – ₹3,520',
    stopLoss: '₹3,380',
    targets: '₹3,650',
    ...over,
  };
}

async function fresh() {
  vi.resetModules();
  return await import('../technicalSignalsService');
}

describe('sendTelegramSignals (NSE DAILY SCAN digest)', () => {
  beforeEach(() => {
    mockSend.mockClear();
    mockSend.mockImplementation(async (_text: string) => true);
  });

  it('sends the digest once per date when results clear the actionable threshold', async () => {
    const svc = await fresh();
    const results = [scanResult(), scanResult({ symbol: 'INFY', name: undefined, signalScore: 5 })];

    await svc.sendTelegramSignals(results, '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const text = mockSend.mock.calls[0][0] as string;
    expect(text).toContain('NSE DAILY SCAN — 2026-09-09');
    expect(text).toContain('TCS');
    expect(text).toContain('INFY');

    // Second scan the same day (the scan runs every 30 min) must not re-send.
    await svc.sendTelegramSignals(results, '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  // 2026-11-13 (AF-20261113-05): the sent-date marker was in memory only, so every bharat-server
  // restart repeated the day's digest (11-12 17:50 restart: a second "NSE DAILY SCAN 2026-11-12"
  // at 19:08), which is why restarts were avoided between 08:30 and 16:00.
  it('does not resend after a restart: the date a previous process already sent is read from the database', async () => {
    const svc = await fresh();
    const db = await import('../dbAsync');
    (db.dbGet as any).mockResolvedValue({ value: '2026-09-09' });
    await svc.sendTelegramSignals([scanResult()], '2026-09-09');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('still sends when the persisted date is an earlier day, and records the new date durably', async () => {
    const svc = await fresh();
    const db = await import('../dbAsync');
    (db.dbGet as any).mockResolvedValue({ value: '2026-09-08' });
    await svc.sendTelegramSignals([scanResult()], '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(1);
    const writes = (db.dbRun as any).mock.calls as Array<[string, unknown[]]>;
    expect(writes.some(([sql, params]) => /app_settings/.test(sql) && params.includes('technical_scan_digest_sent_date') && params.includes('2026-09-09'))).toBe(true);
  });

  it('sends nothing when no result clears the actionable threshold', async () => {
    const svc = await fresh();
    await svc.sendTelegramSignals([scanResult({ signalScore: 4 })], '2026-09-09');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('applies the BEAR-regime tightened threshold of 7', async () => {
    const svc = await fresh();
    await svc.sendTelegramSignals([scanResult({ niftyRegime: 'BEAR', signalScore: 6 })], '2026-09-09');
    expect(mockSend).not.toHaveBeenCalled();

    await svc.sendTelegramSignals([scanResult({ niftyRegime: 'BEAR', signalScore: 7 })], '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(1);
  });

  it('excludes bearish-labeled signal types from the BUY-picks digest', async () => {
    const svc = await fresh();
    await svc.sendTelegramSignals([scanResult({ signals: [{ type: 'DEATH_CROSS', strength: 'HIGH', detail: 'x' }] })], '2026-09-09');
    expect(mockSend).not.toHaveBeenCalled();
  });

  it('allows the next scan slot to retry when the send fails', async () => {
    const svc = await fresh();
    mockSend.mockImplementation(async (_text: string) => false);

    await svc.sendTelegramSignals([scanResult()], '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(1);

    // The failed day is NOT marked sent, so the next 30-min slot retries it.
    await svc.sendTelegramSignals([scanResult()], '2026-09-09');
    expect(mockSend).toHaveBeenCalledTimes(2);
  });
});