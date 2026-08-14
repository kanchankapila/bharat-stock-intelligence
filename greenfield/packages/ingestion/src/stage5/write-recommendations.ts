// Task 5.1.2: compute a rank for one session's feature_snapshot cross-section
// and write `recommendation` rows. Every row is written is_publishable=false
// -- bulkInsertRecommendations doesn't even take that as a parameter, so this
// module has no way to express the other value (spec invariant 12).
//
// Deliberately separate from run-ranker.ts, same split as compute-features.ts /
// run-compute-features.ts: this file has no top-level side effect, so tests
// (and anything else) can import buildSpecFromEvidence/writeRecommendations
// without triggering a real DB run as an import-time side effect. run-ranker.ts
// is the one-shot operational entrypoint that actually invokes main().
import { createHash } from 'node:crypto';
import {
  bulkInsertRecommendations, queryFeatureSnapshotSession, queryLatestFeatureSession,
  queryNetMeasurementEvidence, upsertModelVersion, type RecommendationInput, type createPool,
} from '@greenfield/db';
import { FEATURE_SET_VERSION } from '../stage4/compute-features.js';
import { buildRankerSpec, rankSession, selectSurvivingFactors, type RankerSpec } from './ranker.js';

export const MODEL_NAME = 'stage5_ranker';

/** Task 5.0's panel started 2021-01-04 (record-feature-set.ts) -- this ranker
 * doesn't itself train on a window (its "training" IS Task 5.0's measurement
 * run), so model_version.train_window records the span of evidence it was
 * built from, not a fit window in the usual ML sense. */
export const EVIDENCE_PANEL_START = '2021-01-04';

export async function buildSpecFromEvidence(pool: ReturnType<typeof createPool>): Promise<RankerSpec> {
  const evidence = await queryNetMeasurementEvidence(pool);
  if (evidence === null) {
    // No Task 5.0 run recorded at all -- distinct from "ran and found zero
    // survivors". Both produce the null ranker, but this is a harder failure:
    // it means Task 5.0 was skipped, which invariant 11 forbids. Fail loudly
    // rather than silently proceeding as if zero-survivors were measured.
    throw new Error('No bonferroni_critical_t found in audit_metric -- Task 5.0 has not been run. Cannot build a ranker.');
  }
  const survivors = selectSurvivingFactors(evidence.rows, evidence.criticalT);
  return buildRankerSpec(survivors);
}

export interface WriteRecommendationsResult {
  asOfSession: string;
  spec: RankerSpec;
  snapshotRowCount: number;
  rankedCount: number;
  written: number;
}

/** Task 5.1.1 + 5.1.2 end to end for one session: build the ranker spec from
 * Task 5.0's recorded evidence, rank the session's feature_snapshot
 * cross-section, and write the recommendation + model_version rows.
 *
 * `featureSetVersion` defaults to the real 'v1' panel (matches every stage4
 * caller) but is overridable -- same pattern as pit-repo.ts's
 * queryFeatureSnapshotForSymbolSession -- so a test can point this at an
 * isolated fixture version without writing test rows into the real 'v1'
 * panel feature_snapshot itself feeds Task 5.0's measurement. */
export async function writeRecommendationsForSession(
  pool: ReturnType<typeof createPool>, insertClient: Parameters<typeof bulkInsertRecommendations>[0],
  runId: string, codeCommit: string, asOfSessionArg?: string, featureSetVersion: string = FEATURE_SET_VERSION,
): Promise<WriteRecommendationsResult> {
  const spec = await buildSpecFromEvidence(pool);

  const asOfSession = asOfSessionArg ?? await queryLatestFeatureSession(pool, featureSetVersion);
  if (asOfSession === null) throw new Error('No feature_snapshot rows exist for any session -- nothing to rank.');

  const rows = await queryFeatureSnapshotSession(pool, asOfSession, featureSetVersion);
  const generatedAt = new Date().toISOString();
  const ranked = rankSession(spec, rows);

  const insertRows: RecommendationInput[] = ranked.map((r) => ({
    symbol: r.symbol, asOfSession, rankerVersion: spec.version, generatedAt,
    factsCutoff: r.factsCutoff, // Task 5.1.2's own discipline: copied verbatim from the source row, never re-derived.
    score: r.score, rank: r.rank, classification: r.classification, conviction: r.conviction,
    engineCoverage: r.engineCoverage, breakdown: r.breakdown, vetoReasons: [], runId,
  }));

  const written = await bulkInsertRecommendations(insertClient, insertRows);

  const artifactPayload = JSON.stringify({ variant: spec.variant, version: spec.version, factors: spec.factors });
  const artifactHash = createHash('sha256').update(artifactPayload).digest('hex');
  await upsertModelVersion(insertClient, {
    model: MODEL_NAME, version: spec.version, state: 'shadow',
    artifactUri: `in-repo://greenfield/packages/ingestion/src/stage5/ranker.ts#${spec.version}`,
    artifactHash, trainedAt: generatedAt,
    trainWindowStart: EVIDENCE_PANEL_START, trainWindowEnd: asOfSession, embargoDays: 0,
    metrics: {
      unvalidated: spec.unvalidated,
      rationale: spec.rationale,
      factors: spec.factors,
      note: spec.unvalidated
        ? 'This ranker has NOT cleared Task 5.0\'s cost-adjusted, Bonferroni-corrected significance bar. It is a deterministic placeholder for shadow-period gradeability, not a validated model. is_publishable must remain false until Task 5.4\'s promotion-gate.ts exits 0.'
        : 'Weighted by Task 5.0 net-of-cost t-stats. Still shadow-only pending Task 5.4 promotion.',
    },
    codeCommit,
  });

  return { asOfSession, spec, snapshotRowCount: rows.length, rankedCount: ranked.length, written };
}
