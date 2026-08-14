// Stage 5 (BUILD_STAGE_5_SPEC.md Tasks 5.1-5.2): reading Task 5.0's recorded
// evidence, and writing the append-only `recommendation` table.
import type pg from 'pg';

export interface NetMeasurementEvidence {
  runId: string;
  criticalT: number;
  generatedAt: string;
  rows: Array<{ factor: string; rebalanceDays: number; netTStat: number | null }>;
}

/** Task 5.0's factor evidence, as the ranker's weight source.
 *
 * Both the t-stats and the bar they are judged against are pinned to a SINGLE
 * run_id -- the latest run that recorded a `bonferroni_critical_t`. Reading
 * them independently would let a re-run's t-stats be compared against an older
 * run's threshold (or vice versa) with nothing erroring: the ranker would then
 * be weighted by a comparison that was never actually performed. audit_metric
 * is append-only per run, so "latest run" is the only well-defined reading. */
export async function queryNetMeasurementEvidence(pool: pg.Pool): Promise<NetMeasurementEvidence | null> {
  const { rows: barRows } = await pool.query<{ run_id: string; value: number | null; generated_at: string }>(
    `SELECT run_id, value, generated_at::text
     FROM audit_metric
     WHERE metric_name = 'bonferroni_critical_t'
     ORDER BY generated_at DESC
     LIMIT 1`,
  );
  const bar = barRows[0];
  if (!bar || bar.value === null) return null;

  const { rows } = await pool.query<{ dimensions: Record<string, unknown>; value: number | null }>(
    `SELECT dimensions, value
     FROM audit_metric
     WHERE run_id = $1 AND metric_name LIKE 'factor_net_tstat.%'`,
    [bar.run_id],
  );

  return {
    runId: bar.run_id,
    criticalT: Number(bar.value),
    generatedAt: bar.generated_at,
    rows: rows.map((r) => ({
      factor: String(r.dimensions.factor ?? ''),
      rebalanceDays: Number(r.dimensions.rebalanceDays ?? 0),
      netTStat: r.value === null ? null : Number(r.value),
    })),
  };
}

export interface FeatureSnapshotSessionRow {
  symbol: string;
  values: Record<string, number | null>;
  factsCutoff: string;
}

/** Every feature_snapshot row for one session -- the ranker's whole input.
 * `facts_cutoff` is returned per row (not per session) because Task 5.1.2
 * requires each recommendation to carry its OWN source row's cutoff. */
export async function queryFeatureSnapshotSession(
  pool: pg.Pool, asOfSession: string, featureSetVersion = 'v1',
): Promise<FeatureSnapshotSessionRow[]> {
  const { rows } = await pool.query<{ symbol: string; values: Record<string, number | null>; facts_cutoff: string }>(
    `SELECT symbol, values, facts_cutoff::text
     FROM feature_snapshot
     WHERE feature_set_version = $1 AND as_of_session = $2
     ORDER BY symbol`,
    [featureSetVersion, asOfSession],
  );
  return rows.map((r) => ({ symbol: r.symbol, values: r.values, factsCutoff: r.facts_cutoff }));
}

export async function queryLatestFeatureSession(pool: pg.Pool, featureSetVersion = 'v1'): Promise<string | null> {
  const { rows } = await pool.query<{ d: string | null }>(
    `SELECT max(as_of_session)::text d FROM feature_snapshot WHERE feature_set_version = $1`,
    [featureSetVersion],
  );
  return rows[0]?.d ?? null;
}

export interface RecommendationInput {
  symbol: string;
  asOfSession: string;
  rankerVersion: string;
  generatedAt: string;
  factsCutoff: string;
  score: number | null;
  rank: number | null;
  classification: string;
  conviction: string | null;
  engineCoverage: number;
  breakdown: Record<string, unknown>;
  vetoReasons: string[];
  runId: string;
}

/** Append-only insert. Deliberately NO `ON CONFLICT DO UPDATE`: a re-run gets a
 * new `generated_at` and therefore a new row, which is the property that makes
 * the ranker gradeable at all (see migration 010's note on the predecessor
 * overwriting its own history). A conflict here means two rows were generated
 * with an identical timestamp for the same symbol+version, which is a real bug
 * -- it must throw, not be silently absorbed.
 *
 * `is_publishable` is not a parameter. Spec invariant 12 says nothing published
 * during shadow, and the way to make that hold is to give the writer no way to
 * express the other value -- promotion (Task 5.4) is a separate, deliberate
 * UPDATE, not a flag this path could pass by accident. */
export async function bulkInsertRecommendations(client: pg.ClientBase, rows: RecommendationInput[]): Promise<number> {
  if (rows.length === 0) return 0;
  // veto_reasons travels as jsonb, not text[][], across the unnest boundary:
  // unnest() flattens ALL dimensions of a multidimensional array argument in
  // row-major order (it does not treat the inner arrays as one value per
  // outer row), so `unnest($n::text[][])` alongside 13 scalar-array siblings
  // does not produce "one text[] per output row" -- it silently changes the
  // row count/shape instead, which is exactly the kind of bug that would
  // corrupt this table without ever throwing on a run where every veto_reasons
  // happened to be the same length. jsonb is a scalar type as far as a 1-D
  // array parameter is concerned, so `$n::jsonb[]` unnests correctly one
  // value per row; jsonb_array_elements_text reconstructs the real text[]
  // per row inside the SELECT.
  const { rowCount } = await client.query(
    `INSERT INTO recommendation (
       symbol, as_of_session, ranker_version, generated_at, facts_cutoff, score, rank,
       classification, conviction, engine_coverage, breakdown, veto_reasons, is_publishable, run_id)
     SELECT symbol, as_of_session, ranker_version, generated_at, facts_cutoff, score, rank,
            classification, conviction, engine_coverage, breakdown,
            ARRAY(SELECT jsonb_array_elements_text(veto_reasons_json)), is_publishable, run_id
     FROM unnest(
       $1::text[], $2::date[], $3::text[], $4::timestamptz[], $5::timestamptz[], $6::float8[], $7::int[],
       $8::text[], $9::text[], $10::int[], $11::jsonb[], $12::jsonb[], $13::boolean[], $14::uuid[])
       AS t(symbol, as_of_session, ranker_version, generated_at, facts_cutoff, score, rank,
            classification, conviction, engine_coverage, breakdown, veto_reasons_json, is_publishable, run_id)`,
    [
      rows.map((r) => r.symbol), rows.map((r) => r.asOfSession), rows.map((r) => r.rankerVersion),
      rows.map((r) => r.generatedAt), rows.map((r) => r.factsCutoff), rows.map((r) => r.score),
      rows.map((r) => r.rank), rows.map((r) => r.classification), rows.map((r) => r.conviction),
      rows.map((r) => r.engineCoverage), rows.map((r) => JSON.stringify(r.breakdown)),
      rows.map((r) => JSON.stringify(r.vetoReasons)), rows.map(() => false), rows.map((r) => r.runId),
    ],
  );
  return rowCount ?? 0;
}

export interface ModelVersionInput {
  model: string;
  version: string;
  state: 'candidate' | 'shadow' | 'approved' | 'active' | 'retired';
  artifactUri: string;
  artifactHash: string;
  trainedAt: string;
  trainWindowStart: string;
  trainWindowEnd: string;
  embargoDays: number;
  metrics: Record<string, unknown>;
  codeCommit: string;
}

export async function upsertModelVersion(client: pg.ClientBase, input: ModelVersionInput): Promise<void> {
  await client.query(
    `INSERT INTO model_version (model, version, state, artifact_uri, artifact_hash, trained_at,
       train_window, embargo_days, metrics, code_commit)
     VALUES ($1, $2, $3::model_state, $4, $5, $6, daterange($7::date, $8::date, '[]'), $9, $10::jsonb, $11)
     ON CONFLICT (model, version) DO UPDATE SET
       state = excluded.state, artifact_hash = excluded.artifact_hash, metrics = excluded.metrics,
       trained_at = excluded.trained_at, code_commit = excluded.code_commit`,
    [
      input.model, input.version, input.state, input.artifactUri, input.artifactHash, input.trainedAt,
      input.trainWindowStart, input.trainWindowEnd, input.embargoDays, JSON.stringify(input.metrics), input.codeCommit,
    ],
  );
}

export interface RecommendationRow {
  symbol: string;
  asOfSession: string;
  rankerVersion: string;
  generatedAt: string;
  factsCutoff: string;
  score: number | null;
  rank: number | null;
  classification: string;
  conviction: string | null;
  isPublishable: boolean;
}

export async function queryRecommendationsForSession(
  pool: pg.Pool, asOfSession: string, rankerVersion: string,
): Promise<RecommendationRow[]> {
  const { rows } = await pool.query<{
    symbol: string; as_of_session: string; ranker_version: string; generated_at: string;
    facts_cutoff: string; score: number | null; rank: number | null; classification: string;
    conviction: string | null; is_publishable: boolean;
  }>(
    `SELECT symbol, as_of_session::text, ranker_version, generated_at::text, facts_cutoff::text,
            score, rank, classification, conviction, is_publishable
     FROM recommendation
     WHERE as_of_session = $1 AND ranker_version = $2
     ORDER BY generated_at, rank`,
    [asOfSession, rankerVersion],
  );
  return rows.map((r) => ({
    symbol: r.symbol, asOfSession: r.as_of_session, rankerVersion: r.ranker_version,
    generatedAt: r.generated_at, factsCutoff: r.facts_cutoff, score: r.score, rank: r.rank,
    classification: r.classification, conviction: r.conviction, isPublishable: r.is_publishable,
  }));
}

/** Task 5.1.2 Verify, asked of the DATABASE rather than of the writer: does any
 * recommendation carry a facts_cutoff later than the feature_snapshot row it
 * was computed from? A writer-side assertion can only prove the writer's own
 * belief; this joins the two tables and re-derives the answer from what was
 * actually stored. Returns the violating rows (empty = clean). */
export async function queryFactsCutoffViolations(
  pool: pg.Pool, rankerVersion: string, featureSetVersion = 'v1',
): Promise<Array<{ symbol: string; asOfSession: string; recCutoff: string; snapshotCutoff: string }>> {
  const { rows } = await pool.query<{ symbol: string; as_of_session: string; rec_cutoff: string; snap_cutoff: string }>(
    `SELECT r.symbol, r.as_of_session::text, r.facts_cutoff::text rec_cutoff, fs.facts_cutoff::text snap_cutoff
     FROM recommendation r
     JOIN feature_snapshot fs
       ON fs.symbol = r.symbol AND fs.as_of_session = r.as_of_session AND fs.feature_set_version = $2
     WHERE r.ranker_version = $1 AND r.facts_cutoff > fs.facts_cutoff`,
    [rankerVersion, featureSetVersion],
  );
  return rows.map((r) => ({
    symbol: r.symbol, asOfSession: r.as_of_session, recCutoff: r.rec_cutoff, snapshotCutoff: r.snap_cutoff,
  }));
}

/** Task 5.4 / Task 5.6 `promotion-not-premature`: how many distinct sessions the
 * shadow ranker has actually produced, and whether anything is publishable yet. */
export async function queryShadowProgress(pool: pg.Pool, rankerVersion: string): Promise<{ sessions: number; publishableRows: number }> {
  const { rows } = await pool.query<{ sessions: string; publishable: string }>(
    `SELECT count(DISTINCT as_of_session)::text sessions,
            count(*) FILTER (WHERE is_publishable)::text publishable
     FROM recommendation WHERE ranker_version = $1`,
    [rankerVersion],
  );
  const r = rows[0];
  return { sessions: Number(r?.sessions ?? 0), publishableRows: Number(r?.publishable ?? 0) };
}

/** Same as queryShadowProgress but for every ranker_version present, for the
 * promotion-not-premature check -- which must catch a premature promotion
 * under ANY ranker_version, not just whichever one the caller happens to name. */
export async function queryShadowProgressByRanker(pool: pg.Pool): Promise<Array<{ rankerVersion: string; sessions: number; publishableRows: number }>> {
  const { rows } = await pool.query<{ ranker_version: string; sessions: string; publishable: string }>(
    `SELECT ranker_version, count(DISTINCT as_of_session)::text sessions,
            count(*) FILTER (WHERE is_publishable)::text publishable
     FROM recommendation GROUP BY ranker_version`,
  );
  return rows.map((r) => ({ rankerVersion: r.ranker_version, sessions: Number(r.sessions), publishableRows: Number(r.publishable) }));
}

export interface ShadowPreregistration {
  runId: string;
  minDates: number;
  minCalendarWeeks: number;
  firstShadowSession: string;
  generatedAt: string;
}

/** Task 5.2's preregistration row, read back. Ordered by generated_at ASC and
 * takes the FIRST match -- spec invariant 13 forbids shortening the shadow
 * period after the fact, so even if that invariant were ever violated by a
 * second insert (a bug, not a supported path -- see
 * record-shadow-preregistration.ts, which refuses to run a second time), this
 * read always honors the earliest-recorded value, never a later, looser one. */
export async function queryShadowPreregistration(pool: pg.Pool): Promise<ShadowPreregistration | null> {
  const { rows } = await pool.query<{ run_id: string; dimensions: Record<string, unknown>; data_watermark: string; generated_at: string }>(
    `SELECT run_id, dimensions, data_watermark, generated_at::text
     FROM audit_metric
     WHERE metric_name = 'shadow_period_preregistration'
     ORDER BY generated_at ASC
     LIMIT 1`,
  );
  const r = rows[0];
  if (!r) return null;
  return {
    runId: r.run_id,
    minDates: Number(r.dimensions.min_dates ?? 30),
    minCalendarWeeks: Number(r.dimensions.min_calendar_weeks ?? 6),
    firstShadowSession: r.data_watermark,
    generatedAt: r.generated_at,
  };
}
