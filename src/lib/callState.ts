// "No call" state for the Alpha page. The arbiter is the frozen forward test
// (forward_test_report.py, app_settings['forward_test_report']); the published tier at 5d is what
// a user actually sees, so a narrow tier reading EDGE never lifts the page out of UNPROVEN.

export type CallState = 'UNPROVEN' | 'NO_CALL' | 'EDGE';

export interface ForwardTier { tier: number | string; verdict?: string; eff_dates?: number | null; [k: string]: unknown }
export interface ForwardTestReport {
  protocol_hash?: string;
  generated_at?: string;
  blocks?: Record<string, { since?: string; calls?: number; sessions?: number; tiers?: Record<string, ForwardTier[]> }>;
}

export const MIN_DATES_RELIABLE = 20; // mirrors factor_edge.MIN_DATES_RELIABLE
export const HEADLINE_HORIZON = '5';

export function publishedTier(report: ForwardTestReport | null | undefined, horizon = HEADLINE_HORIZON): ForwardTier | null {
  return report?.blocks?.forward?.tiers?.[horizon]?.find(r => r.tier === 'published') ?? null;
}

export function deriveCallState(
  report: ForwardTestReport | null | undefined,
  scorecard: Record<string, unknown> | null | undefined,
): { state: CallState; message: string; verdict: string | null } {
  const verdict = publishedTier(report)?.verdict ?? null;
  const scVerdict = scorecard ? String(scorecard.verdict ?? scorecard.status ?? '') : '';
  if (!verdict || verdict === 'LOW-DATA' || scVerdict === 'LOW-DATA') {
    return {
      state: 'UNPROVEN', verdict,
      message: 'No verified edge yet. The frozen forward test has too few independent windows to say whether this ranking '
        + 'beats the market after costs. Treat the list below as a watch-list, not as calls.',
    };
  }
  if (verdict !== 'EDGE') {
    return {
      state: 'NO_CALL', verdict,
      message: `No call. The forward test reads "${verdict}" for the published list after costs, so the platform is not `
        + 'making a call today. The list below is a watch-list.',
    };
  }
  return {
    state: 'EDGE', verdict,
    message: 'The published list beat the universe after costs in the frozen forward test (5-day horizon). Scores are still '
      + 'ranks, not probabilities of a win.',
  };
}

// ponytail: weekdays only; NSE holidays push the real date later. Upgrade to the trading
// calendar if a server procedure ever needs the exact session.
export function calendarBlockedUntil(start: string | null | undefined, horizon: number, minWindows = MIN_DATES_RELIABLE): string | null {
  if (!start) return null;
  const d = new Date(`${start}T00:00:00Z`);
  if (Number.isNaN(d.getTime())) return null;
  let left = minWindows * horizon;
  while (left > 0) {
    d.setUTCDate(d.getUTCDate() + 1);
    const wd = d.getUTCDay();
    if (wd !== 0 && wd !== 6) left--;
  }
  return d.toISOString().slice(0, 10);
}
