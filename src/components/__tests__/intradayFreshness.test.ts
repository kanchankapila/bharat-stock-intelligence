import { describe, expect, it } from 'vitest';
import { intradayFeedsAreLive } from '../intradayFreshness';

describe('intraday live indicator', () => {
  it('requires both feeds to have reported fresh data', () => {
    const fresh = { isStale: false };
    const stale = { isStale: true };
    expect(intradayFeedsAreLive(undefined, undefined)).toBe(false);
    expect(intradayFeedsAreLive(fresh, undefined)).toBe(false);
    expect(intradayFeedsAreLive(undefined, fresh)).toBe(false);
    expect(intradayFeedsAreLive({}, fresh)).toBe(false);
    expect(intradayFeedsAreLive(stale, fresh)).toBe(false);
    expect(intradayFeedsAreLive(fresh, stale)).toBe(false);
    expect(intradayFeedsAreLive(fresh, fresh, true)).toBe(false);
    expect(intradayFeedsAreLive(fresh, fresh)).toBe(true);
  });
});
