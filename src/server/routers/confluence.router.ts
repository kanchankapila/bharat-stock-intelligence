import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure, adminProcedure } from '../trpc';
import { computeConfluenceSignals, getLatestConfluenceSignals } from '../confluenceEngine';

// Cached latest computed_at for confluence_signals — avoids a MAX() scan on every request.
// Invalidated when refreshConfluenceSignals() runs.
let _confluenceLatestAt: string | null = null;

async function confluenceLatestAt(): Promise<string | null> {
  if (!_confluenceLatestAt) {
    const row = await dbGet<{ ts: string }>('SELECT MAX(computed_at) AS ts FROM confluence_signals');
    _confluenceLatestAt = row?.ts ?? null;
  }
  return _confluenceLatestAt;
}

export const confluenceRouter = router({

  // Ranked list of high-conviction signals (latest batch)
  getConfluenceSignals: publicProcedure
    .input(z.object({
      minScore:        z.number().min(0).max(100).optional(),
      convictionLevel: z.enum(['ELITE', 'STRONG', 'MODERATE', 'WEAK']).optional(),
      sector:          z.string().optional(),
      timeframe:       z.enum(['INTRADAY', 'SWING', 'POSITIONAL']).optional(),
      limit:           z.number().min(1).max(200).optional(),
    }).optional())
    .query(async ({ input }) => {
      return await getLatestConfluenceSignals({
        minScore:        input?.minScore ?? 30,
        convictionLevel: input?.convictionLevel,
        sector:          input?.sector,
        timeframe:       input?.timeframe,
        limit:           input?.limit ?? 50,
      });
    }),

  // Full detail for a single symbol (latest record + screener reliability)
  getConfluenceDetail: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const row = await dbGet<any>(`
        SELECT symbol, confluence_score, conviction_level, bullish_screener_count,
               bearish_screener_count, screener_names_json, screener_ids_json,
               sector, timeframe, computed_at, expires_at
        FROM confluence_signals
        WHERE symbol = ?
        ORDER BY computed_at DESC
        LIMIT 1
      `, [input.symbol]) ?? null;

      if (!row) return null;

      const screenerIds: string[] = JSON.parse(row.screener_ids_json ?? '[]');
      const reliability = screenerIds.length > 0
        ? await dbAll(`
            SELECT scan_id, screener_name, reliability_score, win_rate_7d, win_rate_30d, avg_return_7d, total_signals
            FROM screener_reliability
            WHERE scan_id IN (${screenerIds.map(() => '?').join(',')})
          `, [...screenerIds])
        : [];

      return { ...row, screenerReliability: reliability };
    }),

  // Scanner reliability leaderboard
  getScreenerReliability: publicProcedure
    .input(z.object({
      source:  z.enum(['trendlyne', 'moneycontrol', 'etnow', 'all']).optional().default('all'),
      limit:   z.number().min(1).max(100).optional().default(20),
      orderBy: z.enum(['reliability_score', 'win_rate_7d', 'win_rate_30d', 'avg_return_7d']).optional().default('reliability_score'),
    }).optional())
    .query(async ({ input }) => {
      const { source = 'all', limit = 20, orderBy = 'reliability_score' } = input ?? {};
      const safe = ['reliability_score', 'win_rate_7d', 'win_rate_30d', 'avg_return_7d'].includes(orderBy)
        ? orderBy : 'reliability_score';
      if (source !== 'all') {
        return dbAll(`
          SELECT scan_id, screener_name, source, reliability_score, win_rate_7d, win_rate_30d, avg_return_7d, total_signals
          FROM screener_reliability WHERE source = ? ORDER BY ${safe} DESC LIMIT ?
        `, [source, limit]);
      }
      return dbAll(`
        SELECT scan_id, screener_name, source, reliability_score, win_rate_7d, win_rate_30d, avg_return_7d, total_signals
        FROM screener_reliability ORDER BY ${safe} DESC LIMIT ?
      `, [limit]);
    }),

  // Trigger a fresh computation
  refreshConfluenceSignals: adminProcedure
    .mutation(async () => {
      const result = await computeConfluenceSignals();
      _confluenceLatestAt = null; // invalidate cache so next read re-queries MAX()
      return { success: true, ...result };
    }),

  // Sector momentum matrix
  getSectorMomentumMatrix: publicProcedure
    .query(async () => {
      const latest = await confluenceLatestAt();
      if (!latest) return [];
      return dbAll(`
        SELECT
          sector,
          COUNT(*) as stock_count,
          ROUND(AVG(confluence_score), 1) as avg_score,
          COUNT(CASE WHEN conviction_level IN ('ELITE','STRONG') THEN 1 END) as high_conviction_count,
          MAX(confluence_score) as max_score,
          GROUP_CONCAT(CASE WHEN conviction_level = 'ELITE' THEN symbol END, ',') as elite_symbols
        FROM confluence_signals
        WHERE computed_at = ?
          AND sector IS NOT NULL AND sector != ''
        GROUP BY sector
        ORDER BY avg_score DESC
        LIMIT 30
      `, [latest]);
    }),

  // Summary stats for the dashboard header
  getConfluenceStats: publicProcedure
    .query(async () => {
      const latest = await confluenceLatestAt();
      if (!latest) return { total: 0, elite: 0, strong: 0, moderate: 0, avgScore: 0, lastComputed: null };
      const row = await dbGet<any>(`
        SELECT
          COUNT(*) as total,
          COUNT(CASE WHEN conviction_level = 'ELITE'    THEN 1 END) as elite,
          COUNT(CASE WHEN conviction_level = 'STRONG'   THEN 1 END) as strong,
          COUNT(CASE WHEN conviction_level = 'MODERATE' THEN 1 END) as moderate,
          ROUND(AVG(confluence_score), 1) as "avgScore",
          ? as lastComputed
        FROM confluence_signals
        WHERE computed_at = ?
      `, [latest, latest]);
      if (!row?.total) return { total: 0, elite: 0, strong: 0, moderate: 0, avgScore: 0, lastComputed: null };
      return row;
    }),

  // Signal outcome analytics
  getConfluenceOutcomes: publicProcedure
    .input(z.object({
      symbol: z.string().optional(),
      limit:  z.number().optional().default(50),
    }).optional())
    .query(async ({ input }) => {
      const symbol = input?.symbol;
      const limit = input?.limit ?? 50;
      // Was `DATE(cs.computed_at) = so.signal_date` -- comparing a DATE-typed expression
      // (computed_at is TIMESTAMPTZ) against so.signal_date (TEXT). Postgres has no `date =
      // text` operator for a column with a declared TEXT type (only untyped literals get an
      // implicit cast), so this JOIN condition throws `operator does not exist: date = text` on
      // Postgres -- the exact bug class documented repeatedly in this codebase's history
      // (2026-07-22/23 date('now')::text fixes). It only "worked" on the SQLite dev fallback,
      // where DATE()/date comparisons are untyped string comparisons. Appending `::text` casts
      // the DATE side to match -- this is the same established pattern already applied to
      // confluence_signals.computed_at elsewhere (ml.router.ts's getSignalReportCard), and is a
      // no-op on SQLite (the cast is stripped by stripPgCasts, leaving the already-working
      // native `DATE(...)` comparison unchanged).
      if (symbol) {
        return dbAll(`
          SELECT so.*, cs.conviction_level, cs.bullish_screener_count, cs.screener_names_json
          FROM signal_outcomes so
          LEFT JOIN confluence_signals cs ON cs.symbol = so.symbol
            AND DATE(cs.computed_at)::text = so.signal_date
          WHERE so.symbol = ? AND so.signal_source = 'confluence'
          ORDER BY so.signal_date DESC
          LIMIT ?
        `, [symbol, limit]);
      }
      return dbAll(`
        SELECT so.*, cs.conviction_level, cs.bullish_screener_count, cs.screener_names_json
        FROM signal_outcomes so
        LEFT JOIN confluence_signals cs ON cs.symbol = so.symbol
          AND DATE(cs.computed_at)::text = so.signal_date
        WHERE so.signal_source = 'confluence'
        ORDER BY so.signal_date DESC
        LIMIT ?
      `, [limit]);
    }),
});
