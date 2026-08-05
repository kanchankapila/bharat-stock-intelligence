import { describe, it, expect } from 'vitest';
import { formatIST, relativeFromNow, lookupExchangeTimeZone, minutesSinceMidnightInZone, dayOfWeekInZone, isNseMarketOpen, isStale } from './timeFormat';

describe('formatIST', () => {
  it('always renders an explicit IST label', () => {
    const s = formatIST('2026-01-15T10:30:00Z');
    expect(s).toMatch(/IST$/);
  });

  it('returns an em-dash placeholder for null/invalid input', () => {
    expect(formatIST(null)).toBe('—');
    expect(formatIST(undefined)).toBe('—');
    expect(formatIST('not-a-date')).toBe('—');
  });

  it('converts a UTC timestamp to the correct IST wall-clock time', () => {
    // 2026-01-15T10:30:00Z -> IST is UTC+5:30 -> 16:00 IST
    const s = formatIST('2026-01-15T10:30:00Z');
    expect(s).toContain('4:00');
    expect(s.toUpperCase()).toContain('PM');
  });
});

describe('relativeFromNow', () => {
  it('reports "just now" for very recent timestamps', () => {
    expect(relativeFromNow(new Date())).toBe('just now');
  });

  it('reports minutes for timestamps a few minutes old', () => {
    const fiveMinAgo = new Date(Date.now() - 5 * 60_000);
    expect(relativeFromNow(fiveMinAgo)).toBe('5m ago');
  });

  it('reports hours for timestamps hours old', () => {
    const threeHoursAgo = new Date(Date.now() - 3 * 60 * 60_000);
    expect(relativeFromNow(threeHoursAgo)).toBe('3h ago');
  });

  it('handles null/invalid input without throwing', () => {
    expect(relativeFromNow(null)).toBe('—');
    expect(relativeFromNow('garbage')).toBe('—');
  });
});

describe('lookupExchangeTimeZone', () => {
  it('resolves India by country name', () => {
    expect(lookupExchangeTimeZone('India')).toBe('Asia/Kolkata');
  });

  it('resolves US markets by country name variants', () => {
    expect(lookupExchangeTimeZone('USA')).toBe('America/New_York');
    expect(lookupExchangeTimeZone('United States')).toBe('America/New_York');
  });

  it('resolves by index/instrument name when no country is given', () => {
    expect(lookupExchangeTimeZone('S&P 500')).toBe('America/New_York');
    expect(lookupExchangeTimeZone('Nikkei 225')).toBe('Asia/Tokyo');
    expect(lookupExchangeTimeZone('FTSE 100')).toBe('Europe/London');
    expect(lookupExchangeTimeZone('Hang Seng')).toBe('Asia/Hong_Kong');
  });

  it('is case-insensitive', () => {
    expect(lookupExchangeTimeZone('JAPAN')).toBe('Asia/Tokyo');
  });

  it('returns null rather than guessing for an unrecognized label', () => {
    expect(lookupExchangeTimeZone('Zzyzx Exchange')).toBeNull();
    expect(lookupExchangeTimeZone(null)).toBeNull();
    expect(lookupExchangeTimeZone('')).toBeNull();
  });
});

describe('minutesSinceMidnightInZone / dayOfWeekInZone', () => {
  it('computes minutes-since-midnight consistently for a known UTC instant', () => {
    // 2026-01-15T04:00:00Z -> IST (UTC+5:30) is 09:30 -> 9*60+30 = 570 minutes
    const at = new Date('2026-01-15T04:00:00Z');
    expect(minutesSinceMidnightInZone('Asia/Kolkata', at)).toBe(570);
  });

  it('computes the correct weekday index for a known date', () => {
    // 2026-01-15 is a Thursday
    const at = new Date('2026-01-15T04:00:00Z');
    expect(dayOfWeekInZone('Asia/Kolkata', at)).toBe(4);
  });
});

describe('isNseMarketOpen', () => {
  it('is open mid-session on a weekday', () => {
    // 2026-01-15T04:00:00Z -> 09:30 IST, Thursday -> inside 09:15-15:30
    expect(isNseMarketOpen(new Date('2026-01-15T04:00:00Z'))).toBe(true);
  });

  it('is closed before the 09:15 IST open on a weekday', () => {
    // -> 05:30 IST, Thursday
    expect(isNseMarketOpen(new Date('2026-01-15T00:00:00Z'))).toBe(false);
  });

  it('is closed after the 15:30 IST close on a weekday', () => {
    // -> 16:00 IST, Thursday
    expect(isNseMarketOpen(new Date('2026-01-15T10:30:00Z'))).toBe(false);
  });

  it('is closed on a weekend even during normal session hours', () => {
    // 2026-01-17 is a Saturday; -> 09:30 IST
    expect(isNseMarketOpen(new Date('2026-01-17T04:00:00Z'))).toBe(false);
  });
});

describe('isStale', () => {
  it('is false for a timestamp inside the threshold', () => {
    expect(isStale(Date.now() - 1000, 5000)).toBe(false);
  });

  it('is true once older than the threshold', () => {
    expect(isStale(Date.now() - 10_000, 5000)).toBe(true);
  });

  it('is false for 0 or missing -- "no data yet" is not the same claim as "stale data"', () => {
    expect(isStale(0, 5000)).toBe(false);
    expect(isStale(null, 5000)).toBe(false);
    expect(isStale(undefined, 5000)).toBe(false);
  });

  it('is exactly on the boundary at false (strictly greater-than, not >=)', () => {
    const now = Date.now();
    expect(isStale(now - 5000, 5000)).toBe(false);
    expect(isStale(now - 5001, 5000)).toBe(true);
  });
});
