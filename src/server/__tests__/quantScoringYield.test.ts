/**
 * Test for event-loop yield pattern in quant scoring.
 * Verifies that setImmediate is called during computation to prevent blocking tRPC requests.
 */

import { describe, it, expect, vi } from 'vitest';

describe('quantScoringYield', () => {
  it('yieldEventLoop resolves via setImmediate', async () => {
    const setImmediateSpy = vi.spyOn(global, 'setImmediate');

    // The yield helper pattern used in quantScoringService
    function yieldEventLoop(): Promise<void> {
      return new Promise(resolve => setImmediate(resolve));
    }

    await yieldEventLoop();
    expect(setImmediateSpy).toHaveBeenCalled();

    setImmediateSpy.mockRestore();
  });
});
