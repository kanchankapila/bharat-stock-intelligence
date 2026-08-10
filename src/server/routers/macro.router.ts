import { z } from "zod";
import { dbAll } from "../dbAsync";
import { router, publicProcedure } from "../trpc";
import { fetchWithCache } from "../cacheService";

// Curated subset of macro_asset_prices.symbol — the table also carries ~40 internal/derived
// feature columns (ADR spreads, GEX, breadth scores) used by the ML pipeline that aren't
// meaningful as a standalone macro dashboard tile.
const MACRO_TILES: { symbol: string; label: string; group: string; unit?: string }[] = [
  { symbol: "USDINR", label: "USD/INR", group: "FX" },
  { symbol: "EURINR", label: "EUR/INR", group: "FX" },
  { symbol: "GBPINR", label: "GBP/INR", group: "FX" },
  { symbol: "DXY", label: "Dollar Index", group: "FX" },
  { symbol: "GOLD", label: "Gold", group: "Commodities", unit: "$/oz" },
  { symbol: "CRUDE", label: "Crude Oil (WTI)", group: "Commodities", unit: "$/bbl" },
  { symbol: "BRENT", label: "Brent Crude", group: "Commodities", unit: "$/bbl" },
  { symbol: "INDIAVIX", label: "India VIX", group: "Volatility" },
  { symbol: "INDIA_10Y", label: "India 10Y Yield", group: "Rates", unit: "%" },
  { symbol: "US10Y", label: "US 10Y Yield", group: "Rates", unit: "%" },
  { symbol: "INDIA_US_SPREAD", label: "India-US 10Y Spread", group: "Rates", unit: "%" },
  { symbol: "SP500", label: "S&P 500", group: "Global Indices" },
  { symbol: "NASDAQ", label: "Nasdaq", group: "Global Indices" },
  { symbol: "DOW", label: "Dow Jones", group: "Global Indices" },
  { symbol: "HANGSENG", label: "Hang Seng", group: "Global Indices" },
  { symbol: "NIKKEI", label: "Nikkei 225", group: "Global Indices" },
  { symbol: "FII_NET_TODAY", label: "FII Net Flow", group: "Flows", unit: "₹Cr" },
  { symbol: "DII_NET_TODAY", label: "DII Net Flow", group: "Flows", unit: "₹Cr" },
  { symbol: "GIFT_NIFTY", label: "GIFT Nifty", group: "Pre-Open" },
];

export const macroRouter = router({
  getMacroSnapshot: publicProcedure.query(async () => {
    try {
      const symbols = MACRO_TILES.map(t => t.symbol);
      const placeholders = symbols.map(() => "?").join(",");
      const rows = await dbAll<any>(
        `WITH latest AS (
           SELECT symbol, MAX(date) AS max_date
           FROM macro_asset_prices
           WHERE symbol IN (${placeholders})
           GROUP BY symbol
         )
         SELECT m.symbol, m.date, m.close, m.ret_1d, m.ret_5d
         FROM macro_asset_prices m
         JOIN latest l ON l.symbol = m.symbol AND l.max_date = m.date`,
        symbols
      );
      const bySymbol = new Map(rows.map((r: any) => [r.symbol, r]));
      return MACRO_TILES.map(tile => {
        const r = bySymbol.get(tile.symbol);
        return {
          ...tile,
          date: r?.date ?? null,
          close: r ? Number(r.close) : null,
          ret1d: r?.ret_1d != null ? Number(r.ret_1d) : null,
          ret5d: r?.ret_5d != null ? Number(r.ret_5d) : null,
        };
      });
    } catch (e: any) {
      console.error("[Macro Router] Error fetching macro snapshot:", e);
      return [];
    }
  }),

  // preopen_stock_snapshot is written once/day at ~9:10 AM IST (preopen_fetcher.py, 5 min
  // before the 9:15 open) but had no tRPC reader — this is the "who's gapping before the
  // bell" list that data feeds, keyed on the latest snapshot_date it wrote.
  getPreMarketMovers: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(50).optional().default(10) }))
    .query(async ({ input }) => {
      return fetchWithCache(`premarket_movers_${input.limit}`, async () => {
        try {
          const latest = await dbAll<any>(
            `SELECT MAX(snapshot_date) AS d FROM preopen_stock_snapshot`, []
          );
          const asOfDate = latest[0]?.d ?? null;
          if (!asOfDate) return { asOfDate: null, gapUp: [], gapDown: [] };

          const rows = await dbAll<any>(
            `SELECT symbol, iep, prev_close, iep_gap_pct, preopen_imbalance
             FROM preopen_stock_snapshot
             WHERE snapshot_date = ? AND iep_gap_pct IS NOT NULL
             ORDER BY iep_gap_pct DESC`,
            [asOfDate]
          );
          const shape = (r: any) => ({
            symbol: r.symbol,
            iep: Number(r.iep),
            prevClose: Number(r.prev_close),
            iepGapPct: Number(r.iep_gap_pct),
            imbalance: r.preopen_imbalance != null ? Number(r.preopen_imbalance) : null,
          });
          return {
            asOfDate,
            gapUp: rows.slice(0, input.limit).map(shape),
            gapDown: rows.slice(-input.limit).reverse().map(shape),
          };
        } catch (e: any) {
          console.error("[Macro Router] Error fetching pre-market movers:", e);
          return { asOfDate: null, gapUp: [], gapDown: [] };
        }
      }, 300);
    }),

  getEcoCalendar: publicProcedure
    .input(z.object({
      daysBack: z.number().min(0).max(30).optional().default(2),
      daysForward: z.number().min(0).max(30).optional().default(7),
      minImpact: z.number().min(1).max(3).optional().default(2),
    }))
    .query(async ({ input }) => {
      try {
        const rows = await dbAll<any>(
          `SELECT event_date, event_time, country_name, event_name, category, impact, actual, previous, consensus
           FROM eco_calendar
           WHERE event_date >= (CURRENT_DATE - (? || ' days')::interval)::text
             AND event_date <= (CURRENT_DATE + (? || ' days')::interval)::text
             AND impact >= ?
           ORDER BY event_date ASC, impact DESC`,
          [input.daysBack, input.daysForward, input.minImpact]
        );
        return rows || [];
      } catch (e: any) {
        console.error("[Macro Router] Error fetching eco calendar:", e);
        return [];
      }
    }),
});
