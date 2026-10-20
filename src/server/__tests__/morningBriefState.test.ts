import { describe, it, expect, vi } from 'vitest';

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn(async () => true) },
  sanitizeMarkdown: (s: string) => s,
}));

const digestPicks: { longTerm: unknown[] } = { longTerm: [] };
vi.mock('../telegramRecommendations', () => ({
  buildRecommendationsDigest: vi.fn(async () => ({ date: '2026-10-19', longTerm: digestPicks.longTerm, intraday: [] })),
  renderDigest: () => 'RENDERED',
  splitForTelegram: (s: string) => [s],
}));
vi.mock('../signalAccuracyDigest', () => ({
  buildAccuracyDigest: vi.fn(async () => null),
  formatAccuracyScorecard: () => '',
}));
vi.mock('../dbAsync', () => ({ dbGet: vi.fn(async () => undefined) }));

const { composeMorningBrief, buildMorningBrief } = await import('../morningBrief');

describe('buildMorningBrief derives its own state from the pick count', () => {
  it("is 'no-trade' when the digest carries no long-term picks, and says so unmistakably", async () => {
    digestPicks.longTerm = [];
    const r = await buildMorningBrief();
    expect(r.picks).toBe(0);
    expect(r.state).toBe('no-trade');
    expect(r.text).toContain('NO TRADE TODAY');
  });

  it("is 'calls' when picks are present (non-vacuous counterpart)", async () => {
    digestPicks.longTerm = [{ symbol: 'ACME' }];
    const r = await buildMorningBrief();
    expect(r.picks).toBe(1);
    expect(r.state).toBe('calls');
    expect(r.text).not.toContain('NO TRADE TODAY');
  });

  it('an explicit state is never overridden by the pick count', async () => {
    digestPicks.longTerm = [{ symbol: 'ACME' }];
    expect((await buildMorningBrief('degraded', 'ranking is stale')).state).toBe('degraded');
  });
});

describe('composeMorningBrief state header', () => {
  it('labels a no-trade day unmistakably', () => {
    const out = composeMorningBrief('2026-10-19', '', null, 'fwd', 'no-trade', null);
    expect(out).toContain('NO TRADE TODAY');
    expect(out).not.toContain('PRE-OPEN BRIEF —');
  });

  it('still carries the scorecard and forward-test line on a no-trade day', () => {
    const out = composeMorningBrief('2026-10-19', '', 'SCORECARD', 'FWDLINE', 'no-trade', null);
    expect(out).toContain('SCORECARD');
    expect(out).toContain('FWDLINE');
  });

  it('names the reason on a degraded day and does not present picks as current', () => {
    const out = composeMorningBrief('2026-10-19', 'ACME +1', null, 'fwd',
      'degraded', 'ranking is 58h old');
    expect(out).toContain('DEGRADED');
    expect(out).toContain('ranking is 58h old');
    expect(out.indexOf('ranking is 58h old')).toBeLessThan(out.indexOf('ACME +1'));
  });

  it('keeps the normal header when there are calls', () => {
    const out = composeMorningBrief('2026-10-19', 'ACME +1', null, 'fwd', 'calls', null);
    expect(out).toContain('PRE-OPEN BRIEF');
    expect(out).not.toContain('DEGRADED');
  });
});
