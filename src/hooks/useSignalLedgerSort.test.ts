import { describe, it, expect } from 'vitest';
import { sortSignals, defaultSortDir } from './useSignalLedgerSort';

const rows = [
  { id: 'a', symbol: 'ZOMATO', signal_type: 'SELL', signal_source: 'AI', entry_price: 300, current_price: 280, growth_pct: -6.7, signal_generated_at: '2026-08-01T10:00:00Z' },
  { id: 'b', symbol: 'ADANIENT', signal_type: 'BUY', signal_source: 'technical_scan', entry_price: 2500, current_price: 2700, growth_pct: 8.0, signal_generated_at: '2026-08-03T10:00:00Z' },
  { id: 'c', symbol: 'INFY', signal_type: 'BUY', signal_source: 'AI', entry_price: 1500, current_price: null, growth_pct: null, signal_generated_at: '2026-08-02T10:00:00Z' },
];

describe('sortSignals', () => {
  it('sorts by growth_pct ascending (worst performer first)', () => {
    const sorted = sortSignals(rows, 'growth_pct', 'asc');
    // null growth_pct maps to -Infinity, so INFY (null) sorts first, then ZOMATO (-6.7), then ADANIENT (+8.0)
    expect(sorted.map(r => r.id)).toEqual(['c', 'a', 'b']);
  });

  it('sorts by growth_pct descending (best performer first)', () => {
    const sorted = sortSignals(rows, 'growth_pct', 'desc');
    expect(sorted.map(r => r.id)).toEqual(['b', 'a', 'c']);
  });

  it('sorts by symbol alphabetically ascending', () => {
    const sorted = sortSignals(rows, 'symbol', 'asc');
    expect(sorted.map(r => r.symbol)).toEqual(['ADANIENT', 'INFY', 'ZOMATO']);
  });

  it('sorts by signal_generated_at descending (most recent first)', () => {
    const sorted = sortSignals(rows, 'signal_generated_at', 'desc');
    expect(sorted.map(r => r.id)).toEqual(['b', 'c', 'a']);
  });

  it('sorts by entry_price ascending', () => {
    const sorted = sortSignals(rows, 'entry_price', 'asc');
    expect(sorted.map(r => r.id)).toEqual(['a', 'c', 'b']);
  });

  it('does not mutate the input array', () => {
    const original = [...rows];
    sortSignals(rows, 'growth_pct', 'asc');
    expect(rows).toEqual(original);
  });

  it('handles an empty/null/undefined row list without throwing', () => {
    expect(sortSignals([], 'symbol', 'asc')).toEqual([]);
    expect(sortSignals(null, 'symbol', 'asc')).toEqual([]);
    expect(sortSignals(undefined, 'symbol', 'asc')).toEqual([]);
  });
});

describe('defaultSortDir', () => {
  it('defaults growth_pct to ascending (risk-triage: worst first)', () => {
    expect(defaultSortDir('growth_pct')).toBe('asc');
  });

  it('defaults signal_generated_at to descending (most recent first)', () => {
    expect(defaultSortDir('signal_generated_at')).toBe('desc');
  });

  it('defaults symbol to ascending (alphabetical)', () => {
    expect(defaultSortDir('symbol')).toBe('asc');
  });

  it('defaults price columns to descending (largest first)', () => {
    expect(defaultSortDir('entry_price')).toBe('desc');
    expect(defaultSortDir('current_price')).toBe('desc');
  });
});
