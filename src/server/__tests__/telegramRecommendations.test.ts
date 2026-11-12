import { describe, it, expect, vi } from 'vitest';
import { deriveCallState, type ForwardTestReport } from '../../lib/callState';
import { dbAll } from '../dbAsync';
import {
  fetchCallState,
  normaliseHorizon,
  sanitizeMarkdown,
  truncateWords,
  splitForTelegram,
  renderDigest,
  type DigestData,
  type Pick,
} from '../telegramRecommendations';

vi.mock('../dbAsync', async importOriginal => ({
  ...(await importOriginal<typeof import('../dbAsync')>()),
  dbAll: vi.fn(),
}));

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
    call: deriveCallState(null),
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

  it('maps the catalog/technical_signals spellings too (AF-20261001-06)', () => {
    // The same five-vocabulary problem the Python side folds in _TIMEFRAME_ALIASES. The
    // default-to-POSITIONAL below would have caught long_term by luck, but 'short_term' and
    // 'Swing (3-7D)' would NOT: they fall through to the longest bucket, which silently
    // upgraded week-scale ideas to a months-scale label in the Telegram digest.
    expect(normaliseHorizon('short_term')).toBe('SWING');
    expect(normaliseHorizon('SHORT_TERM')).toBe('SWING');
    expect(normaliseHorizon('Short term')).toBe('SWING');
    expect(normaliseHorizon('Swing (3-7D)')).toBe('SWING');
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
  it('does not attach a stale hard-coded denominator to active engine coverage', () => {
    const text = renderDigest(digest({ longTerm: [pick({ engineCoverage: 2 })] }));
    expect(text).toContain('2 contributing engines');
    expect(text).not.toContain('2/7 engines');
  });
  it('does not label unverified scanner examples as bullish or display raw JSON reasons', () => {
    const text = renderDigest(digest({ longTerm: [
      pick({ symbol: 'ABC', reason: 'ABC: 2 bullish scanners (Week CCI Bearish, Bullish breakout), above 200-day SMA.' }),
      pick({ symbol: 'XYZ', reason: '{"name": "raw news item", "sentiment": "positive"}' }),
    ] }));
    expect(text).not.toContain('Week CCI Bearish');
    expect(text).not.toContain('raw news item');
    expect(text).toContain('above 200-day SMA');
  });
  it('removes complete nested scanner examples while preserving the rest of the reason', () => {
    const text = renderDigest(digest({ longTerm: [pick({
      reason: 'ABC: 44 bullish scanners (Trend (daily), Forecaster: Analysts estimate growth (YoY)), above 200-day SMA.',
    })] }));
    expect(text).not.toContain('Forecaster');
    expect(text).not.toContain('YoY');
    expect(text).toContain('62 bullish scanners, above 200-day SMA');
  });
  // 2026-11-12: AUROPHARMA read "43 bullish scanners" (confluence's own count) beside a screener
  // list totalling 57 (the ranker's count). One message, one number: the list's.
  it('the reason quotes the same bullish-screener count as the screener list', () => {
    const text = renderDigest(digest({ longTerm: [pick({
      reason: 'AUROPHARMA: 43 bullish scanners, above 200-day SMA.',
      screeners: ['2 year Breakout', '3 Year Breakout', '5 Year Breakout', '52 Week High'],
      screenerCount: 57,
    })] }));
    expect(text).toContain('57 bullish scanners');
    expect(text).not.toContain('43 bullish scanners');
    expect(text).toContain('(+53 more)');
  });
  it('withholds an unclosed scanner example rather than leaking its contents', () => {
    const text = renderDigest(digest({ longTerm: [pick({
      reason: 'ABC: 2 bullish scanners (unverified (nested), above 200-day SMA',
    })] }));
    expect(text).not.toContain('unverified');
    expect(text).not.toContain('Why:');
  });
  it('states the horizon for every pick', () => {
    const text = renderDigest(digest());
    expect(text).toContain('Horizon:');
    expect(text).toContain('SWING (days to weeks)');
  });

  it('labels a positional pick with its actual 15-session validity, not a months-scale claim', () => {
    const text = renderDigest(digest({ longTerm: [pick({ horizon: 'POSITIONAL' })] }));
    expect(text).toContain('POSITIONAL (up to 15 sessions)');
    expect(text).not.toContain('months');
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

  it('warns when the prior session was a one-price bar rather than implying an executable entry', () => {
    const text = renderDigest(digest({
      longTerm: [pick({ executionWarning: 'Prior session traded at one price; entry fill is unverified.' })],
    }));
    expect(text).toContain('Prior session traded at one price; entry fill is unverified.');
  });

  it('does not present a Strong Buy label as a calibrated success probability', () => {
    const text = renderDigest(digest());
    expect(text).toContain('relative rank, not a calibrated win probability');
  });

  it('calls an unproven list a watch-list and states the verdict before the first pick', () => {
    const text = renderDigest(digest());
    expect(text).toContain('DAILY WATCH-LIST');
    expect(text).not.toContain('DAILY PICKS');
    expect(text.indexOf('No verified edge yet')).toBeGreaterThan(-1);
    expect(text.indexOf('No verified edge yet')).toBeLessThan(text.indexOf('POSITIONAL / SWING'));
  });

  it('says DAILY PICKS only when the frozen forward test reads EDGE', () => {
    const report: ForwardTestReport = { blocks: { forward: { tiers: { 5: [{ tier: 'published', verdict: 'EDGE' }] } } } };
    expect(renderDigest(digest({ call: deriveCallState(report) }))).toContain('DAILY PICKS');
  });

  it('reads the same verdict as the web page, and degrades to unproven when it cannot read one', async () => {
    vi.mocked(dbAll).mockResolvedValueOnce([{ value: '{"blocks": {"forward": {"tiers": {"5": [{"tier": "published", "verdict": "NO EDGE"}]}}}}' }]);
    expect((await fetchCallState()).state).toBe('NO_CALL');
    vi.mocked(dbAll).mockRejectedValueOnce(new Error('db down'));
    expect((await fetchCallState()).state).toBe('UNPROVEN');
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
    // 2026-08-10: these entries inherit their price from confluence_signals, which is frozen for
    // the whole session -- disclose that so a reader checking mid-session doesn't mistake it for a
    // live quote. Since 2026-11-12 (AF-20261112-01) the levels anchor on the previous session's
    // close, so that is what the disclosure must say.
    expect(text).toContain("anchored on the previous session's close");
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
