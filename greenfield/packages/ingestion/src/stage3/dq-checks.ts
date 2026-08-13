// Task 3.7: threshold/decision logic for the 5 Stage 3 dq_check rows
// registered in migration 007. All SQL lives in @greenfield/db (stage3-repo.ts)
// per "only db issues SQL" -- same pattern as nse/dq-checks.ts.
import type pg from 'pg';
import {
  insertDqResult, queryDqCheckFreshnessThresholds, queryDqCheckSpec,
  queryFundamentalCoveragePct, queryFundamentalLagViolations, queryFutureDatedFundamentalFacts,
  queryLatestEventFactAnnouncement, queryLatestMarketFlowSession, queryLatestScreenerMembershipFreshness,
} from '@greenfield/db';

export interface DqOutcome {
  checkId: string;
  status: 'info' | 'warn' | 'fail';
  detail: string;
  observed: Record<string, unknown>;
}

export async function checkCorporateActionsFreshness(pool: pg.Pool, source?: string): Promise<DqOutcome> {
  const { warnDays, failDays } = await queryDqCheckFreshnessThresholds(pool, 'corporate-actions-freshness');
  const { latest, daysBehind } = await queryLatestEventFactAnnouncement(pool, source);
  if (!latest || daysBehind === null) {
    return { checkId: 'corporate-actions-freshness', status: 'fail', detail: 'no event_fact rows exist yet', observed: {} };
  }
  const status = daysBehind > failDays ? 'fail' : daysBehind > warnDays ? 'warn' : 'info';
  return { checkId: 'corporate-actions-freshness', status, detail: `latest available_at ${latest}, ${daysBehind} day(s) behind`, observed: { latest, daysBehind } };
}

export async function checkFundamentalsCoverage(pool: pg.Pool): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec(pool, 'fundamentals-coverage', { minCoveragePct: 95 });
  const pct = await queryFundamentalCoveragePct(pool);
  const status = pct >= spec.minCoveragePct ? 'info' : 'warn';
  return { checkId: 'fundamentals-coverage', status, detail: `${pct}% of listed symbols have >=1 fundamental_fact row (threshold ${spec.minCoveragePct}%)`, observed: { coveragePct: pct } };
}

export async function checkFundamentalsLagFloor(pool: pg.Pool): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec(pool, 'fundamentals-lag-floor', { lagFloorDays: 89 });
  const violations = await queryFundamentalLagViolations(pool, spec.lagFloorDays);
  const futureDated = await queryFutureDatedFundamentalFacts(pool);
  const n = violations + futureDated;
  return {
    checkId: 'fundamentals-lag-floor', status: n > 0 ? 'fail' : 'info',
    detail: `${violations} row(s) violate the ${spec.lagFloorDays}-day publication-lag floor, ${futureDated} row(s) are future-dated`,
    observed: { lagFloorViolations: violations, futureDated },
  };
}

export async function checkFiiDiiFreshness(pool: pg.Pool, source?: string): Promise<DqOutcome> {
  const { warnDays, failDays } = await queryDqCheckFreshnessThresholds(pool, 'fii-dii-freshness');
  const { latest, daysBehind } = await queryLatestMarketFlowSession(pool, source);
  if (!latest || daysBehind === null) {
    return { checkId: 'fii-dii-freshness', status: 'fail', detail: 'no market_flow rows exist yet', observed: {} };
  }
  const status = daysBehind > failDays ? 'fail' : daysBehind > warnDays ? 'warn' : 'info';
  return { checkId: 'fii-dii-freshness', status, detail: `latest flow_date ${latest}, ${daysBehind} day(s) behind`, observed: { latest, daysBehind } };
}

export async function checkScreenerMembershipFreshness(pool: pg.Pool, provider?: string): Promise<DqOutcome> {
  const { warnDays, failDays } = await queryDqCheckFreshnessThresholds(pool, 'screener-membership-freshness');
  const { latest, daysBehind } = await queryLatestScreenerMembershipFreshness(pool, provider);
  if (!latest || daysBehind === null) {
    return { checkId: 'screener-membership-freshness', status: 'fail', detail: 'no screener_membership rows exist yet', observed: {} };
  }
  const status = daysBehind > failDays ? 'fail' : daysBehind > warnDays ? 'warn' : 'info';
  return { checkId: 'screener-membership-freshness', status, detail: `latest observed_at ${latest}, ${daysBehind} day(s) behind`, observed: { latest, daysBehind } };
}

export async function evaluateAllStage3Checks(pool: pg.Pool): Promise<DqOutcome[]> {
  return Promise.all([
    checkCorporateActionsFreshness(pool),
    checkFundamentalsCoverage(pool),
    checkFundamentalsLagFloor(pool),
    checkFiiDiiFreshness(pool),
    checkScreenerMembershipFreshness(pool),
  ]);
}

export async function persistStage3DqResult(pool: pg.Pool, outcome: DqOutcome, runId: string | null): Promise<void> {
  await insertDqResult(pool, { checkId: outcome.checkId, status: outcome.status, detail: outcome.detail, observed: outcome.observed, runId });
}
