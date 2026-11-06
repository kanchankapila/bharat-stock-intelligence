import { expect, it, vi } from 'vitest';
vi.mock('../dbAsync', () => ({ dbAll: vi.fn(), dbTransaction: vi.fn() }));
import { computeScreenerKey, normalizeEtSupportFilter, type EtMarketstatsScreenerDef } from '../etMarketstats';

it('corrects the support comparison under a new identity and preserves the old definition', () => {
  const old = { label: 'Negative Breakout First Support', endpoint: 'technical-data', viewId: 1,
    firstOperand: 'lastTradedPrice', operationType: 'Above', secondOperand: 'supportLevel1',
    apiType: null, duration: null, timespan: null, screenerPageUrl: null } as const;
  const corrected = normalizeEtSupportFilter(old);
  expect(corrected.operationType).toBe('Below');
  expect(old.operationType).toBe('Above');
  expect(computeScreenerKey(corrected)).not.toBe(computeScreenerKey(old));
  const other = { ...old, label: 'Price Above Support' };
  expect(normalizeEtSupportFilter(other)).toEqual(other);
});
