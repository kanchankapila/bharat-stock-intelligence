// Task 5.2's own Verify #2 / Task 5.6's `promotion-not-premature` check --
// implemented now because Task 5.2 cannot be verified without it. Same
// "only db issues SQL" split as stage3/stage4's dq-checks.ts.
import type pg from 'pg';
import { insertDqResult, queryShadowPreregistration, queryShadowProgressByRanker } from '@greenfield/db';

export interface DqOutcome {
  checkId: string;
  status: 'info' | 'warn' | 'fail';
  detail: string;
  observed: Record<string, unknown>;
}

/** Deliberately does NOT read a threshold from dq_check.spec the way Stage
 * 4's checks do (queryDqCheckSpec) -- see migration 011's comment. The only
 * legitimate min_dates source is the preregistered audit_metric row itself;
 * a mutable dq_check.spec threshold would let the bar be loosened after the
 * fact, exactly what spec invariant 13 forbids. */
export async function checkPromotionNotPremature(pool: pg.Pool): Promise<DqOutcome> {
  const [prereg, byRanker] = await Promise.all([queryShadowPreregistration(pool), queryShadowProgressByRanker(pool)]);

  if (byRanker.length === 0) {
    return { checkId: 'promotion-not-premature', status: 'info', detail: 'no recommendation rows written yet', observed: {} };
  }

  const minDates = prereg?.minDates ?? null;
  // A publishable row with NO preregistration on record at all is just as
  // premature as one with too few sessions -- invariant 13's whole premise
  // (a preregistered bar) never having been recorded is not a pass condition.
  const violations = byRanker.filter((r) => r.publishableRows > 0 && (minDates === null || r.sessions < minDates));

  if (violations.length > 0) {
    return {
      checkId: 'promotion-not-premature', status: 'fail',
      detail: minDates === null
        ? `${violations.length} ranker_version(s) have is_publishable=true rows but NO shadow period was ever preregistered: ${violations.map((v) => v.rankerVersion).join(', ')}`
        : `${violations.length} ranker_version(s) have is_publishable=true rows with fewer than the preregistered min_dates=${minDates} shadow sessions: ${violations.map((v) => `${v.rankerVersion} (${v.sessions} sessions)`).join(', ')}`,
      observed: { minDates, violations: violations.map((v) => ({ rankerVersion: v.rankerVersion, sessions: v.sessions })) },
    };
  }

  return {
    checkId: 'promotion-not-premature', status: 'info',
    detail: minDates !== null
      ? `no premature promotion across ${byRanker.length} ranker_version(s) (preregistered min_dates=${minDates})`
      : `no premature promotion across ${byRanker.length} ranker_version(s) (nothing published, no preregistration needed yet)`,
    observed: { minDates, rankerVersions: byRanker.length },
  };
}

export async function evaluateAllStage5Checks(pool: pg.Pool): Promise<DqOutcome[]> {
  return Promise.all([checkPromotionNotPremature(pool)]);
}

export async function persistStage5DqResult(pool: pg.Pool, outcome: DqOutcome, runId: string | null): Promise<void> {
  await insertDqResult(pool, { checkId: outcome.checkId, status: outcome.status, detail: outcome.detail, observed: outcome.observed, runId });
}
