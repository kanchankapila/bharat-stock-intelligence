// Task 4.5: threshold/decision logic for the four Stage 4 dq_check rows
// registered in migration 008. All SQL lives in @greenfield/db (stage4-repo.ts)
// per "only db issues SQL" -- same pattern as nse/dq-checks.ts and stage3/dq-checks.ts.
import type pg from 'pg';
import {
  insertDqResult, queryActiveModelArtifact, queryDqCheckFreshnessThresholds, queryDqCheckSpec,
  queryFutureDatedFactsCutoff, queryLatestFeatureSnapshotSession, queryMedianCoverageOnLatestSession,
  querySuspectFeatureSnapshotViolations,
} from '@greenfield/db';
import { computeRankerArtifactHash } from './artifact-hash.js';

export interface DqOutcome {
  checkId: string;
  status: 'info' | 'warn' | 'fail';
  detail: string;
  observed: Record<string, unknown>;
}

export async function checkFeatureSnapshotCoverage(pool: pg.Pool, featureSetVersion = 'v1'): Promise<DqOutcome> {
  const spec = await queryDqCheckSpec(pool, 'feature-snapshot-coverage', { minMedianCoverage: 0.8 });
  const { latestSession, medianCoverage } = await queryMedianCoverageOnLatestSession(pool, featureSetVersion);
  if (!latestSession || medianCoverage === null) {
    return { checkId: 'feature-snapshot-coverage', status: 'fail', detail: 'no feature_snapshot rows exist yet', observed: {} };
  }
  const status = medianCoverage >= spec.minMedianCoverage ? 'info' : 'warn';
  return {
    checkId: 'feature-snapshot-coverage', status,
    detail: `median coverage ${(medianCoverage * 100).toFixed(1)}% on ${latestSession} (threshold ${(spec.minMedianCoverage * 100).toFixed(0)}%)`,
    observed: { latestSession, medianCoverage },
  };
}

export async function checkFeatureSnapshotFreshness(pool: pg.Pool, featureSetVersion = 'v1'): Promise<DqOutcome> {
  const { warnDays, failDays } = await queryDqCheckFreshnessThresholds(pool, 'feature-snapshot-freshness');
  const { latest, daysBehind } = await queryLatestFeatureSnapshotSession(pool, featureSetVersion);
  if (!latest || daysBehind === null) {
    return { checkId: 'feature-snapshot-freshness', status: 'fail', detail: 'no feature_snapshot rows exist yet', observed: {} };
  }
  const status = daysBehind > failDays ? 'fail' : daysBehind > warnDays ? 'warn' : 'info';
  return { checkId: 'feature-snapshot-freshness', status, detail: `latest session ${latest}, ${daysBehind} day(s) behind`, observed: { latest, daysBehind } };
}

export async function checkFeatureSuspectExclusion(pool: pg.Pool, source = 'nse', featureSetVersion = 'v1'): Promise<DqOutcome> {
  const suspectViolations = await querySuspectFeatureSnapshotViolations(pool, source, featureSetVersion);
  const futureDated = await queryFutureDatedFactsCutoff(pool, featureSetVersion);
  const n = suspectViolations + futureDated;
  return {
    checkId: 'feature-suspect-exclusion', status: n > 0 ? 'fail' : 'info',
    detail: `${suspectViolations} row(s) built from an is_suspect market_bar row, ${futureDated} row(s) with facts_cutoff after session close`,
    observed: { suspectViolations, futureDated },
  };
}

/** Stage 4's own task list never trains a model (that's Stage 5) -- this
 * honestly reports "no active model yet" rather than fabricating a pass when
 * nothing has been promoted. Once a model IS active, this recomputes its
 * artifact hash from the row's own persisted spec (`metrics.variant`/
 * `metrics.factors` + the `version` column) using the exact same
 * `computeRankerArtifactHash` the writer used, and fails if it disagrees with
 * the stored `artifact_hash` -- the Task 4.5 spec's literal requirement
 * ("active model artifact's stored hash matches [its source]"), not just a
 * presence check. Negative-controlled by inserting a model_version row with a
 * deliberately mismatched hash and confirming this returns 'fail'. */
export async function checkModelArtifactHash(pool: pg.Pool): Promise<DqOutcome> {
  const active = await queryActiveModelArtifact(pool);
  if (!active) {
    return { checkId: 'model-artifact-hash', status: 'info', detail: 'no active model_version yet (Stage 5 trains the first one)', observed: {} };
  }

  const variant = active.metrics?.variant;
  const factors = active.metrics?.factors;
  if (typeof variant !== 'string' || factors === undefined) {
    return {
      checkId: 'model-artifact-hash', status: 'fail',
      detail: `active model ${active.model}@${active.version} has no reconstructable spec (metrics.variant/metrics.factors missing) -- cannot verify its stored hash`,
      observed: { model: active.model, version: active.version },
    };
  }

  const recomputedHash = computeRankerArtifactHash({ variant, version: active.version, factors });
  const matches = recomputedHash === active.artifactHash;
  return {
    checkId: 'model-artifact-hash', status: matches ? 'info' : 'fail',
    detail: matches
      ? `active model ${active.model}@${active.version}: stored hash matches a recomputation from its own persisted spec (hash=${active.artifactHash.slice(0, 12)}...)`
      : `active model ${active.model}@${active.version}: stored hash ${active.artifactHash.slice(0, 12)}... does NOT match the recomputed hash ${recomputedHash.slice(0, 12)}... from its own persisted spec -- artifact_hash or metrics has been corrupted or tampered with`,
    observed: { model: active.model, version: active.version, matches },
  };
}

export async function evaluateAllStage4Checks(pool: pg.Pool): Promise<DqOutcome[]> {
  return Promise.all([
    checkFeatureSnapshotCoverage(pool),
    checkFeatureSnapshotFreshness(pool),
    checkFeatureSuspectExclusion(pool),
    checkModelArtifactHash(pool),
  ]);
}

export async function persistStage4DqResult(pool: pg.Pool, outcome: DqOutcome, runId: string | null): Promise<void> {
  await insertDqResult(pool, { checkId: outcome.checkId, status: outcome.status, detail: outcome.detail, observed: outcome.observed, runId });
}
