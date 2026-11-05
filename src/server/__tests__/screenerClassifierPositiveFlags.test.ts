import { describe, expect, it } from 'vitest';
import { classifyByKeyword } from '../screenerClassifier';

/** AF-20261105-03: the risk rule won on the description text, and its bearish flag halves the score. */
describe('good-news screeners are not risk red flags', () => {
  it('low debt and shrinking losses leave the risk category', () => {
    const lowDebt = '18. Low Debt Stocks: Query: Identifies stocks suitable for investors concerned about the risks associated with high debt.';
    expect(classifyByKeyword(lowDebt).category).toBe('fundamental_quality');
    expect(classifyByKeyword('Decreasing Quarterly LossesIdentify firms with improving performance').category)
      .toBe('fundamental_quality');
  });

  it('real risk screeners keep it', () => {
    expect(classifyByKeyword('High Debt companies').category).toBe('risk_red_flags');
    expect(classifyByKeyword('Profit to Loss').category).toBe('risk_red_flags');
  });
});
