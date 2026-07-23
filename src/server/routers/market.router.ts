import { z } from "zod";
import { dbGet, dbAll } from "../dbAsync";
import {
  fetchAllIndianIndices,
  fetchGlobalIndices,
  fetchSectorPerformance,
  fetchHistoricalOHLC,
  fetchMarketMap,
} from "../marketData";
import { fetchSectorTechnicalTrends } from "../sectorApiService";
import { fetchStockDataWithCache, getOrRefreshAllStocks } from "../liveStockData";
import { getLatestIntradayBreadth } from "../intradayBreadth";
import { fetchTopMovers } from "../topMoversService";
import { fetchNiftyTraderBreakouts } from "../marketData";
import { fetchGlobalMarketData } from "../globalMarketService";
import { generateStockAnalysis } from "../../services/aiService";
import { router, publicProcedure, adminProcedure } from "../trpc";
import { runPython } from "../pythonRunner";

export const marketRouter = router({
  getGlobalMarketData: publicProcedure
    .query(async () => fetchGlobalMarketData()),

  getLiveStocks: publicProcedure
    .query(async () => getOrRefreshAllStocks()),

  // Live intraday breadth nowcast + the daily HMM regime it refines. The daily regime is EOD and
  // slow; `riskTilt` reacts within one 5-min refresh so the UI can show "SIDEWAYS · RISK_OFF".
  //
  // The capture behind `breadth` runs off the Node process's own setInterval (liveStockData.ts),
  // not a BullMQ job with catch-up -- a restart or a slow refresh cycle can leave it hours old
  // with no signal of that (observed: a full-day outage and hours-old reads reaching consumers
  // as if live -- see intraday_regime.py's matching staleness guard). `isStale` lets any
  // consumer (UI, ranker) refuse to treat old numbers as current instead of trusting them blind.
  getIntradayBreadth: publicProcedure
    .query(async () => {
      const [breadth, regimeRow] = await Promise.all([
        getLatestIntradayBreadth(),
        dbGet(`SELECT value FROM app_settings WHERE key = 'current_nifty_regime'`),
      ]);
      const snapshotAt = (breadth as { snapshot_at?: string } | null)?.snapshot_at;
      const ageMin = snapshotAt ? (Date.now() - new Date(snapshotAt).getTime()) / 60_000 : null;
      const isStale = ageMin === null || ageMin > 20;
      return {
        breadth,
        dailyRegime: (regimeRow as { value?: string } | undefined)?.value ?? null,
        isStale,
        ageMinutes: ageMin === null ? null : Math.round(ageMin),
      };
    }),

  // Intraday ranking (separate from positional getTopRatedStocks / unified_recommendations).
  // `isStale` guards against a missed/failed intraday_ranker.py cycle (every 15 min in market
  // hours) silently presenting yesterday's or an hours-old batch as if it were fresh.
  getIntradayRecommendations: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(200).default(50) }).optional())
    .query(async ({ input }) => {
      const limit = input?.limit ?? 50;
      // `computed_at` is a DATE (the per-day upsert key, ON CONFLICT(symbol, computed_at) --
      // intentional, see intraday_ranker.py) so it can't tell a run from 5 min ago apart from
      // one from market open 7 hours ago. `computed_ts` (set to CURRENT_TIMESTAMP on every
      // write) is the actual last-run instant and is what staleness must be measured against.
      const [rows, latest] = await Promise.all([
        dbAll(
          `SELECT symbol, intraday_regime, intraday_score, conviction_level, classification,
                  screener_score, breakout_score, bullish_count, bearish_count,
                  cmp, entry_price, stop_loss, target_1, risk_reward, position_size_pct, reasoning
           FROM intraday_recommendations
           WHERE computed_at = (SELECT MAX(computed_at) FROM intraday_recommendations)
           ORDER BY intraday_score DESC LIMIT ?`,
          [limit],
        ),
        // Naive TIMESTAMP columns are now parsed as UTC globally (see pgClient.ts's TIMESTAMP
        // type-parser override) so this no longer needs a ::text + manual 'Z'-append workaround.
        dbGet(`SELECT MAX(computed_ts) as t FROM intraday_recommendations`),
      ]);
      const computedAtRaw = (latest as { t?: string | Date } | undefined)?.t ?? null;
      const computedAtDate = computedAtRaw ? new Date(computedAtRaw) : null;
      const ageMin = computedAtDate ? (Date.now() - computedAtDate.getTime()) / 60_000 : null;
      return {
        rows,
        computedAt: computedAtDate ? computedAtDate.toISOString() : null,
        isStale: ageMin === null || ageMin > 30,
        ageMinutes: ageMin === null ? null : Math.round(ageMin),
      };
    }),

  // Intraday paper-trade accuracy (from intraday_recommendation_outcomes).
  getIntradayAccuracy: publicProcedure
    .input(z.object({ days: z.number().min(1).max(365).default(30) }).optional())
    .query(async ({ input }) => {
      const days = input?.days ?? 30;
      const cutoff = new Date(Date.now() - days * 864e5).toISOString().slice(0, 10);
      const overall = await dbGet(
        `SELECT COUNT(*) AS total,
                SUM(CASE WHEN outcome='WIN'  THEN 1 ELSE 0 END) AS wins,
                SUM(CASE WHEN outcome='LOSS' THEN 1 ELSE 0 END) AS losses,
                AVG(pnl_pct) AS avg_pnl, SUM(pnl_pct) AS total_pnl
         FROM intraday_recommendation_outcomes WHERE computed_at >= ?`,
        [cutoff],
      );
      const byDay = await dbAll(
        `SELECT computed_at AS date, COUNT(*) AS n,
                SUM(CASE WHEN outcome='WIN' THEN 1 ELSE 0 END) AS wins,
                AVG(pnl_pct) AS avg_pnl
         FROM intraday_recommendation_outcomes WHERE computed_at >= ?
         GROUP BY computed_at ORDER BY computed_at DESC LIMIT 30`,
        [cutoff],
      );
      return { overall, byDay };
    }),

  getLiveStockQuote: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const data = await fetchStockDataWithCache(input.symbol);
      if (!data) throw new Error(`Failed to fetch live data for ${input.symbol}`);
      return data;
    }),

  getLiveQuotesBatch: publicProcedure
    .input(z.array(z.string()))
    .query(async ({ input }) => {
      if (!input || input.length === 0) return [];
      const results = await Promise.all(input.map(sym => fetchStockDataWithCache(sym)));
      return results.filter(Boolean);
    }),

  getStocks: publicProcedure
    .input(z.object({ limit: z.number().optional().default(10), sector: z.string().optional() }))
    .query(async ({ input }) => {
      const all = await getOrRefreshAllStocks();
      const filtered = input.sector ? all.filter((s: any) => s.sector === input.sector) : all;
      return filtered.slice(0, input.limit);
    }),

  getMarketOverview: publicProcedure
    .query(async () => {
      const parse = (s: unknown) => parseFloat(String(s ?? '0').replace(/,/g, '')) || 0;
      const { getIndexByName } = await import('../indexMapping');
      const extractId = (name: string, url: string) => {
        const m = url?.match(/-(\d+)\.html$/);
        if (m) return m[1];
        return getIndexByName(name)?.id || null;
      };
      try {
        const data = await fetchAllIndianIndices();
        if (data?.success === 1) {
          const keyList: any[] = data.data?.indiceList?.[0]?.list ?? [];
          const find = (name: string) => keyList.find((i: any) => i.name === name);
          const n50 = find('NIFTY 50');
          const sx  = find('SENSEX');
          const bnk = find('NIFTY BANK');
          if (n50 && sx && bnk) {
            return {
              nifty50:   { indId: extractId('NIFTY 50', n50.url),    value: parse(n50.value),  change: parse(n50.change),  changePct: parse(n50.changePer)  },
              sensex:    { indId: extractId('SENSEX', sx.url),        value: parse(sx.value),   change: parse(sx.change),   changePct: parse(sx.changePer)   },
              bankNifty: { indId: extractId('NIFTY BANK', bnk.url),  value: parse(bnk.value),  change: parse(bnk.change),  changePct: parse(bnk.changePer)  },
            };
          }
        }
      } catch (e) { console.error(e); }
      return {
        nifty50:   { indId: '9',  value: null, change: null, changePct: null, stale: true },
        sensex:    { indId: '4',  value: null, change: null, changePct: null, stale: true },
        bankNifty: { indId: '23', value: null, change: null, changePct: null, stale: true },
      };
    }),

  getTopMovers: publicProcedure
    .query(async () => fetchTopMovers()),

  getBreakouts: publicProcedure
    .query(async () => fetchNiftyTraderBreakouts()),

  getEarlyHoursPredictions: publicProcedure
    .input(z.object({ date: z.string().optional() }).optional())
    .query(async ({ input }) => {
      let targetDate = input?.date;
      if (!targetDate) {
        const row = await dbGet<{ date: string }>(
          'SELECT MAX(date) as date FROM early_hours_predictions'
        );
        targetDate = row?.date;
      }
      if (!targetDate) return [];
      
      const rows = await dbAll<any>(
        'SELECT * FROM early_hours_predictions WHERE date = ? ORDER BY score DESC',
        [targetDate]
      );
      
      return rows.map((r: any) => ({
        symbol: r.symbol,
        date: r.date,
        score: r.score,
        iepGapPct: r.iep_gap_pct,
        preopenImbalance: r.preopen_imbalance,
        deliverySpikePct: r.delivery_spike_pct,
        hasCorporateAction: r.has_corporate_action === 1,
        corporateActionTitle: r.corporate_action_title,
        breakoutSignals: r.breakout_signals ? r.breakout_signals.split(',') : [],
        reasons: JSON.parse(r.reasons_json || '[]'),
        computedAt: r.computed_at,
      }));
    }),

  // High-flyer retrospective: yesterday's recall report + learned precursor lifts +
  // today's fresh-setup candidate watchlist (see high_flyer_retrospective.py).
  getHighFlyerReport: publicProcedure
    .query(async () => {
      const stats = await dbGet<any>(
        'SELECT date, universe_n, flyer_n, recall_json FROM high_flyer_daily_stats ORDER BY date DESC LIMIT 1'
      );
      const lifts = await dbGet<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = 'high_flyer_precursor_lift'"
      );
      const candidates = await dbAll<any>(
        `SELECT date, symbol, score, precursors FROM high_flyer_candidates
         WHERE date = (SELECT MAX(date) FROM high_flyer_candidates) ORDER BY score DESC`
      );
      const flyers = stats ? await dbAll<any>(
        `SELECT symbol, return_pct, volume_ratio, new_52w_high, predicted_by, precursors
         FROM high_flyer_retrospective WHERE date = ? ORDER BY return_pct DESC LIMIT 50`,
        [stats.date]
      ) : [];
      return {
        date: stats?.date ?? null,
        universeN: stats?.universe_n ?? 0,
        flyerN: stats?.flyer_n ?? 0,
        recall: stats ? JSON.parse(stats.recall_json || '{}') : {},
        lifts: lifts ? JSON.parse(lifts.value || '{}') : {},
        candidates,
        flyers,
      };
    }),

  refreshEarlyHoursSpotter: adminProcedure
    .mutation(async () => {
      console.log('[TRPC] Running preopen_fetcher.py manually...');
      await runPython('preopen_fetcher.py', [], 60_000);
      console.log('[TRPC] Running early_hours_predictor.py manually...');
      await runPython('early_hours_predictor.py', [], 60_000);
      return { success: true };
    }),

  getSectorPerformance: publicProcedure
    .input(z.object({
      indexId: z.string().optional(),
      dur:     z.enum(['1d', '5d', '1m', '3m', '6m', '1y']).optional(),
      type:    z.enum(['top', 'under']).optional(),
      section: z.enum(['sector', 'industry']).optional(),
      limit:   z.number().optional(),
    }).optional())
    .query(async ({ input }) => {
      const data = await fetchSectorPerformance(input);
      if (data && data.success === 1 && data.data) {
        return data.data.map((s: any) => {
          const name = s.sectorName || s.sector || 'Unknown';
          const rawChange = s.percentChange ?? s.mcapPerChange ?? 0;
          const change = typeof rawChange === 'number' ? rawChange : parseFloat(String(rawChange).replace(/,/g, ''));
          return { name, change: isNaN(change) ? 0 : change, stocks: s.stocksCount || 0 };
        });
      }
      const allStocks = await getOrRefreshAllStocks();
      const sectorMap = new Map<string, number[]>();
      for (const stock of allStocks) {
        const sector = (stock as any).sector || (stock as any).industry;
        if (sector && sector !== 'Unknown') {
          if (!sectorMap.has(sector)) sectorMap.set(sector, []);
          sectorMap.get(sector)!.push(stock.changePct);
        }
      }
      return Array.from(sectorMap.entries())
        .map(([name, changes]) => {
          const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
          return { name, change: isNaN(avgChange) ? 0 : Number(avgChange.toFixed(2)), stocks: changes.length };
        })
        .sort((a, b) => b.change - a.change);
    }),

  getSectorTechnicalTrends: publicProcedure
    .input(z.object({ sectorName: z.string() }))
    .query(async ({ input }) => {
      return await fetchSectorTechnicalTrends(input.sectorName);
    }),

  getOHLCData: publicProcedure
    .input(z.object({ symbol: z.string(), dur: z.string().optional() }))
    .query(async ({ input }) => fetchHistoricalOHLC(input.symbol, input.dur)),

  getMarketMapData: publicProcedure
    .input(z.object({ indId: z.string().optional() }))
    .query(async ({ input }) => fetchMarketMap(input.indId)),

  getScreenerResults: publicProcedure
    .input(z.object({
      filter: z.string(),
      sector: z.string().optional(),
      minPe: z.number().optional(),
      maxPe: z.number().optional(),
      minRoe: z.number().optional(),
      maxPb: z.number().optional(),
      maxDe: z.number().optional(),
    }))
    .query(async ({ input }) => {
      const allStocks = await getOrRefreshAllStocks();
      let data: any[] = allStocks;
      if (input.filter === 'Gainers') {
        data = data.filter(s => s.changePct > 0).sort((a, b) => b.changePct - a.changePct);
      } else if (input.filter === 'Losers') {
        data = data.filter(s => s.changePct < 0).sort((a, b) => a.changePct - b.changePct);
      } else if (input.filter === 'Near 52W High') {
        data = data.filter(s => s.high52w && s.high52w > 0 && (s.price / s.high52w) > 0.95)
          .sort((a, b) => (b.price / b.high52w) - (a.price / a.high52w));
      } else if (input.filter === 'Near 52W Low') {
        data = data.filter(s => s.low52w && s.low52w > 0 && (s.price / s.low52w) < 1.05)
          .sort((a, b) => (a.price / a.low52w) - (b.price / b.low52w));
      } else if (input.filter === 'High Volume') {
        data = [...data].sort((a: any, b: any) => {
          const parseVol = (v: string) => {
            if (!v) return 0;
            if (v.endsWith('M')) return parseFloat(v) * 1_000_000;
            if (v.endsWith('K')) return parseFloat(v) * 1_000;
            return parseFloat(v) || 0;
          };
          return parseVol(b.volume) - parseVol(a.volume);
        });
      }
      if (input.sector && input.sector !== 'All') {
        data = data.filter(s => s.sector === input.sector);
      }
      return data.slice(0, 200);
    }),

  generateTrendReport: adminProcedure
    .input(z.object({ symbol: z.string() }))
    .mutation(async ({ input }) => {
      const stock = await fetchStockDataWithCache(input.symbol);
      if (!stock) throw new Error('Stock not found');
      const analysis = await generateStockAnalysis(stock.symbol, stock);
      return {
        title: `${stock.symbol} Deep Intelligence Report`,
        summary: `Strategic analysis for ${(stock as any).name || stock.symbol} based on current market dynamics.`,
        investmentThesis: analysis.reasoning,
        riskFactors: [
          'Market volatility and sector-specific rotation.',
          'Potential resistance near multi-month highs.',
          'Global macro-economic shifts affecting export revenues.',
        ],
        outlook: analysis.sentiment,
        generatedAt: new Date().toISOString(),
      };
    }),
});
