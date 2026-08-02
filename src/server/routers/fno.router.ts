import { z } from "zod";
import { dbAll } from "../dbAsync";
import { getFnOSignals } from "../fnoService";
import { fetchOptionChain, fetchFnoSymbols } from "../optionChainService";
import { fetchFNOSymbols } from "../marketIntelService";
import { alphaQuant } from "../alphaQuantClient";
import { fetchWithCache } from "../cacheService";
import type { FnoIndexId } from "../marketIntelService";
import { router, publicProcedure, adminProcedure } from "../trpc";

export const fnoRouter = router({
  getFnOSignals: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => getFnOSignals(input.symbol)),

  getTrendlyneFnoScanners: publicProcedure
    .input(z.object({ mtype: z.enum(['options', 'futures']), screenType: z.string(), instType: z.string().optional() }))
    .query(async ({ input }) => {
      const { getTrendlyneFnoScanners } = await import('../fnoService');
      return getTrendlyneFnoScanners(input.mtype, input.screenType, input.instType);
    }),

  getMCFnoOverview: publicProcedure
    .input(z.object({ id: z.string(), instType: z.enum(['futures', 'options']).optional().default('futures') }))
    .query(async ({ input }) => {
      const { getMCFnoOverview } = await import('../fnoService');
      return getMCFnoOverview(input.id, input.instType);
    }),

  getOptionsIntelligence: publicProcedure
    .query(async () => {
      try {
        const rows = await dbAll<any>(`
          SELECT symbol, date, expiry, pcr, market_pcr, total_call_oi, total_put_oi
          FROM stock_options_oi
          WHERE date = (SELECT MAX(date) FROM stock_options_oi)
          ORDER BY pcr DESC
        `);
        return rows || [];
      } catch (e: any) {
        console.error('[FnO Router] Error fetching options intelligence:', e);
        return [];
      }
    }),

  getTrendlyneFnoHeatmap: publicProcedure
    .query(async () => {
      const { getTrendlyneFnoHeatmap } = await import('../fnoService');
      return getTrendlyneFnoHeatmap();
    }),

  getFnoSymbols: publicProcedure
    .query(async () => fetchWithCache('fno_symbols', fetchFnoSymbols, 3600)),

  getOptionChain: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => fetchOptionChain(input.symbol)),

  getIndexFno: publicProcedure
    .input(z.object({ id: z.enum(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']) }))
    .query(async ({ input }) => {
      const { fetchIndexFnoAll } = await import('../marketIntelService');
      return fetchIndexFnoAll(input.id as FnoIndexId);
    }),

  getStockFno: publicProcedure
    .input(z.object({ symbol: z.string(), expiry: z.string().optional() }))
    .query(async ({ input }) => {
      const { fetchStockFnoExpiry, fetchStockFnoFutures, fetchStockFnoOptions } = await import('../marketIntelService');
      const { resolveMoneycontrolSymbol } = await import('../stockMapping');
      const scId = await resolveMoneycontrolSymbol(input.symbol);
      if (!scId) {
        return { success: false, error: 'No MoneyControl mapping found for this symbol' };
      }

      let targetExpiry = input.expiry;
      
      // Auto-resolve nearest expiry if none provided
      if (!targetExpiry) {
        const expRes = await fetchStockFnoExpiry(scId);
        if (expRes?.success === 1 && Array.isArray(expRes?.data) && expRes.data.length > 0) {
          targetExpiry = expRes.data[0].expDate;
        }
      }

      if (!targetExpiry) {
        return { success: false, error: 'No expiry dates found' };
      }

      const [futures, optionsCE, optionsPE] = await Promise.all([
        fetchStockFnoFutures(scId, targetExpiry),
        fetchStockFnoOptions(scId, 'CE', targetExpiry),
        fetchStockFnoOptions(scId, 'PE', targetExpiry),
      ]);

      return {
        success: true,
        expiry: targetExpiry,
        futures,
        optionsCE,
        optionsPE
      };
    }),

  getMaxPainAlerts: publicProcedure
    .query(async () => {
      try {
        // so_stock_oi_summary.fut_price is not currently populated by the fetcher (data gap,
        // tracked separately) — use the latest stock_ohlcv close as the reference price instead.
        const rows = await dbAll<any>(`
          WITH latest_oi AS (
            SELECT symbol, MAX(date) AS max_date
            FROM so_stock_oi_summary
            WHERE max_pain IS NOT NULL
            GROUP BY symbol
          ),
          nearest_expiry AS (
            SELECT DISTINCT ON (o.symbol) o.symbol, o.expiry, o.max_pain, o.pcr, o.mwpl
            FROM so_stock_oi_summary o
            JOIN latest_oi l ON l.symbol = o.symbol AND l.max_date = o.date
            ORDER BY o.symbol, o.expiry ASC
          ),
          latest_close AS (
            SELECT DISTINCT ON (symbol) symbol, close, date
            FROM stock_ohlcv
            ORDER BY symbol, date DESC
          )
          SELECT n.symbol, ns.name, lc.close AS ltp, n.max_pain, n.pcr, n.mwpl,
                 ROUND((((lc.close - n.max_pain) / lc.close) * 100)::numeric, 2) AS diff_pct
          FROM nearest_expiry n
          JOIN latest_close lc ON lc.symbol = n.symbol AND lc.close > 0
          LEFT JOIN nse_stocks ns ON ns.symbol = n.symbol AND ns.status = 'ACTIVE'
          WHERE ABS(lc.close - n.max_pain) / lc.close > 0.003
          ORDER BY ABS(lc.close - n.max_pain) / lc.close DESC
          LIMIT 60
        `);
        return (rows || []).map((r: any) => {
          const diffPct = Number(r.diff_pct);
          const absPct = Math.abs(diffPct);
          const strength = absPct > 3 ? 'Strong Magnet' : absPct > 1.5 ? 'Moderate Magnet' : 'Weak Magnet';
          return {
            symbol: r.symbol,
            name: r.name || r.symbol,
            ltp: Number(r.ltp),
            maxPain: Number(r.max_pain),
            diffPct,
            strength,
            rec: diffPct < 0 ? 'Bullish Reversion Target' : 'Bearish Reversion Target',
          };
        });
      } catch (e: any) {
        console.error('[FnO Router] Error fetching max pain alerts:', e);
        return [];
      }
    }),

  // fno_rollover_fetcher.py has computed real per-symbol rollover% and cost-of-carry since it
  // shipped, but nothing ever assembled it into a dedicated view -- the closest thing to a
  // short-interest/positioning surface this platform has (equity F&O has no true short-interest
  // disclosure regime like US markets; rollover% + negative cost-of-carry is the standard local
  // proxy for aggressive short positioning rolling into the next series).
  getRolloverPositioning: publicProcedure
    .query(async () => {
      try {
        const rows = await dbAll<any>(`
          WITH latest AS (SELECT MAX(date) AS max_date FROM fno_rollover)
          SELECT r.symbol, ns.name, r.date, r.near_expiry, r.next_expiry, r.rollover_pct,
                 r.cost_of_carry_ann, r.near_oi, r.next_oi, r.total_oi, r.spot_price, r.near_close
          FROM fno_rollover r
          CROSS JOIN latest l
          LEFT JOIN nse_stocks ns ON ns.symbol = r.symbol AND ns.status = 'ACTIVE'
          WHERE r.date = l.max_date
          ORDER BY r.rollover_pct DESC NULLS LAST
        `);
        return (rows || []).map((r: any) => ({
          ...r,
          rollover_pct: r.rollover_pct != null ? Number(r.rollover_pct) : null,
          cost_of_carry_ann: r.cost_of_carry_ann != null ? Number(r.cost_of_carry_ann) : null,
          near_oi: r.near_oi != null ? Number(r.near_oi) : null,
          next_oi: r.next_oi != null ? Number(r.next_oi) : null,
          total_oi: r.total_oi != null ? Number(r.total_oi) : null,
          // Heuristic tag, not a data field: high rollover carried at a futures discount to spot
          // (negative annualized cost-of-carry) is the standard proxy for short positioning being
          // rolled forward rather than covered into expiry.
          positioning: r.cost_of_carry_ann != null && r.cost_of_carry_ann < -5 && r.rollover_pct != null && r.rollover_pct > 15
            ? 'SHORT_ROLL' : r.cost_of_carry_ann != null && r.cost_of_carry_ann > 5 && r.rollover_pct != null && r.rollover_pct > 15
            ? 'LONG_ROLL' : 'NEUTRAL',
        }));
      } catch (e: any) {
        console.error('[FnO Router] Error fetching rollover positioning:', e);
        return [];
      }
    }),

  runPcrFetch: adminProcedure
    .input(z.object({ symbols: z.array(z.string()).optional() }))
    .mutation(async ({ input }) => {
      try {
        const body = { symbols: input.symbols?.length ? input.symbols : undefined, delay: 0.2 };
        const data = await alphaQuant.getPcr(body, 60_000);
        return { success: true, data };
      } catch (err: any) {
        return { success: false, error: String(err) };
      }
    }),
});
