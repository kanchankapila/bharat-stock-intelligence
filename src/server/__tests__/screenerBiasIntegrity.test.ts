import { expect, it, vi } from 'vitest';
vi.mock('../dbAsync', () => ({ dbGet: vi.fn(), dbAll: vi.fn(), dbRun: vi.fn(), dbExec: vi.fn() }));
import { DATA_QUALITY_CHECKS } from '../dataQualityChecks';

it('detects wrong-but-synchronized labels and source aliases', () => {
  const check = DATA_QUALITY_CHECKS.find(c => c.id === 'screener-semantic-bias-integrity')!;
  expect(check).toBeDefined();
  expect(check.evaluate({ policy_active: true, entries: [
    { name: 'Bullish Engulfing Pattern (Bullish Reversal)', bias: 'bearish' },
    { name: 'Volume Shockers', bias: 'bullish' },
  ] }, new Date()).status).toBe('fail');
  expect(check.evaluate({ entries: [
    { name: 'Bullish Engulfing Pattern (Bullish Reversal)', bias: 'bullish' },
    { name: 'Volume Shockers', bias: 'neutral' },
  ] }, new Date()).status).toBe('pass');
  expect(check.evaluate({ entries: [] }, new Date()).status).toBe('fail');
});
