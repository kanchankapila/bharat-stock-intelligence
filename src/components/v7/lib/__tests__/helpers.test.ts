import { describe, it, expect } from 'vitest';
import { toneOf, changeText, convictionBadge, DASH } from '../index';

/**
 * The v7 lib's null-first helpers are the honesty layer of the pro frontend:
 * on a stock-analysis surface "0" is a claim and "—" is an admission, and the
 * dominant bug class of this platform is missing data rendered as a real value
 * (format.ts's header). These tests pin the three helpers the v7 pages use.
 */
describe('v7 toneOf', () => {
  it('maps direction of change', () => {
    expect(toneOf(1.25)).toBe('up');
    expect(toneOf(-0.01)).toBe('down');
    expect(toneOf(0)).toBe('neutral');
  });

  it('refuses to claim a direction when there is no data', () => {
    expect(toneOf(null)).toBe('neutral');
    expect(toneOf(undefined)).toBe('neutral');
    expect(toneOf(NaN)).toBe('neutral');
    expect(toneOf(Infinity)).toBe('neutral');
  });
});

describe('v7 changeText', () => {
  it('carries an explicit sign for non-zero values', () => {
    expect(changeText(12.345).text).toBe('+12.35');
    expect(changeText(-3).text).toBe('−3.00');
    expect(changeText(0).text).toBe('+0.00');
  });

  it('renders missing data as DASH, never as 0', () => {
    for (const missing of [null, undefined, NaN, Infinity]) {
      const r = changeText(missing);
      expect(r.text).toBe(DASH);
      expect(r.cls).toContain('neutral');
    }
  });
});

describe('v7 convictionBadge', () => {
  it('maps known levels to graded variants', () => {
    expect(convictionBadge('high')).toEqual({ variant: 'elite', label: 'HIGH' });
    expect(convictionBadge('medium')).toEqual({ variant: 'high', label: 'MEDIUM' });
    expect(convictionBadge('low')).toEqual({ variant: 'medium', label: 'LOW' });
  });

  it('unranked/null stays neutral — never fabricated into a level', () => {
    expect(convictionBadge(null).variant).toBe('neutral');
    expect(convictionBadge(undefined).variant).toBe('neutral');
    expect(convictionBadge(null).label).toBe('—');
  });
});
