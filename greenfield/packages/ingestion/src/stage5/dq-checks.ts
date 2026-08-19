// Task 5.2's own Verify #2 / Task 5.3's own Verify / three of Task 5.6's four
// Stage 5 dq checks (the fourth, `shadow-recommendation-freshness`, is
// deferred -- not required by either 5.2 or 5.3/5.4's own Verify text). Same
// "only db issues SQL" split as stage3/stage4's dq-checks.ts.
import type pg from 'pg';
import {
  insertDqResult, queryDqCheckSpec, queryLatestSessionScores, queryRecentDivergenceMetrics,
  queryRecommendationFreshness, queryShadowPreregistration, queryShadowProgress,
  queryShadowProgressByRanker,
} from '@greenfield/db';

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

interface ShadowRankVarianceSpec {
  minSymbols: number;
  varianceFloor: number;
}

/** Task 5.3 Verify: fires if the shadow ranker's latest session has a
 * degenerate score distribution -- the concrete historical bug this guards
 * against is a broken RL gate that once excluded 825 symbols platform-wide
 * with nothing catching it for a full session (recurring-bugs.md). A
 * collapsed universe (too few symbols scored at all) and a near-zero-variance
 * ranking (every symbol scored the same) are both instances of the same
 * underlying failure -- the ranker producing a degenerate output that still
 * looks "alive" from a bare freshness check. */
export async function checkShadowRankVariance(pool: pg.Pool, rankerVersion: string): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec<ShadowRankVarianceSpec>(pool, 'shadow-rank-variance', { minSymbols: 5, varianceFloor: 1e-6 });
  const { asOfSession, scores } = await queryLatestSessionScores(pool, rankerVersion);

  if (asOfSession === null) {
    return { checkId: 'shadow-rank-variance', status: 'info', detail: 'no recommendation rows written yet for this ranker_version', observed: { rankerVersion } };
  }
  if (scores.length < spec.minSymbols) {
    return {
      checkId: 'shadow-rank-variance', status: 'fail',
      detail: `only ${scores.length} symbol(s) scored on ${asOfSession} (floor ${spec.minSymbols}) -- looks like a collapsed universe`,
      observed: { asOfSession, nSymbols: scores.length },
    };
  }

  const mean = scores.reduce((a, b) => a + b, 0) / scores.length;
  const variance = scores.reduce((sum, v) => sum + (v - mean) ** 2, 0) / scores.length;
  const status = variance < spec.varianceFloor ? 'fail' : 'info';
  return {
    checkId: 'shadow-rank-variance', status,
    detail: status === 'fail'
      ? `${asOfSession}: ${scores.length} symbols but score variance=${variance.toExponential(3)} is below the floor ${spec.varianceFloor.toExponential(1)} -- looks like every symbol scored (near-)identically`
      : `${asOfSession}: ${scores.length} symbols, score variance=${variance.toExponential(3)}`,
    observed: { asOfSession, nSymbols: scores.length, variance },
  };
}

/** Task 5.6 `dual-run-divergence-sane`: is Task 5.3's divergence monitor
 * itself actually running and computing something -- not the divergence
 * VALUE (that's descriptive, per Task 5.3's own text, never a pass/fail
 * criterion), but whether the monitoring process has silently stopped, or
 * gone inert while still writing rows. Same shape as recurring-bugs.md's
 * "inert UNION half" bug -- a job that looks alive because it writes rows,
 * with the payload silently always NULL. */
export async function checkDualRunDivergenceSane(pool: pg.Pool, rankerVersion: string): Promise<DqOutcome> {
  const [progress, recent] = await Promise.all([
    queryShadowProgress(pool, rankerVersion),
    queryRecentDivergenceMetrics(pool, rankerVersion, 5),
  ]);

  if (progress.sessions === 0) {
    return { checkId: 'dual-run-divergence-sane', status: 'info', detail: 'shadow ranker has not scored any session yet', observed: {} };
  }

  if (recent.length === 0) {
    // Give the monitor some runway -- a single scored session with no
    // divergence reading yet isn't "silently stopped", it just hasn't had a
    // chance to run. Only escalate once there's real backlog.
    const status = progress.sessions >= 2 ? 'warn' : 'info';
    return {
      checkId: 'dual-run-divergence-sane', status,
      detail: status === 'warn'
        ? `${progress.sessions} shadow session(s) scored but ZERO divergence readings recorded -- the monitor may have never run`
        : `only ${progress.sessions} shadow session(s) so far, divergence monitor has not run yet`,
      observed: { shadowSessions: progress.sessions, divergenceReadings: 0 },
    };
  }

  const allNull = recent.every((r) => r.rankCorrelation === null && r.directionalAgreementRate === null);
  if (allNull) {
    return {
      checkId: 'dual-run-divergence-sane', status: 'warn',
      detail: `last ${recent.length} divergence reading(s) are ALL NULL on both metrics -- rows exist (looks alive) but the computation itself may be broken`,
      observed: { recentCount: recent.length },
    };
  }

  const latest = recent[0]!;
  return {
    checkId: 'dual-run-divergence-sane', status: 'info',
    detail: `latest divergence reading ${latest.asOfSession}: rankCorrelation=${latest.rankCorrelation?.toFixed(3) ?? 'null'}, directionalAgreement=${latest.directionalAgreementRate?.toFixed(3) ?? 'null'}`,
    observed: { asOfSession: latest.asOfSession, rankCorrelation: latest.rankCorrelation, directionalAgreementRate: latest.directionalAgreementRate },
  };
}

/** Task 5.6 `shadow-recommendation-freshness`: did the cron job actually run
 * today? Fires WARN after 1 skipped trading session, FAIL after 2+. Degrades
 * to WARN (not FAIL) if the trading_session table is empty -- the Stage 2
 * bhavcopy backfill populates it, so an empty table means the scheduler was
 * never bootstrapped at all, not that the ranker missed a day. */
export async function checkShadowRecommendationFreshness(pool: pg.Pool, rankerVersion: string): Promise<DqOutcome> {
  const { latestRecSession, expectedSession, sessionsStale } = await queryRecommendationFreshness(pool, rankerVersion);

  if (latestRecSession === null) {
    return { checkId: 'shadow-recommendation-freshness', status: 'info', detail: 'no recommendation rows written yet', observed: {} };
  }

  if (sessionsStale === null) {
    return {
      checkId: 'shadow-recommendation-freshness', status: 'warn',
      detail: `trading_session table is empty -- cannot verify trading-day-aware freshness; latest recommendation session is ${latestRecSession}`,
      observed: { latestRecSession },
    };
  }

  if (sessionsStale === 0) {
    return {
      checkId: 'shadow-recommendation-freshness', status: 'info',
      detail: `up to date: latest recommendation session ${latestRecSession} matches expected ${expectedSession}`,
      observed: { latestRecSession, expectedSession, sessionsStale },
    };
  }

  const status = sessionsStale === 1 ? 'warn' : 'fail';
  return {
    checkId: 'shadow-recommendation-freshness', status,
    detail: `latest recommendation session ${latestRecSession} is ${sessionsStale} trading session(s) behind expected ${expectedSession} -- gf-ranker-daily may not be running`,
    observed: { latestRecSession, expectedSession, sessionsStale },
  };
}

export async function evaluateAllStage5Checks(pool: pg.Pool, rankerVersion: string): Promise<DqOutcome[]> {
  return Promise.all([
    checkPromotionNotPremature(pool),
    checkShadowRankVariance(pool, rankerVersion),
    checkDualRunDivergenceSane(pool, rankerVersion),
    checkShadowRecommendationFreshness(pool, rankerVersion),
  ]);
}

export async function persistStage5DqResult(pool: pg.Pool, outcome: DqOutcome, runId: string | null): Promise<void> {
  await insertDqResult(pool, { checkId: outcome.checkId, status: outcome.status, detail: outcome.detail, observed: outcome.observed, runId });
}
