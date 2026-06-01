import axios from 'axios';

const BASE = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT = 300_000;

async function post<T = { status: string }>(
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<T> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  const res = await axios.post<T>(url.toString(), {}, { timeout: timeoutMs });
  return res.data;
}

export const pythonApi = {
  scorePending: () =>
    post('/api/score-pending'),

  resolveOutcomes: (horizon: number) =>
    post('/api/resolve-outcomes', { horizon }),

  trainDL: () =>
    post('/api/train-dl', {}, 6 * 60 * 60_000),

  inferDL: () =>
    post('/api/infer-dl'),
};
