import { describe, it, expect, vi, beforeEach } from 'vitest';

const resolveOutcomes = vi.fn();
const runPython = vi.fn();
vi.mock('../pythonApi', () => ({ pythonApi: { resolveOutcomes: (h: number) => resolveOutcomes(h) } }));
vi.mock('../pythonRunner', () => ({ runPython: (...a: unknown[]) => runPython(...a) }));

import { resolveOutcomesResilient } from '../jobs/operations.jobs';

describe('resolveOutcomesResilient', () => {
  beforeEach(() => { resolveOutcomes.mockReset(); runPython.mockReset(); });

  it('falls back to the script when ml-api is unreachable', async () => {
    resolveOutcomes.mockRejectedValue(Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:8000'), { code: 'ECONNREFUSED' }));
    runPython.mockResolvedValue('ok');
    await resolveOutcomesResilient(1);
    expect(runPython).toHaveBeenCalledWith('outcome_resolver.py', ['--horizon', '1'], 180_000);
  });

  // AF-20260930-29: a client timeout does not stop the server-side run (2026-09-30 it finished
  // at 09:43, 12 min in), so the fallback was a SECOND resolver on the same rows.
  it('does not start a second resolver when the ml-api call times out', async () => {
    resolveOutcomes.mockRejectedValue(Object.assign(new Error('timeout of 300000ms exceeded'), { code: 'ECONNABORTED' }));
    await expect(resolveOutcomesResilient(1)).rejects.toThrow(/still running in ml-api/);
    expect(runPython).not.toHaveBeenCalled();
  });
});
