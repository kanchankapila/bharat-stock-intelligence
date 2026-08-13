// Task 4.5: DQ check support queries for the Stage 4 derived tables.
import type pg from 'pg';

export async function queryMedianCoverageOnLatestSession(pool: pg.Pool, featureSetVersion = 'v1'): Promise<{ latestSession: string | null; medianCoverage: number | null }> {
  const { rows } = await pool.query<{ latest: string | null; median: string | null }>(
    `WITH latest AS (SELECT max(as_of_session) d FROM feature_snapshot WHERE feature_set_version = $1)
     SELECT latest.d::text AS latest,
       percentile_cont(0.5) WITHIN GROUP (ORDER BY coverage)::text AS median
     FROM feature_snapshot, latest
     WHERE feature_set_version = $1 AND as_of_session = latest.d
     GROUP BY latest.d`,
    [featureSetVersion],
  );
  const r = rows[0];
  return { latestSession: r?.latest ?? null, medianCoverage: r?.median !== undefined && r?.median !== null ? Number(r.median) : null };
}

export async function queryLatestFeatureSnapshotSession(pool: pg.Pool, featureSetVersion = 'v1'): Promise<{ latest: string | null; daysBehind: number | null }> {
  const { rows } = await pool.query<{ latest: string | null; days_behind: string | null }>(
    `SELECT max(as_of_session)::text latest, (CURRENT_DATE - max(as_of_session)) days_behind
     FROM feature_snapshot WHERE feature_set_version = $1`,
    [featureSetVersion],
  );
  const r = rows[0];
  return { latest: r?.latest ?? null, daysBehind: r?.days_behind !== undefined && r?.days_behind !== null ? Number(r.days_behind) : null };
}

/** Independently verifies the exclusion via a JOIN against market_bar's real
 * is_suspect flag -- not by trusting compute-features.ts's own exclusion
 * logic, which is exactly the kind of check that would catch a future
 * regression where the panel query's WHERE clause silently changed. */
export async function querySuspectFeatureSnapshotViolations(pool: pg.Pool, source = 'nse', featureSetVersion = 'v1'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n
     FROM feature_snapshot fs
     JOIN market_bar mb ON mb.symbol = fs.symbol AND mb.session_date = fs.as_of_session AND mb.source = $1
     WHERE fs.feature_set_version = $2 AND mb.is_suspect = true`,
    [source, featureSetVersion],
  );
  return Number(rows[0]?.n ?? 0);
}

export async function queryFutureDatedFactsCutoff(pool: pg.Pool, featureSetVersion = 'v1'): Promise<number> {
  const { rows } = await pool.query<{ n: string }>(
    `SELECT count(*)::text n FROM feature_snapshot
     WHERE feature_set_version = $1 AND facts_cutoff > (as_of_session::timestamptz + interval '1 day')`,
    [featureSetVersion],
  );
  return Number(rows[0]?.n ?? 0);
}

export interface ActiveModelArtifact {
  model: string;
  version: string;
  artifactHash: string;
}

export async function queryActiveModelArtifact(pool: pg.Pool): Promise<ActiveModelArtifact | null> {
  const { rows } = await pool.query<{ model: string; version: string; artifact_hash: string }>(
    `SELECT model, version, artifact_hash FROM model_version WHERE state = 'active' LIMIT 1`,
  );
  const r = rows[0];
  return r ? { model: r.model, version: r.version, artifactHash: r.artifact_hash } : null;
}
