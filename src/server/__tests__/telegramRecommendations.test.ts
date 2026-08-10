import { describe, it, expect } from 'vitest';
import {
  normaliseHorizon,
  sanitizeMarkdown,
  truncateWords,
  splitForTelegram,
  renderDigest,
  type DigestData,
  type Pick,
} from '../telegramRecommendations';

function pick(over: Partial<Pick> = {}): Pick {
  return {
    symbol: 'DIVISLAB',
    horizon: 'SWING',
    action: 'Strong Buy',
    score: 76.5,
    conviction: 'A_HIGH',
    entry: 8052.09,
    stopLoss: 7894.88,
    target: 8378.24,
    riskReward: 4,
    sector: 'Healthcare',
    reason: 'above 200-day SMA, strong fundamentals',
    screeners: ['1H Supertrend Buys', 'Golden Cross 10 day over 150 day'],
    screenerCount: 62,
    engineCoverage: 6,
    source: 'unified',
    ...over,
  };
}

function digest(over: Partial<DigestData> = {}): DigestData {
  return {
    date: '2026-07-31',
    regime: 'HIGH_VOL',
    longTerm: [pick()],
    intraday: [],
    intradayGated: false,
    intradayGateReason: null,
    totalBuys: 427,
    ...over,
  };
}

describe('normaliseHorizon', () => {
  it('maps INTRADAY', () => {
    expect(normaliseHorizon('INTRADAY')).toBe('INTRADAY');
    expect(normaliseHorizon('intraday')).toBe('INTRADAY');
  });

  it('maps SWING and SHORT to SWING', () => {
    expect(normaliseHorizon('SWING')).toBe('SWING');
    expect(normaliseHorizon('short')).toBe('SWING');
  });

  it('defaults NULL/unknown to the longest horizon, never intraday', () => {
    // Conservative direction: mislabelling a multi-day idea as intraday would put a
    // same-session trade in front of the user off a multi-day thesis.
    expect(normaliseHorizon(null)).toBe('POSITIONAL');
    expect(normaliseHorizon(undefined)).toBe('POSITIONAL');
    expect(normaliseHorizon('long_term')).toBe('POSITIONAL');
    expect(normaliseHorizon('')).toBe('POSITIONAL');
  });
});

describe('sanitizeMarkdown', () => {
  it('strips characters that break Telegram legacy Markdown', () => {
    // An unbalanced _ or * makes Telegram reject the ENTIRE message, dropping the digest.
    expect(sanitizeMarkdown('FII_FPI *increasing* [pledge] `x`')).toBe('FII FPI increasing pledge x');
  });

  it('keeps % and - which appear in real screener names', () => {
    expect(sanitizeMarkdown('Williams %R crossed -80 from above')).toBe('Williams %R crossed -80 from above');
  });

  it('handles null/empty', () => {
    expect(sanitizeMarkdown(null)).toBe('');
    expect(sanitizeMarkdown(undefined)).toBe('');
  });
});

describe('truncateWords', () => {
  it('does not cut mid-word', () => {
    const out = truncateWords('the quick brown fox jumps over', 12);
    expect(out).toBe('the quick...');
    expect(out).not.toContain('bro.');
  });

  it('leaves short text untouched', () => {
    expect(truncateWords('short', 100)).toBe('short');
  });
});

describe('splitForTelegram', () => {
  it('returns a single chunk under the limit', () => {
    expect(splitForTelegram('hello', 3900)).toEqual(['hello']);
  });

  it('splits on blank lines so a pick is never cut in half', () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `block${i}`.repeat(20));
    const chunks = splitForTelegram(blocks.join('\n\n'), 500);
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) expect(c.length).toBeLessThanOrEqual(500);
    // nothing lost
    expect(chunks.join('\n\n')).toBe(blocks.join('\n\n'));
  });

  it('every chunk stays under Telegram\'s 4096 hard cap at the default limit', () => {
    const huge = Array.from({ length: 200 }, (_, i) => `line ${i} `.repeat(30)).join('\n\n');
    for (const c of splitForTelegram(huge)) expect(c.length).toBeLessThan(4096);
  });
});

describe('renderDigest', () => {
  it('states the horizon for every pick', () => {
    const text = renderDigest(digest());
    expect(text).toContain('Horizon:');
    expect(text).toContain('SWING (days to weeks)');
  });

  it('labels a positional pick as long term', () => {
    const text = renderDigest(digest({ longTerm: [pick({ horizon: 'POSITIONAL' })] }));
    expect(text).toContain('LONG TERM (weeks to months)');
  });

  it('includes the selection reason', () => {
    expect(renderDigest(digest())).toContain('above 200-day SMA, strong fundamentals');
  });

  it('names the screeners the stock appears in, and counts the overflow', () => {
    const text = renderDigest(digest());
    expect(text).toContain('1H Supertrend Buys');
    expect(text).toContain('Golden Cross 10 day over 150 day');
    expect(text).toContain('+60 more'); // 62 total - 2 shown
  });

  it('caps listed screeners so one pick cannot flood the message', () => {
    const many = Array.from({ length: 20 }, (_, i) => `Screener ${i}`);
    const text = renderDigest(digest({ longTerm: [pick({ screeners: many, screenerCount: 20 })] }));
    expect(text).toContain('Screener 3');
    expect(text).not.toContain('Screener 9');
  });

  it('shows entry, stop loss and target', () => {
    const text = renderDigest(digest());
    expect(text).toContain('Entry 8052.09');
    expect(text).toContain('SL 7894.88');
    expect(text).toContain('Target 8378.24');
  });

  it('explains an empty intraday section when the emission gate is closed', () => {
    // Silence here would read as "no setups today" rather than "the engine is suppressed".
    const text = renderDigest(digest({
      intraday: [],
      intradayGated: true,
      intradayGateReason: "the intraday engine's trailing realised edge is not positive",
    }));
    expect(text).toContain('No intraday calls published');
    expect(text).toContain('trailing realised edge is not positive');
  });

  it('renders intraday picks with the intraday horizon when the gate is open', () => {
    const text = renderDigest(digest({
      intraday: [pick({ symbol: 'PRICOLLTD', horizon: 'INTRADAY', source: 'intraday', screeners: [] })],
    }));
    expect(text).toContain('PRICOLLTD');
    expect(text).toContain('INTRADAY (same session)');
  });

  it('discloses provenance when the gate is closed but unified intraday picks are shown', () => {
    // The dedicated intraday engine being paused must not be hidden just because a different
    // engine supplied picks -- otherwise a reader assumes the gated engine endorsed them.
    const text = renderDigest(digest({
      intraday: [pick({ symbol: 'PRICOLLTD', horizon: 'INTRADAY' })],
      intradayGated: true,
      intradayGateReason: "the intraday engine's trailing realised edge is not positive",
    }));
    expect(text).toContain('Dedicated intraday engine is paused');
    expect(text).toContain("unified ranker's intraday-horizon picks");
    expect(text).toContain('PRICOLLTD');
    // 2026-08-10: these entries inherit their price from confluence_signals, which only
    // computes pre-open/evening and is frozen for the whole session -- disclose that so a
    // reader checking mid-session doesn't mistake a ~07:30 IST snapshot for a live quote.
    expect(text).toContain('pre-market (~07:30 IST) snapshot');
    expect(text).toContain('check a live quote before acting');
  });

  it('handles missing levels without printing NaN or undefined', () => {
    const text = renderDigest(digest({
      longTerm: [pick({ entry: null, stopLoss: null, target: null, riskReward: null })],
    }));
    expect(text).not.toContain('NaN');
    expect(text).not.toContain('undefined');
    expect(text).not.toContain('null');
  });

  it('never emits a non-finite score', () => {
    const text = renderDigest(digest({ longTerm: [pick({ score: NaN })] }));
    expect(text).not.toContain('NaN');
  });
});
