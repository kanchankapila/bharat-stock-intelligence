import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'node:fs';
import { TRPCError } from '@trpc/server';

// enqueueSignals is adminProcedure + the per-IP limiter. Stub token verification (same pattern as
// jobsMonitor.test.ts) so the admin caller authenticates without a Firebase round-trip, and stub
// the queue boundary so no test here can enqueue a real LLM job whatever initQueues() state it
// runs in.
const verify = vi.hoisted(() => vi.fn());
vi.mock('../firebaseAdmin', () => ({
  verifyIdToken: verify,
  AuthTokenError: class AuthTokenError extends Error {},
}));
vi.mock('../queues', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../queues')>()),
  enqueueAISignals: vi.fn(async (items: unknown[]) => ({ queued: items.length, queueAvailable: true })),
}));
process.env.ADMIN_UIDS = 'test-admin-uid';

const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const { enqueueAISignals } = await import('../queues');
const { buildSignalBatch, MAX_SIGNAL_BATCH } = await import('../../lib/signalBatch');

const ctx = { req: { headers: { authorization: 'Bearer t' }, ip: '203.0.113.7', socket: {} } } as any;
const caller = createCallerFactory(appRouter)(ctx);
const enqueueMock = vi.mocked(enqueueAISignals);

beforeEach(() => {
  verify.mockReset().mockResolvedValue('test-admin-uid');
  enqueueMock.mockClear();
});

async function errorCodeOf(p: Promise<unknown>): Promise<string> {
  try { await p; return 'NO_ERROR'; } catch (e) { return e instanceof TRPCError ? e.code : `NON_TRPC:${(e as Error).name}`; }
}

// AF-20261025-07 follow-up. The AI Signals REFRESH button on the home page (DashboardPage) is the
// ONLY caller of enqueueSignals. It sent the whole live universe (2,376 symbols live on 2026-10-25)
// but the router caps one call at .max(200) (b810692a, 2026-08-15, comment claimed "tens of
// symbols"). Zod rejected every click with BAD_REQUEST and the component's bare `catch {}` hid it.
const universe = Array.from({ length: 2376 }, (_, i) => ({
  symbol: `SYM${i}`, name: `Sym ${i}`, price: 100, change: 0, changePct: ((i * 37) % 200) / 10 - 10,
  volume: '1M', high: 1, low: 1, open: 1, prevClose: 1,
}));

describe('enqueueSignals batch cap vs the REFRESH button payload', () => {
  it('the payload built from the full live universe is accepted by the router', async () => {
    const payload = buildSignalBatch(universe);
    await expect(caller.enqueueSignals(payload)).resolves.toMatchObject({ queued: payload.length, queueAvailable: true });
    expect(enqueueMock).toHaveBeenCalledTimes(1);
    expect(enqueueMock.mock.calls[0][0]).toHaveLength(payload.length);
  });

  it('the payload is bounded by the shared cap and keeps the largest movers', () => {
    const payload = buildSignalBatch(universe);
    expect(payload.length).toBeLessThanOrEqual(MAX_SIGNAL_BATCH);
    const kept = Math.min(...payload.map(p => Math.abs((p.stockData as any).changePct)));
    const dropped = Math.max(...universe.filter(u => !payload.some(p => p.symbol === u.symbol)).map(u => Math.abs(u.changePct)));
    expect(kept).toBeGreaterThanOrEqual(dropped);
  });

  it('the router cap is exactly MAX_SIGNAL_BATCH: cap accepted, cap+1 rejected', async () => {
    const batch = (n: number) => Array.from({ length: n }, (_, i) => ({ symbol: `S${i}`, stockData: {} }));
    await expect(caller.enqueueSignals(batch(MAX_SIGNAL_BATCH))).resolves.toBeDefined();
    expect(enqueueMock.mock.calls[0][0]).toHaveLength(MAX_SIGNAL_BATCH);
    enqueueMock.mockClear();
    await expect(caller.enqueueSignals(batch(MAX_SIGNAL_BATCH + 1)))
      .rejects.toThrow(new RegExp(`"code":\\s*"too_big"[\\s\\S]*"maximum":\\s*${MAX_SIGNAL_BATCH}\\b`));
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects an unauthenticated caller with UNAUTHORIZED and enqueues nothing', async () => {
    const { AuthTokenError } = await import('../firebaseAdmin');
    verify.mockRejectedValue(new AuthTokenError('Missing bearer token'));
    const anon = createCallerFactory(appRouter)({ req: { headers: {}, ip: '203.0.113.8', socket: {} } } as any);
    expect(await errorCodeOf(anon.enqueueSignals([{ symbol: 'A', stockData: {} }]))).toBe('UNAUTHORIZED');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('rejects a signed-in non-admin caller with FORBIDDEN and enqueues nothing', async () => {
    verify.mockResolvedValue('some-other-uid');
    expect(await errorCodeOf(caller.enqueueSignals([{ symbol: 'A', stockData: {} }]))).toBe('FORBIDDEN');
    expect(enqueueMock).not.toHaveBeenCalled();
  });

  it('keeps the per-IP rate limit on top of admin auth', async () => {
    const limited = createCallerFactory(appRouter)({ req: { headers: { authorization: 'Bearer t' }, socket: { remoteAddress: '198.51.100.99' } } } as any);
    const codes: string[] = [];
    for (let i = 0; i < 25; i++) codes.push(await errorCodeOf(limited.enqueueSignals([])));
    expect(codes.slice(0, 20).every(c => c === 'NO_ERROR')).toBe(true);
    expect(codes.slice(20)).toContain('TOO_MANY_REQUESTS');
  });

  it('DashboardPage builds its payload through buildSignalBatch', () => {
    const src = readFileSync('src/components/DashboardPage.tsx', 'utf8');
    expect(src).toMatch(/buildSignalBatch\(stocks\)/);
    expect(src).not.toMatch(/stocks\.map\(s => \(\{ symbol: s\.symbol, stockData/);
  });
});
