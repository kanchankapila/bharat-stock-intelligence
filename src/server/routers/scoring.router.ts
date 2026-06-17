import { z } from "zod";
import db from "../db";
import { getTopRatedStocks, syncAndScore, recalculateScores, getStockScoreDetail } from "../scoringService";
import { crossSourceFilter, regimeSectorFilter, qualityOversoldScanner } from "../strategySignalsService";
import { router, publicProcedure } from "../trpc";

export const scoringRouter = router({
  getTopRatedStocks: publicProcedure
    .input(z.object({
      limit: z.number().optional().default(50),
      timeframe: z.enum(['long_term', 'intraday']).optional().default('long_term'),
    }))
    .query(({ input }) => getTopRatedStocks(input.limit, input.timeframe)),

  getStockScoreDetail: publicProcedure
    .input(z.object({
      symbol: z.string(),
      timeframe: z.enum(['long_term', 'intraday']).optional().default('long_term'),
    }))
    .query(({ input }) => getStockScoreDetail(input.symbol, input.timeframe)),

  triggerStockScoring: publicProcedure
    .mutation(async () => syncAndScore()),

  recalculateScoresOnly: publicProcedure
    .mutation(async () => recalculateScores()),

  runQuantScoring: publicProcedure
    .mutation(async () => {
      const { quantScoringQueue } = await import('../queues');
      if (!quantScoringQueue) {
        const { runQuantScoring } = await import('../quantScoringService');
        runQuantScoring().catch(err =>
          console.error('[QUANT] Manual trigger error:', (err as Error).message)
        );
        return { queued: false, message: 'Running directly (no Redis)' };
      }
      const [waiting, active] = await Promise.all([quantScoringQueue.getWaiting(), quantScoringQueue.getActive()]);
      if (waiting.length + active.length > 0) return { queued: false, message: 'Scoring already queued or running' };
      await quantScoringQueue.add('quant-score-manual', {}, { removeOnComplete: 3, removeOnFail: 3, attempts: 1 });
      return { queued: true, message: 'Quant scoring job enqueued' };
    }),

  getQuantScoringStatus: publicProcedure
    .query(async () => {
      const { getQuantScoringProgress, getQuantScoreSummary } = await import('../quantScoringService');
      return { progress: getQuantScoringProgress(), summary: getQuantScoreSummary() };
    }),

  getStrategyStocks: publicProcedure
    .input(z.object({
      strategy: z.enum(['composite', 'momentum', 'quality', 'value', 'confluence', 'investment_picks']).default('composite'),
      limit: z.number().min(1).max(100).default(25),
      filters: z.object({
        minSharpe:       z.number().optional(),
        maxVol:          z.number().optional(),
        maxDrawdown:     z.number().optional(),
        aboveSma200:     z.boolean().optional(),
        maxPE:           z.number().optional(),
        minROE:          z.number().optional(),
        maxDebtToEquity: z.number().optional(),
        minPiotroski:    z.number().optional(),
        minMarketCapCr:  z.number().optional(),
      }).optional(),
    }))
    .query(async ({ input }) => {
      const { getStrategyStocks } = await import('../quantScoringService');
      return getStrategyStocks(input.strategy, input.limit, input.filters ?? {});
    }),

  getQuantScore: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const { getQuantScore } = await import('../quantScoringService');
      return getQuantScore(input.symbol) ?? null;
    }),

  getConvergenceSignals: publicProcedure
    .input(z.object({ minScore: z.number().optional().default(65) }))
    .query(({ input }) => crossSourceFilter(input.minScore)),

  getRegimeSectorSignals: publicProcedure
    .input(z.object({
      topNSectors:       z.number().optional().default(3),
      minScore:          z.number().optional().default(60),
      minWinProbability: z.number().optional().default(0.50),
    }))
    .query(({ input }) => regimeSectorFilter(input.topNSectors, input.minScore, input.minWinProbability)),

  getQualityOversoldSignals: publicProcedure
    .input(z.object({ maxRsi: z.number().optional().default(35), maxScore: z.number().optional().default(65) }))
    .query(({ input }) => qualityOversoldScanner(input.maxRsi, input.maxScore)),

  getStrategyPicks: publicProcedure
    .query(() => {
      const latestPriceCte = `
        WITH latest_prices AS (
          SELECT o.symbol, o.close
          FROM stock_ohlcv o
          JOIN (SELECT symbol, MAX(date) AS max_date FROM stock_ohlcv GROUP BY symbol) latest
            ON latest.symbol = o.symbol AND latest.max_date = o.date
        )
      `;
      const invRows = db.prepare(`${latestPriceCte}
        SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
               GROUP_CONCAT(DISTINCT es.screener_id) as et_screeners,
               GROUP_CONCAT(DISTINCT ms.scan_id) as mc_screeners
        FROM nse_stocks n
        JOIN etnow_screener_stocks es ON n.symbol = es.symbol
        LEFT JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
        LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
        WHERE es.screener_id IN ('79', '73', '75', '195', '515', '91', '362')
        GROUP BY n.symbol
        HAVING COUNT(DISTINCT es.screener_id) >= 2
        ORDER BY COUNT(DISTINCT es.screener_id) DESC
        LIMIT 30
      `).all() as any[];

      const investmentPicks = invRows.map(r => {
        const etIds: string[] = r.et_screeners ? r.et_screeners.split(',') : [];
        let fundamentalScore = 0, technicalScore = 0;
        const reasons: string[] = [];
        if (etIds.includes('79'))  { fundamentalScore += 30; reasons.push('Zero Debt'); }
        if (etIds.includes('73'))  { fundamentalScore += 30; reasons.push('Cash Cow'); }
        if (etIds.includes('75'))  { fundamentalScore += 20; reasons.push('Elite Bluechip'); }
        if (etIds.includes('195')) { fundamentalScore += 20; reasons.push('Multibagger Potential'); }
        if (etIds.includes('515')) { fundamentalScore += 20; reasons.push('Monopoly Biz'); }
        if (etIds.includes('91'))  { technicalScore  += 50; reasons.push('Buy on Dips'); }
        if (etIds.includes('362')) { technicalScore  += 50; reasons.push('RSI Oversold'); }
        const mcIds: string[] = r.mc_screeners ? r.mc_screeners.split(',') : [];
        if (mcIds.length > 0) { fundamentalScore += 10; reasons.push('MC Pro Fundamental Pick'); }
        return {
          symbol: r.symbol, name: r.companyName, sector: r.sector, price: r.currentPrice,
          score: Math.min(100, Math.round(fundamentalScore * 0.6 + technicalScore * 0.4)),
          reasons,
        };
      }).filter(p => p.score > 30).sort((a, b) => b.score - a.score);

      const intradayRows = db.prepare(`${latestPriceCte}
        SELECT n.symbol, n.name as companyName, n.sector, lp.close as currentPrice,
               GROUP_CONCAT(DISTINCT ts.screener_id) as tl_screeners,
               GROUP_CONCAT(DISTINCT ms.scan_id) as mc_screeners
        FROM nse_stocks n
        JOIN trendlyne_screener_stocks ts ON n.symbol = ts.symbol
        JOIN trendlyne_screeners tls ON tls.screener_id = ts.screener_id
        LEFT JOIN screener_master sm ON sm.scan_id = ts.screener_id
        LEFT JOIN moneycontrol_screener_stocks ms ON n.symbol = ms.symbol
        LEFT JOIN latest_prices lp ON lp.symbol = n.symbol
        WHERE tls.timeframe = 'intraday' OR sm.inferred_timeframe = 'intraday'
        GROUP BY n.symbol
        HAVING tl_screeners IS NOT NULL
        ORDER BY COUNT(DISTINCT ts.screener_id) DESC
        LIMIT 30
      `).all() as any[];

      const intradayPicks = intradayRows.map(r => {
        const tlIds: string[] = r.tl_screeners ? r.tl_screeners.split(',') : [];
        const mcIds: string[] = r.mc_screeners ? r.mc_screeners.split(',') : [];
        return {
          symbol: r.symbol, name: r.companyName, sector: r.sector, price: r.currentPrice,
          score: Math.min(100, 50 + tlIds.length * 15 + mcIds.length * 5),
          reasons: [
            ...tlIds.map(id => 'Trendlyne Intraday ID: ' + id),
            ...(mcIds.length > 0 ? ['MC Tech/Pro Scanner'] : []),
          ],
        };
      }).sort((a, b) => b.score - a.score);

      return { investmentPicks, intradayPicks };
    }),

  getBestComboSignals: publicProcedure
    .input(z.object({
      limit: z.number().min(1).max(50).default(20),
      requireUnifiedRec: z.boolean().default(false),
    }))
    .query(({ input }) => {
      const regimeRow = db.prepare(
        'SELECT regime FROM market_regimes ORDER BY date DESC LIMIT 1'
      ).get() as { regime: string } | undefined;
      const regime = regimeRow?.regime ?? 'UNKNOWN';

      if (!['BULL', 'SIDEWAYS'].includes(regime)) {
        return { regime, reason: `${regime} regime — gates closed`, stocks: [] };
      }

      const urFilter = input.requireUnifiedRec
        ? `AND ur.conviction_level IN ('A_HIGH','B_MEDIUM')`
        : '';

      const rows = db.prepare(`
        WITH ranked AS (
          SELECT *,
            ROW_NUMBER() OVER (
              PARTITION BY symbol ORDER BY signal_date DESC, signal_score DESC
            ) AS rn
          FROM signal_outcomes
          WHERE outcome IN ('WIN','PENDING')
            AND signal_score >= 5
            AND (signals_json LIKE '%RSI_DIVERGENCE%' OR signals_json LIKE '%EMA_BULL_STACK%')
        )
        SELECT
          r.symbol, ns.name, ns.sector,
          r.signal_score, r.entry_price, r.signals_json,
          qs.piotroski_f_score, qs.sharpe_ratio, qs.rank_composite,
          qs.bullish_screener_count, qs.return_12m,
          ur.conviction_level, ur.avg_engine_track_record,
          COALESCE(ur.stop_loss, r.entry_price * 0.95) AS stop_loss,
          COALESCE(ur.target_1,  r.entry_price * 1.12) AS target
        FROM ranked r
        JOIN quant_scores qs ON qs.symbol = r.symbol
        JOIN nse_stocks ns ON ns.symbol = r.symbol
        LEFT JOIN unified_recommendations ur
          ON ur.symbol = r.symbol
          AND ur.computed_at = (SELECT MAX(computed_at) FROM unified_recommendations)
        WHERE r.rn = 1
          AND qs.piotroski_f_score >= 7
          AND qs.above_sma200 = 1
          AND qs.sharpe_ratio > 1.0
          AND (ns.sector IN ('Financials','Healthcare','Industrials','Materials','Energy') OR ns.sector = 'Unknown' OR ns.sector IS NULL OR ns.sector = '')
          ${urFilter}
        ORDER BY COALESCE(ur.avg_engine_track_record, 1.0) DESC, qs.rank_composite DESC
        LIMIT ?
      `).all(input.limit) as any[];

      const stocks = rows.map(row => {
        const signalTypes: string[] = [];
        try {
          (JSON.parse(row.signals_json ?? '[]') as any[])
            .forEach(s => { if (s.type) signalTypes.push(s.type as string); });
        } catch { /* malformed json — skip */ }

        const entry  = (row.entry_price as number) ?? 0;
        const stop   = (row.stop_loss as number)   ?? entry * 0.95;
        const target = (row.target as number)       ?? entry * 1.12;
        const rrRatio = entry > 0 && stop < entry
          ? parseFloat(((target - entry) / (entry - stop)).toFixed(2))
          : 0;

        return {
          symbol:               row.symbol as string,
          name:                 (row.name as string) ?? row.symbol,
          sector:               (row.sector as string) ?? 'Unknown',
          signalScore:          (row.signal_score as number) ?? 0,
          entryPrice:           parseFloat((entry).toFixed(2)),
          signalTypes,
          piotroski:            (row.piotroski_f_score as number) ?? 0,
          sharpeRatio:          parseFloat(((row.sharpe_ratio as number) ?? 0).toFixed(2)),
          rankComposite:        parseFloat(((row.rank_composite as number) ?? 0).toFixed(1)),
          bullishScreenerCount: (row.bullish_screener_count as number) ?? 0,
          return12m:            parseFloat(((row.return_12m as number) ?? 0).toFixed(1)),
          convictionLevel:      (row.conviction_level as string) ?? null,
          avgTrackRecord:       row.avg_engine_track_record != null
                                  ? parseFloat((row.avg_engine_track_record as number).toFixed(3))
                                  : null,
          stopLoss:  parseFloat(stop.toFixed(2)),
          target:    parseFloat(target.toFixed(2)),
          rrRatio,
        };
      });

      return { regime, reason: `${stocks.length} setups pass all 4 gates`, stocks };
    }),
});
