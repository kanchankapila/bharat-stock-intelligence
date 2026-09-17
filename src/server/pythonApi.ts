import axios from 'axios';
import { retryOnConnectionError } from './localServiceRetry';

const BASE = process.env.PYTHON_API_URL ?? 'http://127.0.0.1:8000';
const DEFAULT_TIMEOUT = 300_000;

async function post<T = { status: string }>(
  path: string,
  params: Record<string, string | number> = {},
  timeoutMs = DEFAULT_TIMEOUT,
): Promise<T> {
  const url = new URL(path, BASE);
  for (const [k, v] of Object.entries(params)) url.searchParams.set(k, String(v));
  // ml-api is a pm2 app on this host: a restart makes :8000 refuse connections for seconds.
  // Only the unreachable case retries -- an HTTP error from the service is a real failure.
  const res = await retryOnConnectionError(
    () => axios.post<T>(url.toString(), {}, { timeout: timeoutMs }), { label: `ml-api ${path}` });
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
