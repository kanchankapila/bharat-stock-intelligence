// Task 5.3 Verify. Pure-logic tests, no DB.
import { expect, test } from 'vitest';
import {
  computeDivergenceForSession, legacyDirection, newSystemDirection,
  type LegacySystemRow, type NewSystemRankRow,
} from './divergence.js';

// --- newSystemDirection ---

test('newSystemDirection: above/below/at the 0.5 midpoint', () => {
  expect(newSystemDirection(0.9)).toBe('bullish');
  expect(newSystemDirection(0.1)).toBe('bearish');
  expect(newSystemDirection(0.5)).toBe('neutral');
});

test('newSystemDirection: null and non-finite scores are neutral, never coerced to a pole', () => {
  expect(newSystemDirection(null)).toBe('neutral');
  expect(newSystemDirection(NaN)).toBe('neutral');
});

// --- legacyDirection ---

test('legacyDirection: Buy/Strong Buy -> bullish, Sell/Strong Sell -> bearish, Hold -> neutral', () => {
  expect(legacyDirection('Buy')).toBe('bullish');
  expect(legacyDirection('Strong Buy')).toBe('bullish');
  expect(legacyDirection('Sell')).toBe('bearish');
  expect(legacyDirection('Strong Sell')).toBe('bearish');
  expect(legacyDirection('Hold')).toBe('neutral');
});

test('legacyDirection: null or an unrecognised value is neutral, not forced to a pole -- the recurring neutral-as-bearish bug class this deliberately avoids', () => {
  expect(legacyDirection(null)).toBe('neutral');
  expect(legacyDirection('SomeFutureClassification')).toBe('neutral');
});

// --- computeDivergenceForSession ---

test('computeDivergenceForSession: perfect agreement (identical ranking, identical direction) -> correlation 1, agreement 1', () => {
  const newRows: NewSystemRankRow[] = [
    { symbol: 'A', score: 0.9 }, { symbol: 'B', score: 0.7 }, { symbol: 'C', score: 0.2 }, { symbol: 'D', score: 0.1 },
  ];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'A', unifiedScore: 90, classification: 'Strong Buy' },
    { symbol: 'B', unifiedScore: 70, classification: 'Buy' },
    { symbol: 'C', unifiedScore: 20, classification: 'Sell' },
    { symbol: 'D', unifiedScore: 10, classification: 'Strong Sell' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.rankCorrelation).toBeCloseTo(1, 5);
  expect(result.directionalAgreementRate).toBe(1);
  expect(result.nCompared).toBe(4);
  expect(result.nDecisiveBoth).toBe(4);
  expect(result.nNewOnly).toBe(0);
  expect(result.nLegacyOnly).toBe(0);
});

test('computeDivergenceForSession: perfectly INVERTED ranking -> correlation -1, agreement 0', () => {
  const newRows: NewSystemRankRow[] = [
    { symbol: 'A', score: 0.9 }, { symbol: 'B', score: 0.7 }, { symbol: 'C', score: 0.2 }, { symbol: 'D', score: 0.1 },
  ];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'A', unifiedScore: 10, classification: 'Strong Sell' },
    { symbol: 'B', unifiedScore: 20, classification: 'Sell' },
    { symbol: 'C', unifiedScore: 70, classification: 'Buy' },
    { symbol: 'D', unifiedScore: 90, classification: 'Strong Buy' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.rankCorrelation).toBeCloseTo(-1, 5);
  expect(result.directionalAgreementRate).toBe(0);
});

test('computeDivergenceForSession: a symbol only the new system ranks (top-50) is counted as nNewOnly, not silently dropped', () => {
  const newRows: NewSystemRankRow[] = [{ symbol: 'ONLY_NEW', score: 0.9 }];
  const legacyRows: LegacySystemRow[] = [];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.nNewOnly).toBe(1);
  expect(result.nLegacyOnly).toBe(0);
  expect(result.nCompared).toBe(0);
  expect(result.rankCorrelation).toBeNull(); // fewer than 3 comparable points
});

test('computeDivergenceForSession: a symbol only the legacy system ranks is counted as nLegacyOnly', () => {
  const newRows: NewSystemRankRow[] = [];
  const legacyRows: LegacySystemRow[] = [{ symbol: 'ONLY_LEGACY', unifiedScore: 50, classification: 'Buy' }];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.nLegacyOnly).toBe(1);
  expect(result.nNewOnly).toBe(0);
});

test('computeDivergenceForSession: all-Hold legacy classifications -> zero decisive pairs, agreement rate null (not 0 -- there is nothing to disagree about, not universal disagreement)', () => {
  const newRows: NewSystemRankRow[] = [{ symbol: 'A', score: 0.9 }, { symbol: 'B', score: 0.1 }];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'A', unifiedScore: 90, classification: 'Hold' },
    { symbol: 'B', unifiedScore: 10, classification: 'Hold' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.nDecisiveBoth).toBe(0);
  expect(result.directionalAgreementRate).toBeNull();
  // Rank correlation is independent of decisiveness -- still computed if scores exist.
  expect(result.nCompared).toBe(2);
});

test('computeDivergenceForSession: fewer than 3 comparable points -> rank correlation is null (matches computeIC\'s own n<3 threshold), not a spurious +-1', () => {
  const newRows: NewSystemRankRow[] = [{ symbol: 'A', score: 0.9 }, { symbol: 'B', score: 0.1 }];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'A', unifiedScore: 90, classification: 'Buy' },
    { symbol: 'B', unifiedScore: 10, classification: 'Sell' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  expect(result.rankCorrelation).toBeNull();
});

test('computeDivergenceForSession: empty input on both sides -> everything null/zero, no crash', () => {
  const result = computeDivergenceForSession([], [], 50);
  expect(result.rankCorrelation).toBeNull();
  expect(result.directionalAgreementRate).toBeNull();
  expect(result.nCompared).toBe(0);
  expect(result.nNewOnly).toBe(0);
  expect(result.nLegacyOnly).toBe(0);
});

test('computeDivergenceForSession: topK restricts to each system\'s own top-K by its own score, not a shared cutoff', () => {
  // 3 new-system symbols, only top-1 (by score) should be considered.
  const newRows: NewSystemRankRow[] = [
    { symbol: 'HIGH', score: 0.9 }, { symbol: 'MID', score: 0.6 }, { symbol: 'LOW', score: 0.1 },
  ];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'HIGH', unifiedScore: 90, classification: 'Buy' },
    { symbol: 'MID', unifiedScore: 60, classification: 'Buy' },
    { symbol: 'LOW', unifiedScore: 10, classification: 'Sell' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 1);
  // Union of new-top-1={HIGH} and legacy-top-1={HIGH} = {HIGH} only.
  expect(result.nCompared).toBe(1);
  expect(result.nNewOnly).toBe(0);
  expect(result.nLegacyOnly).toBe(0);
});

test('computeDivergenceForSession: a NaN score on either side is excluded from comparison, not coerced', () => {
  const newRows: NewSystemRankRow[] = [{ symbol: 'A', score: NaN }, { symbol: 'B', score: 0.5 }, { symbol: 'C', score: 0.3 }, { symbol: 'D', score: 0.1 }];
  const legacyRows: LegacySystemRow[] = [
    { symbol: 'A', unifiedScore: 90, classification: 'Buy' },
    { symbol: 'B', unifiedScore: 60, classification: 'Buy' },
    { symbol: 'C', unifiedScore: 30, classification: 'Sell' },
    { symbol: 'D', unifiedScore: 10, classification: 'Sell' },
  ];
  const result = computeDivergenceForSession(newRows, legacyRows, 50);
  // A's NaN score means the new system effectively has no score for A -- counted as legacy-only.
  expect(result.nLegacyOnly).toBe(1);
  expect(result.nCompared).toBe(3);
});
