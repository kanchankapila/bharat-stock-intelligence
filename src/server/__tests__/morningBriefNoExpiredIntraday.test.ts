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
      intraday: [{ symbol: 'EXPIRED_INTRADAY' }],
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
    expect(rendered.intraday).toEqual([]);
    expect(rendered.intradayGated).toBe(true);
    expect(rendered.intradayGateReason).toMatch(/generated after.*market opens/i);
    expect(result.picks).toBe(1);
  });
});
