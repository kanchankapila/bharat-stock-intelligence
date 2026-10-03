import { describe, expect, it } from 'vitest';
import { dailyCloses } from '../dailyCloses';

// AF-20260930-45: the dashboard's "NIFTY 50 — 30D" chart took the last 30 HALF-HOURLY candles
// (~2 sessions) from getOHLCData(dur '1M'), and a missing close became 0.
const IST = (d: string, hhmm: string) => Math.floor(new Date(`${d}T${hhmm}:00+05:30`).getTime() / 1000);

describe('dailyCloses', () => {
  it('keeps the LAST close of each IST trading day', () => {
    const candles = [
      { time: IST('2026-09-28', '09:15'), close: 100 },
      { time: IST('2026-09-28', '15:00'), close: 105 },
      { time: IST('2026-09-29', '09:15'), close: 106 },
      { time: IST('2026-09-29', '15:15'), close: 104 },
    ];
    expect(dailyCloses(candles, 30)).toEqual([
      { date: '2026-09-28', value: 105 },
      { date: '2026-09-29', value: 104 },
    ]);
  });

  it('returns at most n days, newest last', () => {
    const start = IST('2026-08-01', '15:00');
    const candles = Array.from({ length: 40 }, (_, i) => ({ time: start + i * 86400, close: i + 1 }));
    const days = dailyCloses(candles, 30);
    expect(days).toHaveLength(30);
    expect(days[0]).toEqual({ date: '2026-08-11', value: 11 });
    expect(days[29]).toEqual({ date: '2026-09-09', value: 40 });
  });

  it('drops candles without a finite close instead of plotting 0', () => {
    expect(dailyCloses([{ time: IST('2026-09-28', '15:00'), close: null }, { time: IST('2026-09-29', '15:00'), c: 50 }], 30))
      .toEqual([{ date: '2026-09-29', value: 50 }]);
  });
});
