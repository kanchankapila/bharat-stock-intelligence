import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

  it('says there is NO ranking, not "nothing qualified", when the degraded reason is the empty-ranking case', () => {
    const reason = 'no ranking available — unified_recommendations is empty';
    const out = composeMorningBrief('2026-10-19', '', null, 'fwd', 'degraded', reason);
    expect(out).toContain(reason);
    expect(out).toContain('No ranking is available');
    expect(out).not.toContain('No qualifying picks');
  });

  it('keeps "no qualifying picks" for a degraded day whose stale ranking exists but yields none', () => {
    const out = composeMorningBrief('2026-10-19', '', null, 'fwd', 'degraded', 'ranking is 58h old');
    expect(out).toContain('No qualifying picks in the latest ranking');
  });

  it('the empty-ranking reason the job emits still matches the wording the composer keys on', () => {
    const src = readFileSync(join(__dirname, '../jobs/digests.jobs.ts'), 'utf8');
    expect(src).toContain("'no ranking available — unified_recommendations is empty'");
  });

  it('keeps the normal header when there are calls', () => {
    const out = composeMorningBrief('2026-10-19', 'ACME +1', null, 'fwd', 'calls', null);
    expect(out).toContain('PRE-OPEN BRIEF');
    expect(out).not.toContain('DEGRADED');
  });
});
