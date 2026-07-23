import { z } from "zod";
import { dbGet, dbAll } from "../dbAsync";
import { fetchTechIndicators, fetchTechnicalTrends, fetchMCTechTrendsAllSegments } from "../marketData";
import { getCachedScan, runTechnicalScan } from "../technicalScanner";
import { getLatestRSIForSymbols } from "../technicalSignalsService";
import { getSymbolFromMcsymbol } from "../stockMapping";
import { alphaQuant } from "../alphaQuantClient";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { TRPCError } from "@trpc/server";

export const technicalsRouter = router({
  getTechnicalDetails: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.enum(['D', 'W', 'M']).optional() }))
    .query(async ({ input }) => fetchTechIndicators(input.symbol, input.dur)),

  getTechnicalScan: publicProcedure
    .input(z.object({ symbol: z.string(), forceRefresh: z.boolean().optional() }))
    .query(async ({ input }) => {
      if (!input.forceRefresh) {
        const cached = await getCachedScan(input.symbol);
        if (cached) return cached;
      }
      return runTechnicalScan(input.symbol);
    }),

  getTechnicalPredictions: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const row = await dbGet<any>('SELECT * FROM technical_analysis_signals WHERE symbol = ?', [input.symbol]);
      if (!row) return null;
      return { ...row, patterns: JSON.parse(row.patterns || '[]') };
    }),

  runTechnicalSignalScan: adminProcedure
    .input(z.object({ minScore: z.number().min(1).max(10).optional() }).optional())
    .mutation(async ({ input }) => {
      const { runTechnicalSignalScan } = await import('../technicalSignalsService');
      runTechnicalSignalScan({ minScore: input?.minScore ?? 2 }).catch(console.error);
      return { triggered: true };
    }),

  getTechnicalSignalsStatus: publicProcedure
    .query(async () => {
      const { getTechnicalSignalsProgress, getSignalSummary } = await import('../technicalSignalsService');
      return { progress: getTechnicalSignalsProgress(), summary: await getSignalSummary() };
    }),

  getTechnicalSignals: publicProcedure
    .input(z.object({
      date:             z.string().optional(),
      minScore:         z.number().min(1).max(10).default(1),
      minWinProbability:z.number().min(0).max(1).default(0),
      limit:            z.number().min(1).max(200).default(100),
    }))
    .query(async ({ input }) => {
      const { getTechnicalSignalsForDate } = await import('../technicalSignalsService');
      const rows = await getTechnicalSignalsForDate(
        input.date,
        input.minScore,
        input.minWinProbability,
        input.limit,
      );
      return rows.map(r => ({
        ...r,
        signals: (() => { try { return JSON.parse((r.signals_json as string) ?? '[]'); } catch { return []; } })(),
      }));
    }),

  getUnifiedSignals: publicProcedure
    .input(z.object({
      date:          z.string().optional(),
      minUnified:    z.number().min(0).max(1).default(0.55),
      minConfluence: z.number().min(0).max(100).default(40),
      limit:         z.number().min(1).max(100).default(50),
    }))
    .query(async ({ input }) => {
      let d = input.date;
      if (!d) {
        const maxRow = await dbGet<{ d: string }>('SELECT MAX(date) as d FROM technical_signals');
        d = maxRow?.d ?? new Date().toISOString().slice(0, 10);
      }
      return dbAll<any>(`
        WITH scored AS (
          SELECT
            ts.symbol, ns.name, ns.sector,
            ts.signal_score, ts.win_probability,
            cs.confluence_score, cs.conviction_level,
            ts.cmp, ts.stop_loss, ts.targets,
            ts.nifty_regime, ts.entry_zone, ts.ai_insight,
            ts.computed_at,
            ROUND(
              0.4 * (ts.signal_score / 10.0)
              + 0.4 * COALESCE(ts.win_probability, 0.5)
              + 0.2 * (COALESCE(cs.confluence_score, 0) / 100.0),
              3
            ) AS unified_score
          FROM technical_signals ts
          LEFT JOIN nse_stocks ns ON ns.symbol = ts.symbol
          LEFT JOIN confluence_signals cs
                 ON cs.symbol = ts.symbol AND date(cs.computed_at) = ?
          WHERE ts.date = ?
            AND COALESCE(cs.confluence_score, 0) >= ?
        )
        SELECT * FROM scored
        WHERE unified_score >= ?
        ORDER BY unified_score DESC
        LIMIT ?
      `, [d, d, input.minConfluence, input.minUnified, input.limit]);
    }),

  getSignalDates: publicProcedure
    .query(async () => {
      const { getSignalDates } = await import('../technicalSignalsService');
      return await getSignalDates();
    }),

  getSectorSignalStats: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => {
      const { getSectorSignalStats } = await import('../technicalSignalsService');
      return await getSectorSignalStats(input?.date);
    }),

  getSignalWinRates: publicProcedure
    .query(async () => {
      const { getWinRateStats } = await import('../signalOutcomesService');
      return await getWinRateStats();
    }),

  computeSignalOutcomes: adminProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(5) }))
    .mutation(async ({ input }) => {
      const { computeSignalOutcomes } = await import('../signalOutcomesService');
      return await computeSignalOutcomes(input.horizonDays);
    }),

  getSignalTypeStats: publicProcedure
    .input(z.object({ horizonDays: z.union([z.literal(5), z.literal(15)]).default(15) }).optional())
    .query(async ({ input }) => {
      const { getSignalTypeStats } = await import('../technicalSignalsService');
      return await getSignalTypeStats(input?.horizonDays ?? 15);
    }),

  computeSignalTypeStats: adminProcedure
    .mutation(async () => {
      const { computeSignalTypeStats } = await import('../technicalSignalsService');
      return await computeSignalTypeStats();
    }),

  getTechnicalTrends: publicProcedure
    .input(z.object({
      type:  z.enum(['bullish', 'bearish', 'turning-bullish', 'turning-bearish']),
      index: z.string().optional(),
    }))
    .query(async ({ input }) => {
      const result = await fetchTechnicalTrends(input.type, input.index);
      if (result?.success === 1) {
        const list = result.data?.list || result.data?.tableDataList || [];
        const enrichedList = list.map((item: any) => {
          const symbol = getSymbolFromMcsymbol(item.scId);
          return {
            ...item,
            symbol: symbol || item.scId,
            shortName: symbol || item.scId,
            lastPrice: parseFloat(String(item.currPrice || '0').replace(/,/g, '')),
            percentChange: parseFloat(item.performance || '0'),
            trend: item.currTrend || '',
            stockId: item.scId,
          };
        });
        const symbols = enrichedList.map((item: any) => item.symbol);
        const rsiMap = await getLatestRSIForSymbols(symbols);

        // Fetch RSI from MC API only for symbols missing from DB cache.
        // Concurrency capped at 5 to avoid hammering MC (was unbounded Promise.all).
        const missing = symbols.filter(s => !rsiMap.get(s));
        const CONCURRENCY = 5;
        for (let i = 0; i < missing.length; i += CONCURRENCY) {
          await Promise.all(missing.slice(i, i + CONCURRENCY).map(async sym => {
            try {
              const tech = await fetchTechIndicators(sym);
              const rsiInd = tech?.data?.indicators?.find(
                (ind: any) => ind.displayName?.includes('RSI') || ind.id === 'RSI'
              );
              if (rsiInd) rsiMap.set(sym, parseFloat(String(rsiInd.value || '0')));
            } catch { /* leave as 0 */ }
          }));
        }

        const finalData = enrichedList.map((item: any) => ({
          ...item,
          rsi: rsiMap.get(item.symbol) || 0,
        }));
        if (result.data?.list) result.data.list = finalData;
        if (result.data?.tableDataList) result.data.tableDataList = finalData;
      }
      return result;
    }),

  getTechTrendsBySegment: publicProcedure
    .input(z.object({ type: z.enum(['bullish', 'bearish', 'turning-bullish', 'turning-bearish']) }))
    .query(async ({ input }) => {
      const result = await fetchMCTechTrendsAllSegments(input.type);
      for (const [seg, list] of Object.entries(result)) {
        result[seg] = (list as any[]).map((item: any) => {
          const symbol = getSymbolFromMcsymbol(item.scId);
          return {
            ...item,
            symbol: symbol || item.scId,
            lastPrice: parseFloat(String(item.currPrice || '0').replace(/,/g, '')),
            percentChange: parseFloat(item.performance || '0'),
            trend: item.currTrend || '',
            prevTrend: item.prevTrend || '',
            trendChangeDate: item.trendChngDate || '',
          };
        });
      }
      return result;
    }),

  getTvTa: publicProcedure
    .input(z.object({ symbol: z.string(), exchange: z.string().optional().default('NSE') }))
    .query(async ({ input }) => {
      try {
        return await alphaQuant.getTvTa({ symbol: input.symbol, exchange: input.exchange });
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),

  getTvScreener: publicProcedure
    .query(async () => {
      try {
        return await alphaQuant.getTvScreener();
      } catch (err: any) {
        throw new TRPCError({ code: 'INTERNAL_SERVER_ERROR', message: err.message });
      }
    }),
});
