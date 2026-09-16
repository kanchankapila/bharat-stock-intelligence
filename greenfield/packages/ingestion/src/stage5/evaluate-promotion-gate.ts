// Task 5.4: the promotion gate's actual decision logic. Split from
// promotion-gate.ts (the CLI entrypoint) for the same reason ranker.ts is
// split from run-ranker.ts -- this file is pure evaluation (DB reads only,
// no write), safe to import and negative-control from a test without
// triggering a real promotion as an import-time side effect.
//
// Four checks, in order, fail closed on the first unmet condition -- per
// spec, "very likely to fail on the first attempt, and that is the correct,
// expected outcome given Task 5.0's own likely finding." This file never
// treats a failing check as something to debug around.
import {
  queryAnyPublishableRecommendationExists, queryDqResultFailCountSince, queryNetMeasurementEvidence,
  queryOpenPriceSeries, queryShadowPreregistration, queryShadowProgress, queryShadowScoreSeries, type createPool,
} from '@greenfield/db';
import { computeForwardReturns, computeIC, computeNetAnnualizedExcessReturn, type FactorPoint } from '../stage4/research-harness.js';

// Same construction Task 5.0 used (run-measurement-baseline-net.ts): top-50,
// 25bps round-trip cost. Overridable via GateOptions -- computeNetAnnualized
// ExcessReturn skips any date with fewer than topK names in the cohort
// (`if (cohort.length < topK) continue`), so a topK=50 default would force
// every test of this gate to build a real 50-symbol panel; production calls
// (promotion-gate.ts) never pass options and get these real values.
const DEFAULT_TOP_K = 50;
const DEFAULT_COST_BPS = 25;
// 5d is the SOLE gating horizon, not "5d or 21d, either clears it": testing
// two horizons and accepting either passing is itself an undisclosed second
// multiple-comparison problem the spec's own Bonferroni bar was never sized
// for. 5d is chosen over 21d because a ~30-date minimum shadow window
// (Task 5.2's preregistered min_dates) gives ~6 periods at 5d rebalance vs
// ~1 at 21d -- 21d is computed and REPORTED for transparency, never gated on.
const DEFAULT_GATING_REBALANCE_DAYS = 5;
const DEFAULT_DIAGNOSTIC_REBALANCE_DAYS = 21;

// Task 5.3's two monitors -- step 3 fails closed if either has EVER raised a
// fail-severity result since preregistration, not just its latest reading.
const DIVERGENCE_CHECK_IDS = ['shadow-rank-variance', 'dual-run-divergence-sane'];

export interface GateCheckResult {
  name: string;
  passed: boolean;
  detail: string;
  observed: Record<string, unknown>;
}

export interface PromotionGateResult {
  promote: boolean;
  rankerVersion: string;
  checks: GateCheckResult[];
  firstFailure: string | null;
}

export interface GateOptions {
  topK?: number;
  costBps?: number;
  gatingRebalanceDays?: number;
  diagnosticRebalanceDays?: number;
  /** queryOpenPriceSeries's own `source` param (default 'nse' in production).
   * Overridable for the same reason topK etc. are: a test's synthetic
   * market_bar panel must use a source distinct from real 'nse' data, and
   * without this override it would be invisible to the gate's own query. */
  marketBarSource?: string;
}

export async function evaluatePromotionGate(
  pool: ReturnType<typeof createPool>, rankerVersion: string, options: GateOptions = {},
): Promise<PromotionGateResult> {
  const TOP_K = options.topK ?? DEFAULT_TOP_K;
  const COST_BPS = options.costBps ?? DEFAULT_COST_BPS;
  const GATING_REBALANCE_DAYS = options.gatingRebalanceDays ?? DEFAULT_GATING_REBALANCE_DAYS;
  const DIAGNOSTIC_REBALANCE_DAYS = options.diagnosticRebalanceDays ?? DEFAULT_DIAGNOSTIC_REBALANCE_DAYS;
  const MARKET_BAR_SOURCE = options.marketBarSource ?? 'nse';
  const checks: GateCheckResult[] = [];
  const fail = (result: PromotionGateResult['checks'][number]) =>
    ({ promote: false, rankerVersion, checks: [...checks, result], firstFailure: result.name }) satisfies PromotionGateResult;

  // Step 1: min_dates pre-market shadow sessions exist (queries `recommendation`
  // via queryShadowProgress, never a manual count -- per spec text explicitly).
  const [prereg, progress] = await Promise.all([queryShadowPreregistration(pool), queryShadowProgress(pool, rankerVersion)]);
  const minDates = prereg?.minDates ?? null;
  const step1: GateCheckResult = {
    name: 'min-dates-accumulated',
    passed: minDates !== null && progress.sessions >= minDates,
    detail: minDates === null
      ? 'no shadow period was ever preregistered (Task 5.2) -- refusing to evaluate against a threshold that does not exist'
      : `${progress.sessions}/${minDates} preregistered shadow sessions accumulated for ${rankerVersion}`,
    observed: { minDates, sessions: progress.sessions },
  };
  checks.push(step1);
  if (!step1.passed) return fail(step1);

  // Step 2: the shadow ranker's OWN realized forward-return significance,
  // re-measured live (never re-quoting Task 5.0's backtest number), net of
  // cost, at the SAME Bonferroni bar Task 5.0 computed and recorded.
  const evidence = await queryNetMeasurementEvidence(pool);
  if (evidence === null) {
    const step2: GateCheckResult = {
      name: 'live-shadow-significance', passed: false,
      detail: 'Task 5.0 has never recorded a bonferroni_critical_t -- refusing to judge significance against a bar that does not exist',
      observed: {},
    };
    checks.push(step2);
    return fail(step2);
  }

  const [bars, shadowPoints] = await Promise.all([queryOpenPriceSeries(pool, MARKET_BAR_SOURCE), queryShadowScoreSeries(pool, rankerVersion)]);
  const factorPoints: FactorPoint[] = shadowPoints.map((p) => ({ symbol: p.symbol, sessionDate: p.sessionDate, value: p.value }));

  const gatingReturns = computeForwardReturns(bars, GATING_REBALANCE_DAYS);
  const gatingNet = computeNetAnnualizedExcessReturn(factorPoints, gatingReturns, GATING_REBALANCE_DAYS, TOP_K, COST_BPS);
  const gatingIc = computeIC(factorPoints, gatingReturns);

  const diagReturns = computeForwardReturns(bars, DIAGNOSTIC_REBALANCE_DAYS);
  const diagNet = computeNetAnnualizedExcessReturn(factorPoints, diagReturns, DIAGNOSTIC_REBALANCE_DAYS, TOP_K, COST_BPS);
  const diagIc = computeIC(factorPoints, diagReturns);

  // "Positive and significant" -- both conditions, not |t| alone. A
  // significantly NEGATIVE shadow ranker (backwards) must not promote just
  // because its magnitude clears the bar.
  const step2passed = gatingNet.netTStat !== null && gatingNet.netTStat >= evidence.criticalT;
  const step2: GateCheckResult = {
    name: 'live-shadow-significance',
    passed: step2passed,
    detail: step2passed
      ? `${GATING_REBALANCE_DAYS}d net-of-cost t=${gatingNet.netTStat!.toFixed(2)} clears the Bonferroni bar (>=${evidence.criticalT.toFixed(2)}, from Task 5.0's own recorded measurement) and is positive`
      : `${GATING_REBALANCE_DAYS}d net-of-cost t=${gatingNet.netTStat?.toFixed(2) ?? 'null'} (n=${gatingNet.nPeriods} periods) does not clear the Bonferroni bar (>=${evidence.criticalT.toFixed(2)}) as positive and significant`,
    observed: {
      criticalT: evidence.criticalT,
      gating: { rebalanceDays: GATING_REBALANCE_DAYS, netTStat: gatingNet.netTStat, annualizedNetExcessPct: gatingNet.annualizedNetExcessReturnPct, nPeriods: gatingNet.nPeriods, icTStat: gatingIc.tStat, icMeanIC: gatingIc.meanIC, icNDates: gatingIc.nDates },
      diagnostic21d: { rebalanceDays: DIAGNOSTIC_REBALANCE_DAYS, netTStat: diagNet.netTStat, annualizedNetExcessPct: diagNet.annualizedNetExcessReturnPct, nPeriods: diagNet.nPeriods, icTStat: diagIc.tStat, icMeanIC: diagIc.meanIC, icNDates: diagIc.nDates },
    },
  };
  checks.push(step2);
  if (!step2.passed) return fail(step2);

  // Step 3: Task 5.3's divergence monitor has raised zero fail-severity
  // results during the shadow window (since preregistration).
  const windowStart = prereg!.generatedAt;
  const failCount = await queryDqResultFailCountSince(pool, DIVERGENCE_CHECK_IDS, windowStart);
  const step3: GateCheckResult = {
    name: 'divergence-monitor-clean',
    passed: failCount === 0,
    detail: failCount === 0
      ? `zero fail-severity results from ${DIVERGENCE_CHECK_IDS.join('/')} since preregistration (${windowStart})`
      : `${failCount} fail-severity result(s) from ${DIVERGENCE_CHECK_IDS.join('/')} since preregistration (${windowStart})`,
    observed: { failCount, since: windowStart, checkIds: DIVERGENCE_CHECK_IDS },
  };
  checks.push(step3);
  if (!step3.passed) return fail(step3);

  // Step 4: idempotency / already-promoted guard, global across every
  // ranker_version per spec text ("no is_publishable = true row exists
  // ANYWHERE yet").
  const alreadyPublished = await queryAnyPublishableRecommendationExists(pool);
  const step4: GateCheckResult = {
    name: 'not-already-promoted',
    passed: !alreadyPublished,
    detail: alreadyPublished ? 'a publishable recommendation row already exists somewhere -- refusing a second promotion' : 'nothing published anywhere yet',
    observed: { alreadyPublished },
  };
  checks.push(step4);
  if (!step4.passed) return fail(step4);

  return { promote: true, rankerVersion, checks, firstFailure: null };
}
