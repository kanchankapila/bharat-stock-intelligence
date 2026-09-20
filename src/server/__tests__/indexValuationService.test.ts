import { describe, expect, it } from 'vitest';
import {
  MIN_DB_SESSIONS,
  MC_PE_ID_FALLBACK,
  durationToDays,
  hasEnoughCoverage,
  rowsToPoints,
} from '../indexValuationService';

// Pure coverage for the platform-history-first index chart reads (#11 alternate-source
// switch). The SQL itself is a two-column SELECT; what can silently go wrong is the
// mapping/duration/threshold logic around it, so that is what these pin.

describe('durationToDays', () => {
  it('maps every router duration id to its lookback window', () => {
    expect(durationToDays('1M')).toBe(31);
    expect(durationToDays('3M')).toBe(92);
    expect(durationToDays('6M')).toBe(183);
    expect(durationToDays('1Y')).toBe(365);
    expect(durationToDays('3Y')).toBe(1096);
    expect(durationToDays('5Y')).toBe(1826);
  });
  it('defaults an unknown duration to one year rather than throwing', () => {
    expect(durationToDays('2Y')).toBe(365);
    expect(durationToDays('')).toBe(365);
  });
});

describe('rowsToPoints', () => {
  const rows = [
    { date: '2026-01-02', pe: 22.92, pb: 3.58 },
    { date: '2026-01-05', pe: 22.85, pb: null }, // pb absence: skipped for pb, kept for pe
    { date: '2026-01-06', pe: null, pb: 3.6 },
  ];

  it('projects the requested ratio column and keeps sessions verbatim', () => {
    const pe = rowsToPoints(rows, 'pe');
    expect(pe).toEqual([
      { date: '2026-01-02', value: 22.92, indexValue: null },
      { date: '2026-01-05', value: 22.85, indexValue: null },
    ]);
    const pb = rowsToPoints(rows, 'pb');
    expect(pb.map(p => p.value)).toEqual([3.58, 3.6]);
  });

  it('treats NULL cells as absence (skipped), never as zero points', () => {
    const pb = rowsToPoints(rows, 'pb');
    expect(pb.some(p => p.value === 0)).toBe(false);
    expect(pb).toHaveLength(2);
  });

  it('keeps outlier values so the UI flag can surface them (no silent cleaning)', () => {
    const spiky = [{ date: '2025-12-29', pe: 26, pb: 25 }];
    expect(rowsToPoints(spiky, 'pb')[0].value).toBe(25);
  });
});

describe('hasEnoughCoverage', () => {
  it('demands MIN_DB_SESSIONS before trusting the stored series', () => {
    const points = Array.from({ length: MIN_DB_SESSIONS }, (_, i) => ({
      date: `2026-01-${String(i + 1).padStart(2, '0')}`,
      value: 3,
      indexValue: null,
    }));
    expect(hasEnoughCoverage(points)).toBe(true);
    expect(hasEnoughCoverage(points.slice(0, MIN_DB_SESSIONS - 1))).toBe(false);
    expect(hasEnoughCoverage([])).toBe(false);
  });
});

describe('MC_PE_ID_FALLBACK', () => {
  it('covers the NIFTY heads the frontend offers, with the fetcher spellings', () => {
    expect(MC_PE_ID_FALLBACK['9']).toBe('NIFTY50');
    expect(MC_PE_ID_FALLBACK['23']).toBe('NIFTYBANK');
    expect(MC_PE_ID_FALLBACK['7']).toBe('NIFTY500');
    expect(MC_PE_ID_FALLBACK['38']).toBe('NIFTYENERGY');
  });
});
