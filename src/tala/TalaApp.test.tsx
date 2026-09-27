import { describe, it, expect } from 'vitest';
import { marketPhase } from './TalaApp';

// IST = UTC+5:30. All fixture dates below are Date.UTC(...) constructed so that, once rendered
// in Asia/Kolkata, they land at the intended IST clock time.
const istUtc = (y: number, m: number, d: number, hh: number, mm: number) =>
  new Date(Date.UTC(y, m, d, hh - 5, mm - 30));

describe('marketPhase (AF-20260927-04)', () => {
  it('marks 08:30 IST as Pre-open only from 09:00', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 8, 30)).label).toBe('After hours');
  });

  it('marks 09:05 IST (before the 09:15 bell) as Pre-open', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 9, 5)).label).toBe('Pre-open');
  });

  it('marks 09:15 IST as Open (session start)', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 9, 15)).label).toBe('Open');
  });

  it('marks 10:20 IST as Open — the exact time the old boundaries wrongly read Closed', () => {
    const phase = marketPhase(istUtc(2026, 8, 28, 10, 20));
    expect(phase.label).toBe('Open');
    expect(phase.live).toBe(true);
  });

  it('marks 15:00 IST as Open — the old boundaries\' other wrong-Closed instant', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 15, 0)).label).toBe('Open');
  });

  it('marks 15:29 IST as still Open (one minute before the bell)', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 15, 29)).label).toBe('Open');
  });

  it('marks 15:35 IST as Post-close', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 15, 35)).label).toBe('Post-close');
  });

  it('marks 16:00 IST as After hours', () => {
    expect(marketPhase(istUtc(2026, 8, 28, 16, 0)).label).toBe('After hours');
  });

  it('marks Saturday as Weekend even during normal session hours', () => {
    expect(marketPhase(istUtc(2026, 8, 26, 12, 0)).label).toBe('Weekend');
  });
});
