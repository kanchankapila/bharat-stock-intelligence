import { describe, it, expect, vi } from 'vitest';

vi.mock('../telegramService', () => ({
  telegramService: { sendMarkdownMessage: vi.fn(async () => true) },
  sanitizeMarkdown: (s: string) => s,
}));

const { formatForwardTestLine, composeMorningBrief } = await import('../morningBrief');

const REPORT = (forward: unknown) =>
  JSON.stringify({ protocol_hash: '13210b4e2c3ae688', generated_at: '2026-10-07T21:00:00', blocks: { forward } });

const ROW = (o: Record<string, unknown>) => ({
  tier: 'published', coverage_pct: null, calls_per_date: 171, dates: 0, eff_dates: 0,
  hit_rate: NaN, base_hit: NaN, hit_lift: NaN, hit_ci95: NaN, mean_excess_pct: NaN,
  t_eff: NaN, verdict: 'LOW-DATA', ...o,
});

describe('formatForwardTestLine', () => {
  it('says plainly that there is no verified edge when the forward test has no closed windows', () => {
    const line = formatForwardTestLine(REPORT({ since: '2026-10-06', calls: 0, tiers: {} }));
    expect(line).toMatch(/no verified edge yet/i);
    expect(line).toContain('2026-10-06');
    expect(line).not.toMatch(/NaN|undefined|null/);
  });

  it('never invents a verdict from a missing or malformed snapshot', () => {
    for (const raw of [null, '', 'not json', '{}', JSON.stringify({ blocks: {} })]) {
      const line = formatForwardTestLine(raw);
      expect(line).toMatch(/not yet measured|no verified edge yet/i);
      expect(line).not.toMatch(/NaN|undefined/);
    }
  });

  it('relays LOW-DATA as not-yet-evidence and names the independent-window count', () => {
    const line = formatForwardTestLine(REPORT({
      since: '2026-10-06', calls: 3762, sessions: 22,
      tiers: { '5': [ROW({ dates: 22, eff_dates: 4.4, hit_rate: 0.451, base_hit: 0.382, hit_lift: 0.069, mean_excess_pct: -0.04, t_eff: -0.3 })] },
    }));
    expect(line).toMatch(/LOW-DATA|not yet evidence/i);
    expect(line).toContain('4.4');          // eff_dates — the only count that matters
    expect(line).not.toMatch(/NaN/);
  });

  it('reports a real verdict once the windows exist, hit rate beside the chance baseline', () => {
    const line = formatForwardTestLine(REPORT({
      since: '2026-10-06', calls: 20000, sessions: 120,
      tiers: { '5': [ROW({ dates: 120, eff_dates: 24, hit_rate: 0.52, base_hit: 0.38, hit_lift: 0.14, mean_excess_pct: 0.42, t_eff: 2.4, verdict: 'EDGE' })] },
    }));
    expect(line).toContain('EDGE');
    expect(line).toMatch(/52%/);
    expect(line).toMatch(/38%/);            // chance baseline — a hit rate alone is unreadable
  });

  it('prefers the as-published row over a coverage tier, because that is what the digest sends', () => {
    const line = formatForwardTestLine(REPORT({
      since: '2026-10-06', calls: 20000, sessions: 120,
      tiers: { '5': [
        { ...ROW({ tier: 0.01, coverage_pct: 1, hit_rate: 0.90, base_hit: 0.38, eff_dates: 24, verdict: 'EDGE' }) },
        { ...ROW({ tier: 'published', hit_rate: 0.40, base_hit: 0.38, eff_dates: 24, mean_excess_pct: 0.01, t_eff: 0.1, verdict: 'NO EDGE' }) },
      ] },
    }));
    expect(line).toContain('NO EDGE');
    expect(line).not.toContain('90%');
  });
});

describe('composeMorningBrief', () => {
  it('puts the picks first, then the scorecard, then the honesty line', () => {
    const text = composeMorningBrief('2026-10-07', 'PICKS BODY', 'SCORECARD', 'HONESTY');
    expect(text.indexOf('PICKS BODY')).toBeLessThan(text.indexOf('SCORECARD'));
    expect(text.indexOf('SCORECARD')).toBeLessThan(text.indexOf('HONESTY'));
    expect(text).toMatch(/pre-open/i);
    expect(text).toContain('2026-10-07');
  });

  it('still carries the scorecard and honesty line when there are no picks', () => {
    const text = composeMorningBrief('2026-10-07', '', 'SCORECARD', 'HONESTY');
    expect(text).toContain('SCORECARD');
    expect(text).toContain('HONESTY');
    expect(text).toMatch(/no qualifying picks/i);
  });

  it('omits the scorecard block entirely rather than printing an empty heading', () => {
    const text = composeMorningBrief('2026-10-07', 'PICKS', null, 'HONESTY');
    expect(text).not.toMatch(/Last session[\s\S]{0,4}$/);
    expect(text).toContain('HONESTY');
  });
});
