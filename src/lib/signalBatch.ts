/** Server-side ceiling on one `enqueueSignals` call (each element becomes an LLM-queue job). */
export const MAX_SIGNAL_BATCH = 200;

export interface SignalBatchStock { symbol: string; changePct: number }

/** The REFRESH button's payload: the live universe is ~2,400 names, so send the biggest movers. */
export function buildSignalBatch<T extends SignalBatchStock>(stocks: T[]) {
  return [...stocks]
    .sort((a, b) => Math.abs(b.changePct) - Math.abs(a.changePct) || a.symbol.localeCompare(b.symbol))
    .slice(0, MAX_SIGNAL_BATCH)
    .map(s => ({ symbol: s.symbol, stockData: s as unknown as Record<string, unknown> }));
}
