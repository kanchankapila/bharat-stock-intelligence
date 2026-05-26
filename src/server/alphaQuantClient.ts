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
  score: (body: { rebuild?: boolean }) =>
    aqPost<{ message: string }>('/api/v1/score', body),

  backtest: (body: {
    start: string; end: string; horizon: number; min_score: number;
    max_pos: number; capital: number; name?: string;
  }) => aqPost<{ run_id: string }>('/api/v1/backtest', body),

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
