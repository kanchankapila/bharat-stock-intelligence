import { describe, expect, it } from 'vitest';
import { buildScreenerPayload } from './ValuationLabPage';

// Regression test for the Valuation Lab rule builder (#9): runScreener zod-validates criterion
// ids against SCREENER_CRITERIA_COLUMNS, so the payload MUST carry the whitelisted column id
// (rule.column), never the human-readable label (rule.label) -- a label would be rejected
// outright, and the UI shows both strings side by side, which is exactly how the wrong field
// could get wired in unnoticed.
type TestRule = {
  rowKey: string;
  column: string;
  label: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  value: string;
};

const rule = (over: Partial<TestRule>): TestRule => ({
  rowKey: 'k',
  column: 'trailing_pe',
  label: 'Trailing P/E',
  operator: 'lt',
  value: '25',
  ...over,
});

describe('buildScreenerPayload', () => {
  it('sends the column id, never the human label', () => {
    const [payload] = buildScreenerPayload([rule({})]);
    expect(payload.id).toBe('trailing_pe');
    expect(payload.id).not.toBe('Trailing P/E');
  });
  it('coerces the string threshold into a number', () => {
    expect(buildScreenerPayload([rule({ value: '12.75' })])[0].value).toBe(12.75);
    expect(buildScreenerPayload([rule({ value: '25' })])[0].value).toBe(25);
  });
  it('passes each supported operator through unchanged', () => {
    const ops = ['gt', 'lt', 'eq', 'gte', 'lte'] as const;
    const payloads = buildScreenerPayload(ops.map(operator => rule({ operator })));
    expect(payloads.map(p => p.operator)).toEqual(['gt', 'lt', 'eq', 'gte', 'lte']);
  });
  it('preserves rule order and maps one payload entry per rule', () => {
    const rules = [
      rule({ rowKey: '1', column: 'trailing_pe', label: 'Trailing P/E' }),
      rule({ rowKey: '2', column: 'debt_to_equity', label: 'D/E' }),
      rule({ rowKey: '3', column: 'return_on_equity', label: 'ROE' }),
    ];
    const payloads = buildScreenerPayload(rules);
    expect(payloads).toHaveLength(3);
    expect(payloads.map(p => p.id)).toEqual(['trailing_pe', 'debt_to_equity', 'return_on_equity']);
  });
});
