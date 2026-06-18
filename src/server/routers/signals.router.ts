import { z } from "zod";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { enqueueAISignals, getAIQueueStats } from "../queues";
import { router, publicProcedure } from "../trpc";

/** ISO timestamp `days` ago — used instead of SQLite datetime('now','-N days') so the
 *  same query runs on both SQLite and Postgres (a parameterised interval isn't portable). */
const daysAgoIso = (days: number) => new Date(Date.now() - days * 86_400_000).toISOString();

export const signalsRouter = router({
  getSignals: publicProcedure
    .input(z.object({ limit: z.number().optional().default(5) }))
    .query(async ({ input }) => {
      return dbAll('SELECT * FROM signals ORDER BY "createdAt" DESC LIMIT ?', [input.limit]);
    }),

  saveSignal: publicProcedure
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
      await dbRun(`
        INSERT INTO signals (symbol, type, entry, target, "stopLoss", confidence, reasoning, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `, [input.symbol, input.type, input.entry, input.target, input.stopLoss, input.confidence, input.reasoning]);
      return { success: true };
    }),

  enqueueSignals: publicProcedure
    .input(z.array(z.object({
      symbol:    z.string(),
      stockData: z.record(z.string(), z.unknown()),
    })))
    .mutation(async ({ input }) => enqueueAISignals(input)),

  getQueueStats: publicProcedure
    .query(async () => getAIQueueStats()),

  getSignalHistory: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      return dbAll('SELECT * FROM signals WHERE symbol = ? ORDER BY "createdAt" DESC', [input.symbol]);
    }),

  getAccuracyMetrics: publicProcedure
    .query(async () => {
      const stats = (await dbGet<{ total: number; profit: number; loss: number; resolved: number }>(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN result = 'PROFIT' THEN 1 ELSE 0 END) as profit,
          SUM(CASE WHEN result = 'LOSS'   THEN 1 ELSE 0 END) as loss,
          SUM(CASE WHEN status IN ('COMPLETED', 'FAILED') THEN 1 ELSE 0 END) as resolved
        FROM signals
      `))!;
      return {
        precision:     stats.resolved > 0 ? (stats.profit / stats.resolved) * 100 : 0,
        profitHitRate: stats.resolved > 0 ? (stats.profit / stats.resolved) * 100 : 0,
        totalSignals:  stats.total || 0,
      };
    }),

  saveSignalAction: publicProcedure
    .input(z.object({
      signalId: z.number(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']),
      symbol: z.string(),
      userId: z.string().optional(),
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
    .mutation(async ({ input }) => {
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
        input.signalId, input.signalSource, input.symbol, input.userId ?? null,
        input.actionType, input.quantity ?? null, input.entryPriceRec ?? null,
        input.entryActual ?? null, input.targetPriceRec ?? null,
        input.exitPriceActual ?? null, input.exitDate ?? null,
        input.pnl ?? null, input.pnlPct ?? null, input.notes ?? null,
      ]);
      return { success: true, signalId: input.signalId };
    }),

  getSignalActions: publicProcedure
    .input(z.object({
      symbol: z.string().optional(),
      userId: z.string().optional(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      limit: z.number().default(50),
      offset: z.number().default(0),
    }))
    .query(async ({ input }) => {
      let query = `
        SELECT id, signal_id, signal_source, symbol, action_type,
               executed_at, quantity, entry_price_rec, entry_actual,
               target_price_rec, exit_price_actual, pnl, pnl_pct, notes
        FROM signal_actions WHERE 1=1
      `;
      const params: unknown[] = [];
      if (input.symbol)       { query += ' AND symbol = ?';       params.push(input.symbol); }
      if (input.userId)       { query += ' AND user_id = ?';      params.push(input.userId); }
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

  getSignalActionMetrics: publicProcedure
    .input(z.object({
      userId: z.string().optional(),
      signalSource: z.enum(['AI', 'technical', 'quant', 'news']).optional(),
      days: z.number().default(30),
    }))
    .query(async ({ input }) => {
      let query = `
        SELECT signal_source, action_type, COUNT(*) as count,
               AVG(pnl_pct) as avg_pnl_pct, SUM(pnl) as total_pnl
        FROM signal_actions
        WHERE executed_at >= ?
      `;
      const params: unknown[] = [daysAgoIso(input.days)];
      if (input.userId)       { query += ' AND user_id = ?';       params.push(input.userId); }
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
      const hedges = correlationService.getHedgeRecommendations(input.signalId);
      const concentrationRisk = correlationService.getConcentrationRisk(input.signalId);
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
      return dbAll(`
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
          (SELECT close FROM stock_ohlcv WHERE symbol = us.symbol ORDER BY date DESC LIMIT 1) AS current_price,
          ROUND(
            COALESCE(
              100.0 * ((SELECT close FROM stock_ohlcv WHERE symbol = us.symbol ORDER BY date DESC LIMIT 1) - us.entry_price) / NULLIF(us.entry_price, 0),
              0.0
            ),
            2
          ) AS growth_pct
        FROM unified_signals us
        WHERE us.signal_generated_at >= ?
        ORDER BY us.signal_generated_at DESC
      `, [daysAgoIso(days)]);
    }),
});
