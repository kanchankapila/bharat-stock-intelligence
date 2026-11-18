import { describe, it, expect } from 'vitest';
import { DATA_QUALITY_CHECKS } from '../dataQualityChecks';

// AF-20261118-06: 52 MoneyControl codes were shared by two active stocks, and every MC fetcher booked one
// company's corporate actions under both. The check must FAIL on a shared code and pass on none.
describe('nse-stocks-mcsymbol-unique', () => {
  const check = DATA_QUALITY_CHECKS.find((c) => c.id === 'nse-stocks-mcsymbol-unique')!;

  it('exists and fails when an active code is shared', () => {
    expect(check).toBeDefined();
    const r = check.evaluate({ shared: 2, codes: 'MR, LC03' }, new Date());
    expect(r.status).toBe('fail');
    expect(r.detail).toContain('MR, LC03');
  });

  it('passes when no code is shared', () => {
    expect(check.evaluate({ shared: 0, codes: '' }, new Date()).status).toBe('pass');
  });
});
