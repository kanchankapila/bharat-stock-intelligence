import { describe, it, expect, vi } from 'vitest';

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn(async () => true) },
  sanitizeMarkdown: (s: string) => s,
}));

const { composeMorningBrief } = await import('../morningBrief');

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
