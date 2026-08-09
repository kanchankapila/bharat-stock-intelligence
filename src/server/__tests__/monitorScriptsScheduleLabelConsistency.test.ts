import { describe, it, expect } from 'vitest';
import { MONITOR_SCRIPTS } from '../monitorScripts';

/**
 * 2026-08-06: 8 MONITOR_SCRIPTS entries (fii-dii-fetcher, finbert-scorer, ml-ensemble-score,
 * regime-detector, feature-engineering, reward-engine, rl-agent-update, signal-type-stats) all
 * declared cronPatterns: ['0 14 * * 1-5'] (correctly matching ml-daily-ops's real 7:30 PM IST
 * schedule -- the staleness MATH was fine) while their human-readable `schedule` label -- what
 * SystemMonitorPage.tsx actually displays -- still said 'Daily 5 PM', ml-daily-ops's schedule
 * from long before it moved to 7:30 PM. None of monitorScriptsCronMirror.test.ts /
 * monitorScriptsGraceMinutesConsistency.test.ts caught this because both only check
 * cronPatterns/graceMinutes against source -- neither ever cross-checks the free-text label
 * against its own entry's cronPatterns. This is that missing cross-check, scoped to the ONE
 * pattern this repo has actually been bitten by (a stale hour baked into a label string) rather
 * than a fully general cron-to-English translator.
 */
describe('MONITOR_SCRIPTS schedule labels agree with their own cronPatterns', () => {
  // Exact single-pattern match, not .includes(): outcome-resolver-5d/-15d/performance-tracker
  // ALSO carry '0 14 * * 1-5' in a two-pattern cronPatterns array (they're graded a second time
  // inside ml-daily-ops as a safety net), but their PRIMARY home is the 9:30 AM outcome-resolver
  // job -- correctly labeled 'Daily 9:30 AM'. Only entries whose ONLY schedule is ml-daily-ops
  // itself are in scope for this check.
  const mlDailyOpsSteps = (MONITOR_SCRIPTS as readonly any[]).filter(
    s => s.cronPatterns?.length === 1 && s.cronPatterns[0] === '0 14 * * 1-5',
  );

  it('found exactly the 7 known ml-daily-ops step entries (sanity check the filter itself)', () => {
    // performance-tracker joined this list mid-fix: its cronPatterns already correctly said
    // '0 14 * * 1-5' (fixed 2026-08-03) but its schedule label still said the pre-refactor
    // 'Daily 9:30 AM' -- same drift as the other 6, just missed in that earlier pass.
    //
    // regime-detector and feature-engineering are DELIBERATELY excluded despite once sharing
    // the same stale 'Daily 5 PM' label text: their cronPatterns ('15 11 * * 1-5' / '30 11 *
    // * 1-5' -- 4:45 PM / 5:00 PM IST) show they're driven by their OWN dedicated dl.jobs.ts
    // queues (dl-regime-daily / dl-feature-daily), not ml-daily-ops at all. A first pass at
    // this fix blanket-replaced all 8 'Daily 5 PM' strings including these two, which would
    // have mislabeled two genuinely-independent, correctly-scheduled jobs as ml-daily-ops
    // steps -- caught by checking each entry's actual cronPatterns before trusting the string.
    expect(mlDailyOpsSteps.map(s => s.id).sort()).toEqual([
      'fii-dii-fetcher', 'finbert-scorer', 'ml-ensemble-score',
      'performance-tracker', 'reward-engine', 'rl-agent-update', 'signal-type-stats',
    ].sort());
  });

  it('regime-detector and feature-engineering keep their OWN accurate, non-ml-daily-ops labels', () => {
    const byId = (id: string) => MONITOR_SCRIPTS.find(s => s.id === id)!;
    expect(byId('regime-detector').schedule).toBe('Daily 4:45 PM IST');
    expect(byId('feature-engineering').schedule).toBe('Daily 5:00 PM IST');
  });

  it('every ml-daily-ops step\'s label says 7:30 PM, not the stale 5 PM', () => {
    for (const s of mlDailyOpsSteps) {
      expect(s.schedule, `${s.id}'s schedule label`).toContain('7:30 PM');
      expect(s.schedule, `${s.id}'s schedule label`).not.toMatch(/\b5 PM\b/);
    }
  });
});
