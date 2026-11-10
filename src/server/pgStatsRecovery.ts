/**
 * Self-repair for the cumulative-statistics reset an unclean Postgres stop causes (AF-20261028-22).
 *
 * Postgres runs in Docker/WSL on this Windows Home host, and host shutdowns stop it uncleanly (four
 * times 2026-10-26..11-09). Planner statistics survive, but `pg_stat_user_tables` is zeroed, so
 * autoanalyze/autovacuum schedule from empty counters and run late until someone repairs them.
 * Detection is the `pg-tables-analyzed` check's own SQL and fail threshold, so the trigger and the
 * alarm cannot disagree.
 *
 * Plain database-wide ANALYZE (measured 496 s, 2026-11-09), NOT VACUUM (ANALYZE): it takes only a
 * per-table SHARE UPDATE EXCLUSIVE lock, so it never blocks reads or writes. It must run OUTSIDE a
 * transaction block — inside one it would hold every table's lock until commit.
 */
import { withClient } from './pgClient';
import log from './logger';

export const PG_TABLES_ANALYZED_SQL = `SELECT COUNT(*) AS big,
                 COUNT(*) FILTER (WHERE COALESCE(s.last_autoanalyze, s.last_analyze) IS NULL) AS unanalyzed,
                 STRING_AGG(s.relname, ' ' ORDER BY c.reltuples DESC)
                   FILTER (WHERE COALESCE(s.last_autoanalyze, s.last_analyze) IS NULL) AS sample
          FROM pg_stat_user_tables s JOIN pg_class c ON c.oid = s.relid
          WHERE s.schemaname = 'public' AND c.reltuples > 10000`;

export function isStatsReset(big: number, unanalyzed: number): boolean {
  return big > 0 && unanalyzed >= big * 0.5;
}

const ANALYZE_TIMEOUT = '45min';

export type PgStatsRecoveryOutcome = 'healthy' | 'analyzed' | 'already-attempted' | 'in-progress' | 'failed';

// One attempt per postmaster start: the counters only reset on a restart, and a failed attempt
// must not turn into an ANALYZE every 15 minutes. The data-quality check keeps reporting it.
let attemptedForStart: string | null = null;
let inFlight = false;

export function resetPgStatsRecoveryState(): void {
  attemptedForStart = null;
  inFlight = false;
}

export async function recoverPgStatsIfReset(): Promise<PgStatsRecoveryOutcome> {
  if (inFlight) return 'in-progress';
  inFlight = true;
  try {
    return await withClient(async (client) => {
      const { rows: [counts] } = await client.query(PG_TABLES_ANALYZED_SQL);
      const big = Number(counts?.big) || 0;
      const unanalyzed = Number(counts?.unanalyzed) || 0;
      if (!isStatsReset(big, unanalyzed)) return 'healthy';

      const { rows: [pm] } = await client.query('SELECT pg_postmaster_start_time() AS started');
      const started = String(pm?.started);
      if (attemptedForStart === started) return 'already-attempted';
      attemptedForStart = started;

      log.warn(`[PG-STATS] ${unanalyzed} of ${big} large tables have no analyze time since the Postgres start at ${started}; running database-wide ANALYZE`);
      const t0 = Date.now();
      try {
        await client.query(`SET statement_timeout = '${ANALYZE_TIMEOUT}'`);
        await client.query('ANALYZE');
      } catch (err) {
        log.error(`[PG-STATS] ANALYZE failed after ${Math.round((Date.now() - t0) / 1000)}s: ${(err as Error).message}`);
        return 'failed';
      } finally {
        await client.query('RESET statement_timeout');
      }
      const { rows: [after] } = await client.query(PG_TABLES_ANALYZED_SQL);
      log.info(`[PG-STATS] ANALYZE done in ${Math.round((Date.now() - t0) / 1000)}s; ${Number(after?.unanalyzed) || 0} of ${Number(after?.big) || 0} large tables still unanalyzed`);
      return 'analyzed';
    });
  } finally {
    inFlight = false;
  }
}
