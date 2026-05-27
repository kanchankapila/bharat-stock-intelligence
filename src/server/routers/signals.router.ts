import { z } from "zod";
import db from "../db";
import { enqueueAISignals, getAIQueueStats } from "../queues";
import { router, publicProcedure } from "../trpc";

export const signalsRouter = router({
  getSignals: publicProcedure
    .input(z.object({ limit: z.number().optional().default(5) }))
    .query(({ input }) => {
      return db.prepare('SELECT * FROM signals ORDER BY createdAt DESC LIMIT ?').all(input.limit);
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
    .mutation(({ input }) => {
      db.prepare(`
        INSERT INTO signals (symbol, type, entry, target, stopLoss, confidence, reasoning, status)
        VALUES (?, ?, ?, ?, ?, ?, ?, 'ACTIVE')
      `).run(input.symbol, input.type, input.entry, input.target, input.stopLoss, input.confidence, input.reasoning);
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
    .query(({ input }) => {
      return db.prepare('SELECT * FROM signals WHERE symbol = ? ORDER BY createdAt DESC').all(input.symbol);
    }),

  getAccuracyMetrics: publicProcedure
    .query(() => {
      const stats = db.prepare(`
        SELECT
          COUNT(*) as total,
          SUM(CASE WHEN result = 'PROFIT' THEN 1 ELSE 0 END) as profit,
          SUM(CASE WHEN result = 'LOSS'   THEN 1 ELSE 0 END) as loss,
          SUM(CASE WHEN status IN ('COMPLETED', 'FAILED') THEN 1 ELSE 0 END) as resolved
        FROM signals
      `).get() as { total: number; profit: number; loss: number; resolved: number };
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
    .mutation(({ input }) => {
      db.prepare(`
        INSERT OR REPLACE INTO signal_actions (
          signal_id, signal_source, symbol, user_id, action_type,
          quantity, entry_price_rec, entry_actual, target_price_rec,
          exit_price_actual, exit_date, pnl, pnl_pct, notes, executed_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      `).run([
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
    .query(({ input }) => {
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

      const actions = db.prepare(query).all(...params) as Array<Record<string, unknown>>;
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
    .query(({ input }) => {
      let query = `
        SELECT signal_source, action_type, COUNT(*) as count,
               AVG(pnl_pct) as avg_pnl_pct, SUM(pnl) as total_pnl
        FROM signal_actions
        WHERE executed_at >= datetime('now', '-' || ? || ' days')
      `;
      const params: unknown[] = [input.days];
      if (input.userId)       { query += ' AND user_id = ?';       params.push(input.userId); }
      if (input.signalSource) { query += ' AND signal_source = ?'; params.push(input.signalSource); }
      query += ' GROUP BY signal_source, action_type';
      return { metrics: db.prepare(query).all(...params) };
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
    .query(({ input }) => {
      const metrics = db.prepare(`
        SELECT portfolio_symbol, correlation_score, co_movement_pct,
               hedge_potential, momentum_alignment, weight
        FROM signal_portfolio_correlation
        WHERE signal_id = ?
        ORDER BY ABS(correlation_score) DESC
      `).all(input.signalId) as Array<Record<string, unknown>>;
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
});
