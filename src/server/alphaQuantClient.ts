const ALPHAQUANT_BASE = process.env.ALPHAQUANT_URL ?? 'http://127.0.0.1:8002';

async function aqPost<T>(path: string, body: unknown, timeoutMs = 15_000): Promise<T> {
  const res = await fetch(`${ALPHAQUANT_BASE}${path}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AlphaQuant ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

async function aqGet<T>(path: string, timeoutMs = 10_000): Promise<T> {
  const res = await fetch(`${ALPHAQUANT_BASE}${path}`, {
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`AlphaQuant ${path} failed (${res.status}): ${text.slice(0, 500)}`);
  }
  return res.json() as Promise<T>;
}

export const alphaQuant = {
  // Measured ~65s standalone, but this is the last step of the daily stock-scoring
  // pipeline (after Trendlyne/MC/ETnow syncs already ran AlphaQuant enrichment calls
  // against the same single-worker FastAPI process) — under that contention the 10-min
  // ceiling was hit 5/5 recent runs, aborting after all the preceding sync work. This is
  // a once-daily batch job with no interactivity requirement, so give it real headroom.
  score: (body: { rebuild?: boolean }) =>
    aqPost<{ message: string }>('/api/v1/score', body, 30 * 60_000),

  backtest: (body: {
    start: string; end: string; horizon: number; min_score: number;
    max_pos: number; capital: number; name?: string;
  }) => aqPost<{ run_id: string }>('/api/v1/backtest', body),

  // Runs a differential_evolution search per fold (default: rolling 365d IS / 90d OOS
  // windows), each fold simulating trades ~200 times — real multi-minute-per-fold cost,
  // so give it the same headroom as the daily score job rather than backtest's default.
  walkForwardOptimize: (body: {
    start: string; end: string; mode?: 'rolling' | 'anchored';
    n_folds?: number; is_days?: number; oos_days?: number; step_days?: number;
    optimize?: boolean; objective?: 'sharpe' | 'sortino';
    min_score?: number; horizon?: number; max_pos?: number; capital?: number; name?: string;
  }) => aqPost<{ run_id?: number; mode: string; objective: string; folds: any[]; combined: any }>(
    '/api/v1/walk-forward-optimize', body, 45 * 60_000),

  optimize: (body: { horizon_days: number; iterations: number; apply: boolean }) =>
    aqPost<{ improvement_pct: number }>('/api/v1/optimize', body),

  getPcr: (body: { symbols?: string[]; delay?: number }, timeoutMs = 60_000) =>
    aqPost<any>('/api/v1/options/pcr', body, timeoutMs),

  analyzePortfolio: (body: { symbols: string[]; weights: number[] }) =>
    aqPost<any>('/api/v1/portfolio/analyze', body),

  getTvTa: (body: { symbol: string; exchange: string }) =>
    aqPost<any>('/api/v1/tv/ta', body),

  getTvScreener: () =>
    aqGet<any>('/api/v1/tv/screener'),
};
