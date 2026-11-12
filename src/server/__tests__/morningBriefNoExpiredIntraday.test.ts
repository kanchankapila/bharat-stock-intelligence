import { beforeEach, describe, expect, it, vi } from 'vitest';

const renderDigest = vi.fn();
const buildRecommendationsDigest = vi.fn();

vi.mock('../telegramRecommendations', () => ({
  buildRecommendationsDigest: (...args: unknown[]) => buildRecommendationsDigest(...args),
  renderDigest: (...args: unknown[]) => renderDigest(...args),
  splitForTelegram: (text: string) => [text],
}));
vi.mock('../signalAccuracyDigest', () => ({
  buildAccuracyDigest: vi.fn(async () => null),
  formatAccuracyScorecard: vi.fn(),
}));
vi.mock('../dbAsync', () => ({ dbGet: vi.fn(async () => undefined) }));
vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn(async () => true) },
}));

describe('morning brief lifecycle honesty', () => {
  beforeEach(() => {
    buildRecommendationsDigest.mockReset();
    renderDigest.mockReset();
    buildRecommendationsDigest.mockResolvedValue({
      date: '2026-10-09',
      regime: 'NEUTRAL',
      longTerm: [{ symbol: 'POSITIONAL' }],
      intraday: [{ symbol: 'EXPIRED_INTRADAY', source: 'intraday' }, { symbol: 'TODAY_UNIFIED', source: 'unified' }],
      intradayGated: false,
      intradayGateReason: null,
      totalBuys: 2,
    });
    renderDigest.mockReturnValue('POSITIONAL PICKS');
  });

  it('never sends the prior session intraday calls in a pre-open brief', async () => {
    const { buildMorningBrief } = await import('../morningBrief');
    const result = await buildMorningBrief();
    const rendered = renderDigest.mock.calls[0][0];

    expect(rendered.longTerm).toEqual([{ symbol: 'POSITIONAL' }]);
    expect(rendered.intraday.map((p: { symbol: string }) => p.symbol)).not.toContain('EXPIRED_INTRADAY');
    expect(rendered.intradayGated).toBe(true);
    expect(rendered.intradayGateReason).toMatch(/generated after.*market opens/i);
    expect(result.picks).toBe(1);
  });

  // 2026-11-12 audit: the 22:30 ranking's INTRADAY rows are FOR the next session (valid_until =
  // its 15:30 close, and the digest query already requires valid_until > now). Dropping them made
  // the pre-open brief, the one send that lands before that session opens, omit them entirely.
  it('keeps the unified ranker\'s intraday picks for today, which are still valid', async () => {
    const { buildMorningBrief } = await import('../morningBrief');
    await buildMorningBrief();
    const rendered = renderDigest.mock.calls[0][0];
    expect(rendered.intraday.map((p: { symbol: string }) => p.symbol)).toEqual(['TODAY_UNIFIED']);
  });
});
