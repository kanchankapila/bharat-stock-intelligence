// Task 2.4: threshold/decision logic for the six bhavcopy dq_check rows
// registered in migration 006. All SQL lives in @greenfield/db
// (nse-bhavcopy-repo.ts) per "only db issues SQL" -- this module reads
// results and applies the pass/warn/fail thresholds, which is business logic
// specific to this adapter, not generic query plumbing.
import type pg from 'pg';
import {
  insertDqResult,
  queryAvgRejectRate, queryDeliveryPctViolations, queryDqCheckFreshnessThresholds, queryDqCheckSpec,
  queryLatestSessionSymbolCount, queryLatestSessionWeekdayGap, queryLongestWeekdayCalendarGap, queryOhlcSanityViolations,
} from '@greenfield/db';

export interface DqOutcome {
  checkId: string;
  status: 'info' | 'warn' | 'fail';
  detail: string;
  observed: Record<string, unknown>;
}

export async function checkBhavcopyFreshness(pool: pg.Pool): Promise<DqOutcome> {
  // warn_days/fail_days are DEDICATED columns on dq_check (not the generic
  // spec jsonb, which migration 006 left as '{}' for this row) -- reading
  // them from the wrong place was a real bug this check's own negative
  // control test caught: spec.failDays was silently `undefined`, so
  // `gap > undefined` is always false in JS and status always fell through
  // to 'info' regardless of how stale the data actually was.
  const { warnDays, failDays } = await queryDqCheckFreshnessThresholds(pool, 'bhavcopy-freshness');
  const { latestSession, weekdayGap: gap } = await queryLatestSessionWeekdayGap(pool);
  if (!latestSession) {
    return { checkId: 'bhavcopy-freshness', status: 'fail', detail: 'no trading_session rows exist yet', observed: {} };
  }
  const status = gap > failDays ? 'fail' : gap > warnDays ? 'warn' : 'info';
  return {
    checkId: 'bhavcopy-freshness',
    status,
    detail: `latest session ${latestSession}, ${gap} weekday(s) behind the current weekday`,
    observed: { latestSession, weekdayGap: gap },
  };
}

export async function checkBhavcopySymbolCount(pool: pg.Pool): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec(pool, 'bhavcopy-symbol-count', { minSymbols: 1000, maxSymbols: 3500 });
  const { sessionDate, symbolCount } = await queryLatestSessionSymbolCount(pool);
  if (!sessionDate) {
    return { checkId: 'bhavcopy-symbol-count', status: 'fail', detail: 'no market_bar rows exist yet', observed: {} };
  }
  const inBand = symbolCount >= spec.minSymbols && symbolCount <= spec.maxSymbols;
  return {
    checkId: 'bhavcopy-symbol-count',
    status: inBand ? 'info' : 'warn',
    detail: `${symbolCount} symbols on ${sessionDate} (expected ${spec.minSymbols}-${spec.maxSymbols})`,
    observed: { sessionDate, symbolCount },
  };
}

export async function checkBhavcopyRejectRate(pool: pg.Pool): Promise<DqOutcome> {
  // The default threshold (0.5) is deliberately generous: rows_rejected
  // includes BOTH genuine defects and deliberately-excluded non-equity
  // series ('series-excluded:' -- see bhavcopy.ts), which routinely make up
  // a large legitimate share of any real bhavcopy file. This check is a
  // backstop against catastrophic parser regression, not a precise
  // defect-rate measurement -- that decomposition needs the coverage
  // report's reject-reason breakdown (Task 2.5), not this single ratio.
  const spec = await queryDqCheckSpec(pool, 'bhavcopy-reject-rate', { maxRejectRate: 0.5 });
  const { avgRate, runsEvaluated } = await queryAvgRejectRate(pool, 'nse.bhavcopy');
  if (runsEvaluated === 0 || avgRate === null) {
    return { checkId: 'bhavcopy-reject-rate', status: 'info', detail: 'no succeeded runs to evaluate yet', observed: { n: 0 } };
  }
  const status = avgRate > spec.maxRejectRate ? 'warn' : 'info';
  return {
    checkId: 'bhavcopy-reject-rate',
    status,
    detail: `average reject rate ${(avgRate * 100).toFixed(1)}% over ${runsEvaluated} run(s) (threshold ${spec.maxRejectRate * 100}%)`,
    observed: { avgRejectRate: avgRate, runsEvaluated },
  };
}

export async function checkMarketBarOhlcSanity(pool: pg.Pool): Promise<DqOutcome> {
  const n = await queryOhlcSanityViolations(pool);
  return {
    checkId: 'market-bar-ohlc-sanity',
    status: n > 0 ? 'fail' : 'info',
    detail: `${n} row(s) with a non-positive close or high < low`,
    observed: { violatingRows: n },
  };
}

export async function checkDeliveryPctRange(pool: pg.Pool): Promise<DqOutcome> {
  const n = await queryDeliveryPctViolations(pool);
  return {
    checkId: 'delivery-pct-range',
    status: n > 0 ? 'fail' : 'info',
    detail: `${n} row(s) with delivery_pct outside [0, 100]`,
    observed: { violatingRows: n },
  };
}

export async function checkCalendarContinuity(pool: pg.Pool): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec(pool, 'calendar-continuity', { maxConsecutiveWeekdayGap: 4 });
  const { gapLen, gapStart, gapEnd } = await queryLongestWeekdayCalendarGap(pool);
  const status = gapLen > spec.maxConsecutiveWeekdayGap ? 'warn' : 'info';
  return {
    checkId: 'calendar-continuity',
    status,
    detail: gapLen > 0
      ? `longest gap: ${gapLen} consecutive weekday(s) with no session (${gapStart}..${gapEnd})`
      : 'no weekday gaps in the known trading_session range',
    observed: { longestGapWeekdays: gapLen, gapStart, gapEnd },
  };
}

export async function evaluateAllBhavcopyChecks(pool: pg.Pool): Promise<DqOutcome[]> {
  return Promise.all([
    checkBhavcopyFreshness(pool),
    checkBhavcopySymbolCount(pool),
    checkBhavcopyRejectRate(pool),
    checkMarketBarOhlcSanity(pool),
    checkDeliveryPctRange(pool),
    checkCalendarContinuity(pool),
  ]);
}

export async function persistDqResult(pool: pg.Pool, outcome: DqOutcome, runId: string | null): Promise<void> {
  await insertDqResult(pool, { checkId: outcome.checkId, status: outcome.status, detail: outcome.detail, observed: outcome.observed, runId });
}
