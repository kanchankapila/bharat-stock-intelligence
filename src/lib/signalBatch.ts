/** Server-side ceiling on one `enqueueSignals` call (each element becomes an LLM-queue job). */
export const MAX_SIGNAL_BATCH = 200;

/** Index rows that sit inside the live `stocks` list; DashboardPage looks the headline one up by these. */
export const INDEX_SYMBOLS = ['NIFTY', 'NIFTY50'];

export const QUEUE_UNAVAILABLE_MESSAGE = 'AI signal queue is unavailable -- nothing was queued.';

export interface SignalBatchStock { symbol: string; changePct: number }

/** The REFRESH button's payload: the live universe is ~2,400 names, so send the biggest movers. */
export function buildSignalBatch<T extends SignalBatchStock>(stocks: T[]) {
  return stocks
    .filter(s => Number.isFinite(s.changePct) && !INDEX_SYMBOLS.includes(s.symbol))
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol))
    .slice(0, MAX_SIGNAL_BATCH)
    .map(s => ({ symbol: s.symbol, stockData: s as unknown as Record<string, unknown> }));
}

/** What the REFRESH button shows when the enqueue call throws (carries the TRPCError message). */
export function refreshFailureMessage(err: unknown): string {
  const msg = err instanceof Error ? err.message : '';
  return msg ? `AI signal refresh failed: ${msg}` : 'AI signal refresh failed.';
}
