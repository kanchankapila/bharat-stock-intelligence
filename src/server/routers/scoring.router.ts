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
        runQuantScoring().catch(console.error);
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
});
