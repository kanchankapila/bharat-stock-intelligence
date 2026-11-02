import { describe, expect, it, vi } from 'vitest';

const post = vi.hoisted(() => vi.fn(async () => ({ data: { status: 'success' } })));
vi.mock('axios', () => ({ default: { post } }));
vi.mock('../localServiceRetry', () => ({
  retryOnConnectionError: (fn: () => unknown) => fn(),
}));

import { pythonApi } from '../pythonApi';

describe('outcome resolution timeout', () => {
  it('allows the one-day resolver more than its observed five-minute runtime', async () => {
    await pythonApi.resolveOutcomes(1);
    expect(post).toHaveBeenCalledWith(expect.stringContaining('horizon=1'), {}, { timeout: 600_000 });
  });
});
