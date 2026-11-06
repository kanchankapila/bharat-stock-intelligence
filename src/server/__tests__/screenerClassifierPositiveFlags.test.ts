import { describe, expect, it } from 'vitest';
import { classifyByKeyword } from '../screenerClassifier';

/** AF-20261105-03: relabelling these two removed the x0.5 red-flag veto, and the replay showed the
 *  vetoed names trailing their Hold cohort by -0.33%/day (t -2.91). Keep them in the risk category
 *  until a new measurement says otherwise. */
describe('measured red-flag screeners keep the risk category', () => {
  it('low debt and shrinking losses stay risk_red_flags', () => {
    const lowDebt = '18. Low Debt Stocks: Query: Identifies stocks suitable for investors concerned about the risks associated with high debt.';
    expect(classifyByKeyword(lowDebt).category).toBe('risk_red_flags');
    expect(classifyByKeyword('Decreasing Quarterly LossesIdentify firms with improving performance').category)
      .toBe('risk_red_flags');
  });

  it('real risk screeners keep it', () => {
    expect(classifyByKeyword('High Debt companies').category).toBe('risk_red_flags');
    expect(classifyByKeyword('Profit to Loss').category).toBe('risk_red_flags');
  });
});
