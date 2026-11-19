import { describe, it, expect, vi } from 'vitest';

vi.mock('../dbAsync', () => ({ dbAll: vi.fn(async () => []) }));
vi.mock('../telegramService', () => ({
  sanitizeMarkdown: (s: string) => s,
  telegramService: { sendMarkdownMessage: vi.fn(async () => true) },
}));

import { formatLearningReview, sendLearningReview } from '../learningReview';
import { telegramService } from '../telegramService';

const att = {
  horizon: 5, calls: 120, hits: 50, misses: 70,
  overall: { hit_rate: 50 / 120, mean_excess_pct: -0.21, eff_dates: 9.4, low_data: true },
  cause_share: { WRONG_PICK: 0.6, STOP_TOO_TIGHT: 0.25, COST: 0.15, EVENT: 0 },
  buckets: { adt_band: { '1-10cr': { mean_excess_pct: -0.9, t_eff: -2.6, low_data: false }, '50cr+': { mean_excess_pct: 0.2, t_eff: 0.4, low_data: false } } },
  stops: { winner_mae_p80_pct: -4.2, median_stop_dist_pct: -3.1, winners_whose_mae_crossed_stop: 0.31 },
};

describe('weekly learning review (AF-20261119)', () => {
  it('reports the cause mix, the stop study and reliable losing buckets', () => {
    const text = formatLearningReview(att, { status: 'OK', candidates: [], arms: { reblend_learned: { verdict: 'LOW-DATA' } } }, '2026-11-20');
    expect(text).toContain('120 Buy calls graded');
    expect(text).toContain('LOW-DATA');
    expect(text.indexOf('wrong pick')).toBeLessThan(text.indexOf('stop too tight'));
    expect(text).not.toContain('event (ex-date');                        // a zero share is not listed
    expect(text).toContain('80% of winners dipped no more than 4.2%');
    expect(text).toContain('adt_band 1-10cr');
    expect(text).not.toContain('adt_band 50cr+');
    expect(text).toContain('no arm has earned promotion');
  });

  it('names a promotion candidate and flags an invalid gate', () => {
    expect(formatLearningReview(att, { status: 'OK', candidates: ['reblend_learned'] }, 'd')).toContain('Promotion candidate:* reblend_learned');
    expect(formatLearningReview(null, { status: 'INVALID' }, 'd')).toContain('INVALID');
  });

  it('sends only on Fridays IST', async () => {
    expect(await sendLearningReview(new Date('2026-11-19T14:00:00Z'))).toBe(false);   // Thursday
    expect(telegramService.sendMarkdownMessage).not.toHaveBeenCalled();
    expect(await sendLearningReview(new Date('2026-11-20T14:00:00Z'))).toBe(true);    // Friday
  });
});
