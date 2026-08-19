// Stage 5 (BUILD_STAGE_5_SPEC.md Tasks 5.1-5.2): reading Task 5.0's recorded
// evidence, and writing the append-only `recommendation` table.
import type pg from 'pg';
import { insertAuditMetric } from './stage3-repo.js';

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

export interface LatestSessionScores {
  asOfSession: string | null;
  scores: number[];
}

/** Task 5.3 Verify (`shadow-rank-variance`): every score the shadow ranker
 * wrote for its most recent session, for computing whether the ranking has
 * degenerated (near-zero variance, or a collapsed universe) -- the concrete
 * historical bug this guards against excluded 825 symbols platform-wide with
 * nothing catching it for a full session. */
export async function queryLatestSessionScores(pool: pg.Pool, rankerVersion: string): Promise<LatestSessionScores> {
  const { rows } = await pool.query<{ as_of_session: string | null; score: number | null }>(
    `SELECT as_of_session::text, score
     FROM recommendation
     WHERE ranker_version = $1
       AND as_of_session = (SELECT max(as_of_session) FROM recommendation WHERE ranker_version = $1)`,
    [rankerVersion],
  );
  const asOfSession = rows[0]?.as_of_session ?? null;
  const scores = rows.map((r) => r.score).filter((s): s is number => s !== null && Number.isFinite(s));
  return { asOfSession, scores };
}

export interface DivergenceMetricInput {
  runId: string;
  rankerVersion: string;
  asOfSession: string;
  rankCorrelation: number | null;
  directionalAgreementRate: number | null;
  nCompared: number;
  nDecisiveBoth: number;
  nNewOnly: number;
  nLegacyOnly: number;
  dataWatermark: string;
  paramsHash: string;
  codeCommit: string;
}

/** Task 5.3: records one session's dual-run divergence result into
 * audit_metric, under a metric name distinct from every other Stage 5
 * metric family (`shadow_divergence_*`) so `dual-run-divergence-sane` can
 * find them without ambiguity. */
export async function insertDivergenceMetrics(client: pg.ClientBase, input: DivergenceMetricInput): Promise<void> {
  const dims = { rankerVersion: input.rankerVersion, asOfSession: input.asOfSession };
  const common = {
    runId: input.runId, metricVersion: 'v1', dimensions: dims,
    dataWatermark: input.dataWatermark, paramsHash: input.paramsHash, codeCommit: input.codeCommit,
  };
  await insertAuditMetric(client, { ...common, metricName: 'shadow_divergence_rank_correlation', value: input.rankCorrelation, nObservations: input.nCompared });
  await insertAuditMetric(client, { ...common, metricName: 'shadow_divergence_directional_agreement', value: input.directionalAgreementRate, nObservations: input.nDecisiveBoth });
  await insertAuditMetric(client, { ...common, metricName: 'shadow_divergence_n_new_only', value: input.nNewOnly, nObservations: null });
  await insertAuditMetric(client, { ...common, metricName: 'shadow_divergence_n_legacy_only', value: input.nLegacyOnly, nObservations: null });
}

export interface LatestDivergenceMetric {
  asOfSession: string;
  generatedAt: string;
  rankCorrelation: number | null;
  directionalAgreementRate: number | null;
}

/** Task 5.6 `dual-run-divergence-sane`: the most recent N divergence
 * readings, to check the monitor is actually running (not stale) and
 * actually computing something (not perpetually NULL -- the "inert UNION
 * half" bug shape from recurring-bugs.md: a job that looks alive from rows
 * written alone, with the payload silently always empty). */
export async function queryRecentDivergenceMetrics(pool: pg.Pool, rankerVersion: string, limit = 5): Promise<LatestDivergenceMetric[]> {
  const { rows } = await pool.query<{ as_of_session: string; generated_at: string; rank_correlation: number | null; directional_agreement: number | null }>(
    `SELECT
       corr.dimensions ->> 'asOfSession' AS as_of_session,
       corr.generated_at::text,
       corr.value AS rank_correlation,
       agree.value AS directional_agreement
     FROM audit_metric corr
     LEFT JOIN audit_metric agree
       ON agree.metric_name = 'shadow_divergence_directional_agreement'
       AND agree.dimensions = corr.dimensions
     WHERE corr.metric_name = 'shadow_divergence_rank_correlation'
       AND corr.dimensions ->> 'rankerVersion' = $1
     ORDER BY corr.generated_at DESC
     LIMIT $2`,
    [rankerVersion, limit],
  );
  return rows.map((r) => ({
    asOfSession: r.as_of_session, generatedAt: r.generated_at,
    rankCorrelation: r.rank_correlation, directionalAgreementRate: r.directional_agreement,
  }));
}

/** Task 5.3: only the MOST RECENT run's rows for one session -- `recommendation`
 * is append-only (migration 010), so a session that was re-scored has
 * multiple `generated_at` batches on record; comparing all of them against
 * the old system in one pass would double/triple-count symbols and corrupt
 * the divergence read, not just be redundant. */
export async function queryLatestRecommendationRun(pool: pg.Pool, asOfSession: string, rankerVersion: string): Promise<RecommendationRow[]> {
  const { rows } = await pool.query<{
    symbol: string; as_of_session: string; ranker_version: string; generated_at: string;
    facts_cutoff: string; score: number | null; rank: number | null; classification: string;
    conviction: string | null; is_publishable: boolean;
  }>(
    `SELECT symbol, as_of_session::text, ranker_version, generated_at::text, facts_cutoff::text,
            score, rank, classification, conviction, is_publishable
     FROM recommendation
     WHERE as_of_session = $1 AND ranker_version = $2
       AND generated_at = (SELECT max(generated_at) FROM recommendation WHERE as_of_session = $1 AND ranker_version = $2)
     ORDER BY rank`,
    [asOfSession, rankerVersion],
  );
  return rows.map((r) => ({
    symbol: r.symbol, asOfSession: r.as_of_session, rankerVersion: r.ranker_version,
    generatedAt: r.generated_at, factsCutoff: r.facts_cutoff, score: r.score, rank: r.rank,
    classification: r.classification, conviction: r.conviction, isPublishable: r.is_publishable,
  }));
}

export interface ShadowScorePoint {
  symbol: string;
  sessionDate: string;
  value: number | null;
}

/** Task 5.4: every scored (symbol, session) the shadow ranker has ever
 * produced for `rankerVersion`, one row per pair -- shaped exactly like
 * research-harness.ts's `FactorPoint[]`, so the SAME `computeIC`/
 * `computeNetAnnualizedExcessReturn` functions Task 5.0 used can grade the
 * live shadow ranker's own score as if it were a factor, without
 * reimplementing anything. `DISTINCT ON` takes only the LATEST run per
 * session (same append-only-dedup reasoning as queryLatestRecommendationRun,
 * generalized across the whole shadow window instead of one session). */
export async function queryShadowScoreSeries(pool: pg.Pool, rankerVersion: string): Promise<ShadowScorePoint[]> {
  const { rows } = await pool.query<{ symbol: string; as_of_session: string; score: number | null }>(
    `SELECT DISTINCT ON (symbol, as_of_session) symbol, as_of_session::text, score
     FROM recommendation
     WHERE ranker_version = $1
     ORDER BY symbol, as_of_session, generated_at DESC`,
    [rankerVersion],
  );
  return rows.map((r) => ({ symbol: r.symbol, sessionDate: r.as_of_session, value: r.score }));
}

/** Task 5.4 gate step 3: how many `fail`-severity dq_result rows either of
 * Task 5.3's monitors (`shadow-rank-variance`, `dual-run-divergence-sane`)
 * have raised since a given timestamp -- the promotion gate's own evidence,
 * not a re-derivation of what those checks currently read as (a check can
 * flip from fail back to info; the gate cares whether one ever fired during
 * the shadow window, not only the latest reading). */
export async function queryDqResultFailCountSince(pool: pg.Pool, checkIds: string[], since: string): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM dq_result
     WHERE check_id = ANY($1::text[]) AND status = 'fail' AND evaluated_at >= $2`,
    [checkIds, since],
  );
  return Number(rows[0]?.n ?? 0);
}

/** Task 5.4 gate step 4 (idempotency guard): is ANYTHING published yet,
 * across every ranker_version -- global by design, matching spec text ("no
 * is_publishable = true row exists ANYWHERE yet"), not scoped to the ranker
 * this particular gate run is evaluating. */
export async function queryAnyPublishableRecommendationExists(pool: pg.Pool): Promise<boolean> {
  const { rows } = await pool.query<{ exists: boolean }>(`SELECT EXISTS(SELECT 1 FROM recommendation WHERE is_publishable) AS exists`);
  return rows[0]?.exists ?? false;
}

export interface RecommendationFreshness {
  latestRecSession: string | null;
  expectedSession: string | null;
  /** null when trading_session is empty (Stage 2 not yet run) */
  sessionsStale: number | null;
}

/** Task 5.6 `shadow-recommendation-freshness`: how many trading sessions have
 * passed since the ranker last wrote a recommendation -- the concrete failure
 * this guards against is a cron job that stops running silently and looks
 * healthy from the ingestion_run ledger alone (the "skip path stamped as
 * success" class in recurring-bugs.md). */
export async function queryRecommendationFreshness(pool: pg.Pool, rankerVersion: string): Promise<RecommendationFreshness> {
  const { rows } = await pool.query<{
    latest_rec_session: string | null;
    expected_session: string | null;
    sessions_stale: number | null;
  }>(
    `WITH latest_rec AS (
       SELECT max(as_of_session)::text AS session FROM recommendation WHERE ranker_version = $1
     ),
     latest_trading AS (
       SELECT max(session_date)::text AS session FROM trading_session WHERE session_date <= CURRENT_DATE
     )
     SELECT
       lr.session AS latest_rec_session,
       lt.session AS expected_session,
       CASE
         WHEN lr.session IS NULL THEN NULL
         WHEN lt.session IS NULL THEN NULL
         ELSE (
           SELECT count(*)::int FROM trading_session
           WHERE session_date > lr.session::date
             AND session_date <= lt.session::date
         )
       END AS sessions_stale
     FROM latest_rec lr, latest_trading lt`,
    [rankerVersion],
  );
  const r = rows[0];
  return {
    latestRecSession: r?.latest_rec_session ?? null,
    expectedSession: r?.expected_session ?? null,
    sessionsStale: r?.sessions_stale ?? null,
  };
}

/** Task 5.4 (only the promotion decision itself flips this -- nothing else in
 * Stage 5 may). Sets is_publishable=true for every row of the given
 * ranker_version's LATEST scored session only -- not the ranker's entire
 * shadow history, which would retroactively "publish" months of stale shadow
 * calls nobody could have acted on. */
export async function promoteLatestSession(client: pg.ClientBase, rankerVersion: string): Promise<{ asOfSession: string | null; rowsUpdated: number }> {
  const { rows } = await client.query<{ as_of_session: string | null }>(
    `SELECT max(as_of_session)::text AS as_of_session FROM recommendation WHERE ranker_version = $1`,
    [rankerVersion],
  );
  const asOfSession = rows[0]?.as_of_session ?? null;
  if (asOfSession === null) return { asOfSession: null, rowsUpdated: 0 };
  const { rowCount } = await client.query(
    `UPDATE recommendation SET is_publishable = true
     WHERE ranker_version = $1 AND as_of_session = $2
       AND generated_at = (SELECT max(generated_at) FROM recommendation WHERE ranker_version = $1 AND as_of_session = $2)`,
    [rankerVersion, asOfSession],
  );
  return { asOfSession, rowsUpdated: rowCount ?? 0 };
}
