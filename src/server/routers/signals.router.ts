import { z } from "zod";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { enqueueAISignals, getAIQueueStats } from "../queues";
import { invalidateAISignalCache } from "../signals";
import { router, publicProcedure, protectedProcedure, adminProcedure, expensiveProcedure } from "../trpc";

/** ISO timestamp `days` ago — used instead of SQLite datetime('now','-N days') so the
 *  same query runs on both SQLite and Postgres (a parameterised interval isn't portable). */
const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

/** Cluster A collapsed the legacy `signals` table into `unified_signals` (snake_case columns).
 *  The signal UI still reads the old contract (type/entry/target/stopLoss/confidence/createdAt),
 *  so alias the unified columns back to it at the boundary instead of churning every consumer.
 *  camelCase aliases are double-quoted so PG preserves the casing (portability rule #1). */
const UNIFIED_SIGNAL_SELECT = `
  SELECT id, symbol, signal_source AS source,
         signal_type AS type, entry_price AS entry, target_price AS target,
         stop_loss AS "stopLoss", confidence_score AS confidence,
         reasoning, status, signal_generated_at AS "createdAt"
  FROM unified_signals`;

export const signalsRouter = router({
  getSignals: publicProcedure
    .input(z.object({ limit: z.number().optional().default(5) }))
    .query(async ({ input }) => {
      return dbAll(`${UNIFIED_SIGNAL_SELECT} ORDER BY signal_generated_at DESC LIMIT ?`, [input.limit]);
    }),

  // Writes directly into unified_signals (the platform's canonical signal table, read by
  // every signal UI/backtest downstream) — gated to admin, not a per-user resource.
  saveSignal: adminProcedure
    .input(z.object({
      symbol: z.string(),
      type: z.enum(['BUY', 'SELL', 'HOLD']),
      entry: z.number(),
      target: z.number(),
      stopLoss: z.number(),
      confidence: z.number(),
      reasoning: z.string(),
    }))
    .mutation(async ({ input }) => {
      const { upsertUnifiedSignal } = await import('../signals');
      await upsertUnifiedSignal('platform', {
        symbol: input.symbol,
        signalDate: new Date().toISOString().split('T')[0],
        signalType: input.type,
        entryPrice: input.entry,
        targetPrice: input.target,
        stopLoss: input.stopLoss,
        confidenceScore: input.confidence,
        reasoning: input.reasoning,
      });
      return { success: true };
    }),

  // .max(200): this array was unbounded, and every element becomes a BullMQ AI-queue job (an
  // LLM call each). The two real callers batch the visible dashboard table -- DashboardPage.tsx
  // and V3Dashboard.tsx -- which is tens of symbols, well under this ceiling.
  enqueueSignals: expensiveProcedure
    .input(z.array(z.object({
      symbol:    z.string().max(32),
      stockData: z.record(z.string(), z.unknown()),
    })).max(200))
    .mutation(async ({ input }) => enqueueAISignals(input)),

  getQueueStats: publicProcedure
    .query(async () => getAIQueueStats()),

  getSignalHistory: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return dbAll(`${UNIFIED_SIGNAL_SELECT} WHERE symbol = ? ORDER BY signal_generated_at DESC`, [input.symbol]);
    }),

  getAccuracyMetrics: publicProcedure
    .query(async () => {
      const stats = (await dbGet<{ total: number; profit: number; resolved: number }>(`
        SELECT
          COUNT(*) AS total,
          SUM(CASE WHEN outcome = 'WIN' THEN 1 ELSE 0 END) AS profit,
          SUM(CASE WHEN outcome IN ('WIN','LOSS','STOP_LOSS','NEUTRAL') THEN 1 ELSE 0 END) AS resolved
        FROM unified_signal_outcomes
      `))!;
      return {
        precision:     stats.resolved > 0 ? (stats.profit / stats.resolved) * 100 : 0,
        profitHitRate: stats.resolved > 0 ? (stats.profit / stats.resolved) * 100 : 0,
        totalSignals:  stats.total || 0,
      };
    }),

  // user_id below is always ctx.uid (the verified token owner), never client input — this is
  // a personal trade journal (quantity/entry/pnl/notes), so one user must never read or write
  // into another user's rows.
  saveSignalAction: protectedProcedure
    .input(z.object({
      signalId: z.number(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']),
      symbol: z.string(),
      actionType: z.enum(['BUY', 'SELL', 'HOLD', 'SKIP']),
      quantity: z.number().optional(),
      entryPriceRec: z.number().optional(),
      entryActual: z.number().optional(),
      targetPriceRec: z.number().optional(),
      exitPriceActual: z.number().optional(),
      exitDate: z.string().datetime().optional(),
      pnl: z.number().optional(),
      pnlPct: z.number().optional(),
      notes: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      // INSERT OR REPLACE -> explicit ON CONFLICT (unique key is signal_id, user_id).
      await dbRun(`
        INSERT INTO signal_actions (
          signal_id, signal_source, symbol, user_id, action_type,
          quantity, entry_price_rec, entry_actual, target_price_rec,
          exit_price_actual, exit_date, pnl, pnl_pct, notes, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
        ON CONFLICT(signal_id, user_id) DO UPDATE SET
          signal_source = excluded.signal_source, symbol = excluded.symbol,
          action_type = excluded.action_type, quantity = excluded.quantity,
          entry_price_rec = excluded.entry_price_rec, entry_actual = excluded.entry_actual,
          target_price_rec = excluded.target_price_rec, exit_price_actual = excluded.exit_price_actual,
          exit_date = excluded.exit_date, pnl = excluded.pnl, pnl_pct = excluded.pnl_pct,
          notes = excluded.notes, executed_at = CURRENT_TIMESTAMP
      `, [
        input.signalId, input.signalSource, input.symbol, ctx.uid,
        input.actionType, input.quantity ?? null, input.entryPriceRec ?? null,
        input.entryActual ?? null, input.targetPriceRec ?? null,
        input.exitPriceActual ?? null, input.exitDate ?? null,
        input.pnl ?? null, input.pnlPct ?? null, input.notes ?? null,
      ]);
      return { success: true, signalId: input.signalId };
    }),

  getSignalActions: protectedProcedure
    .input(z.object({
      symbol: z.string().optional(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input, ctx }) => {
      let query = `
        SELECT id, signal_id, signal_source, symbol, action_type,
               executed_at, quantity, entry_price_rec, entry_actual,
               target_price_rec, exit_price_actual, pnl, pnl_pct, notes
        FROM signal_actions WHERE user_id = ?
      `;
      const params: unknown[] = [ctx.uid];
      if (input.symbol)       { query += ' AND symbol = ?';       params.push(input.symbol); }
      if (input.signalSource) { query += ' AND signal_source = ?'; params.push(input.signalSource); }
      query += ' ORDER BY executed_at DESC LIMIT ? OFFSET ?';
      params.push(input.limit, input.offset);

      const actions = await dbAll<Record<string, unknown>>(query, params);
      let totalPnl = 0, winCount = 0, totalCount = 0;
      for (const a of actions) {
        const pnl = a.pnl as number | null;
        if (pnl !== null) { totalPnl += pnl; if (pnl > 0) winCount++; totalCount++; }
      }
      return {
        actions,
        stats: { totalPnl, winCount, totalCount, winRate: totalCount > 0 ? (winCount / totalCount * 100).toFixed(2) : '0' },
      };
    }),

  getSignalActionMetrics: protectedProcedure
    .input(z.object({
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      days: z.number().default(30),
    }))
    .query(async ({ input, ctx }) => {
      let query = `
        SELECT signal_source, action_type, COUNT(*) as count,
               AVG(pnl_pct) as avg_pnl_pct, SUM(pnl) as total_pnl
        FROM signal_actions
        WHERE executed_at >= ? AND user_id = ?
      `;
      const params: unknown[] = [daysAgoIso(input.days), ctx.uid];
      if (input.signalSource) { query += ' AND signal_source = ?'; params.push(input.signalSource); }
      query += ' GROUP BY signal_source, action_type';
      return { metrics: await dbAll(query, params) };
    }),

  getPortfolioSignalAlignment: publicProcedure
    .input(z.object({
      signalId: z.number(),
      signalSymbol: z.string(),
      portfolio: z.array(z.object({
        symbol: z.string(),
        weight: z.number(),
        quantity: z.number(),
        avgCost: z.number(),
        currentPrice: z.number(),
      })),
    }))
    .query(async ({ input }) => {
      const { correlationService } = await import('../correlationService');
      const [correlations, alignmentScore] = await Promise.all([
        correlationService.analyzeSignalPortfolioAlignment(input.signalId, input.signalSymbol, input.portfolio),
        correlationService.getPortfolioAlignmentScore(input.signalId),
      ]);
      const hedges = await correlationService.getHedgeRecommendations(input.signalId);
      const concentrationRisk = await correlationService.getConcentrationRisk(input.signalId);
      return {
        correlations, alignmentScore, hedges, concentrationRisk,
        recommendation: {
          alignmentLevel: alignmentScore > 70 ? 'high' : alignmentScore > 40 ? 'moderate' : 'low',
          isHedge: hedges.length > 0,
          riskLevel: concentrationRisk > 2 ? 'high' : concentrationRisk > 0 ? 'moderate' : 'low',
        },
      };
    }),

  getSignalCorrelationMetrics: publicProcedure
    .input(z.object({ signalId: z.number() }))
    .query(async ({ input }) => {
      const metrics = await dbAll<Record<string, unknown>>(`
        SELECT portfolio_symbol, correlation_score, co_movement_pct,
               hedge_potential, momentum_alignment, weight
        FROM signal_portfolio_correlation
        WHERE signal_id = ?
        ORDER BY ABS(correlation_score) DESC
      `, [input.signalId]);
      const avgCorrelation = metrics.length
        ? metrics.reduce((s, m) => s + (m.correlation_score as number), 0) / metrics.length : 0;
      return {
        metrics,
        stats: {
          avgCorrelation: parseFloat(avgCorrelation.toFixed(4)),
          positiveCorr: metrics.filter(m => (m.correlation_score as number) > 0.3).length,
          negativeCorr: metrics.filter(m => (m.correlation_score as number) < -0.3).length,
          totalHoldings: metrics.length,
        },
      };
    }),

  getSignalTracking: publicProcedure
    .input(z.object({ days: z.number().default(30) }).optional())
    .query(async ({ input }) => {
      const days = input?.days ?? 30;
      // Was `WHERE (symbol, date) IN (SELECT symbol, MAX(date) FROM stock_ohlcv GROUP BY
      // symbol)` -- full GROUP BY aggregation + re-scan. Same ROW_NUMBER() rewrite used at
      // scoring.router.ts's getStrategyPicks / ml.router.ts's getSignalReportCard.
      return dbAll(`
        WITH latest_price AS (
          SELECT symbol, close FROM (
            SELECT symbol, close,
                   ROW_NUMBER() OVER (PARTITION BY symbol ORDER BY date DESC) AS rn
            FROM stock_ohlcv
          ) t WHERE rn = 1
        )
        SELECT
          us.id,
          us.symbol,
          us.signal_source,
          us.signal_type,
          us.entry_price,
          us.target_price,
          us.stop_loss,
          us.confidence_score,
          us.status,
          us.signal_generated_at,
          us.reasoning,
          lp.close AS current_price,
          ROUND(COALESCE(100.0 * (lp.close - us.entry_price) / NULLIF(us.entry_price, 0), 0.0), 2) AS growth_pct
        FROM unified_signals us
        LEFT JOIN latest_price lp ON lp.symbol = us.symbol
        WHERE us.signal_generated_at >= ?
        ORDER BY us.signal_generated_at DESC
      `, [daysAgoIso(days)]);
    }),

  setAISignalMinConfidence: adminProcedure
    .input(z.object({ confidence: z.number().min(0).max(100) }))
    .mutation(async ({ input }) => {
      await dbRun(
        `INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"`,
        ['ai_signal_min_confidence', String(input.confidence)],
      );
      invalidateAISignalCache();
      return { success: true };
    }),
});
