import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbAll: vi.fn(), dbGet: vi.fn(), dbRun: vi.fn() }));
vi.mock('../telegramService', () => ({ sanitizeMarkdown: (s: string) => s, telegramService: { sendMarkdownMessage: vi.fn() } }));

import { toQuoteMap } from '../liveQuotes';
import { eventRisk, livePlanCheck, sessionAfterPublish } from '../planGuard';
import { newAlertLines } from '../planGuardAlerts';

// AF-20261119-21: a plan published at 22:30 IST is judged only against the session that opens after it.
const levels = { entryLow: 100, entryHigh: 104, stop: 96, target: 112 };
const q = (o: Partial<{ price: number; open: number; high: number; low: number }>) =>
  ({ symbol: 'X', price: null, changePct: null, open: null, high: null, low: null, prevClose: null, ...o });

describe('livePlanCheck', () => {
  it('flags a gap below the stop before anything else', () => {
    expect(livePlanCheck(levels, q({ price: 95, open: 94, high: 97, low: 93 }))?.state).toBe('GAPPED_BELOW_STOP');
  });
  it('flags a stop touched intraday and a target touched intraday', () => {
    expect(livePlanCheck(levels, q({ price: 99, open: 101, high: 102, low: 95.5 }))?.state).toBe('STOP_HIT');
    expect(livePlanCheck(levels, q({ price: 110, open: 103, high: 112.5, low: 102 }))?.state).toBe('TARGET_HIT');
    expect(livePlanCheck(levels, q({ price: 100, open: 100, high: 113, low: 95 }))?.state).toBe('STOP_AND_TARGET_TOUCHED');
  });
  it('says do-not-chase only when the entry zone was never offered', () => {
    expect(livePlanCheck(levels, q({ price: 107, open: 106, high: 108, low: 105 }))?.state).toBe('GAPPED_ABOVE_ENTRY');
    expect(livePlanCheck(levels, q({ price: 107, open: 106, high: 108, low: 103 }))?.state).toBe('ABOVE_ENTRY');
  });
  it('reads the zone and below-zone states, and returns null without a price', () => {
    expect(livePlanCheck(levels, q({ price: 102, open: 101, high: 103, low: 100.5 }))).toMatchObject({ state: 'IN_ENTRY_ZONE', invalidated: false });
    expect(livePlanCheck(levels, q({ price: 98, open: 101, high: 101, low: 97.5 }))?.state).toBe('BELOW_ENTRY');
    expect(livePlanCheck(levels, q({}))).toBeNull();
  });
});

describe('sessionAfterPublish', () => {
  const pub = '2026-11-19T17:00:00Z'; // 22:30 IST on the 19th
  it('accepts a live snapshot from the next session only', () => {
    expect(sessionAfterPublish(pub, { asOf: '2026-11-20T04:30:00Z', marketOpen: true })).toBe(true);   // 10:00 IST next day
    expect(sessionAfterPublish(pub, { asOf: '2026-11-19T09:55:00Z', marketOpen: true })).toBe(false);  // the session the plan was built from
    expect(sessionAfterPublish(pub, { asOf: '2026-11-20T03:35:00Z', marketOpen: true })).toBe(false);  // 09:05 IST, before the open
    expect(sessionAfterPublish(pub, { asOf: '2026-11-20T04:30:00Z', marketOpen: false })).toBe(false);
    expect(sessionAfterPublish(pub, { asOf: null, marketOpen: true })).toBe(false);
  });
  it('accepts a same-day session when the plan was published before the open (closed-day morning run)', () => {
    expect(sessionAfterPublish('2026-11-20T01:40:00Z', { asOf: '2026-11-20T05:00:00Z', marketOpen: true })).toBe(true);
  });
});

describe('toQuoteMap', () => {
  it('reads the cached MarketData ARRAY that the routers used to JSON.parse into nothing', () => {
    const m = toQuoteMap([{ symbol: 'RELIANCE', price: 1373, changePct: -0.4, open: 1380, high: 1385, low: 0, prevClose: 1378 }]);
    expect(m.get('RELIANCE')).toMatchObject({ price: 1373, changePct: -0.4, open: 1380, high: 1385, low: null });
    expect(toQuoteMap(JSON.stringify([{ symbol: 'TCS', price: 3100 }])).get('TCS')?.price).toBe(3100);
    expect(toQuoteMap({ INFY: { symbol: 'INFY', lastPrice: 1500, changePercent: 1.2 } }).get('INFY')).toMatchObject({ price: 1500, changePct: 1.2 });
    expect(toQuoteMap('not json').size).toBe(0);
  });
});

describe('eventRisk and alert dedupe', () => {
  it('keeps only headlines naming the symbol and published after the plan', () => {
    const out = eventRisk([{ symbol: 'ABC', publishedAt: '2026-11-19T17:00:00Z' }], [
      { title: 'old', published_at: '2026-11-19T10:00:00Z', symbols_json: '["ABC"]' },
      { title: 'other stock', published_at: '2026-11-20T05:00:00Z', symbols_json: '["XYZ"]' },
      { title: 'auditor resigns', published_at: '2026-11-20T05:30:00Z', symbols_json: '["ABC","XYZ"]' },
    ]);
    expect(out.get('ABC')).toEqual(['auditor resigns']);
  });
  it('sends each key once per day', () => {
    const first = newAlertLines([{ key: 'A:STOP_HIT', line: 'a' }, { key: 'B:news:x', line: 'b' }], []);
    expect(first.lines).toEqual(['a', 'b']);
    const again = newAlertLines([{ key: 'A:STOP_HIT', line: 'a' }, { key: 'A:TARGET_HIT', line: 'c' }], first.sent);
    expect(again.lines).toEqual(['c']);
  });
});

describe('routers read live quotes through loadLiveQuotes', () => {
  it('no router parses the live-stocks-bulk cache itself (it is an array; JSON.parse threw into an EOD fallback)', () => {
    for (const f of ['routers/commandCenter.router.ts', 'routers/scoring.router.ts']) {
      const src = readFileSync(join(__dirname, '..', f), 'utf8');
      expect(src.includes("'live-stocks-bulk'"), f).toBe(false);
      expect(src.includes('loadLiveQuotes()'), f).toBe(true);
    }
  });
});

