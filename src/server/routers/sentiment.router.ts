import { z } from "zod";
import { dbAll } from "../dbAsync";
import { router, publicProcedure } from "../trpc";

export const sentimentRouter = router({
  getMarketSentiment: publicProcedure
    .input(z.object({ historyHours: z.number().min(1).max(168).optional() }).optional())
    .query(async ({ input }) => {
      const { getLatestSentimentSnapshot, getSentimentHistory } = await import('../newsSentimentService');
      return {
        latest:  await getLatestSentimentSnapshot(),
        history: await getSentimentHistory(input?.historyHours ?? 24),
      };
    }),

  getNewsItems: publicProcedure
    .input(z.object({
      limit:      z.number().min(1).max(200).default(60),
      category:   z.enum(['ALL','EARNINGS','ORDER_WIN','BUYBACK','POLICY','IPO','GLOBAL','SECTOR','GENERAL']).default('ALL'),
      sentiment:  z.enum(['ALL','BULLISH','BEARISH','NEUTRAL']).default('ALL'),
      sourceType: z.enum(['ALL','INDIAN','GLOBAL']).default('ALL'),
      hours:      z.number().min(1).max(72).default(8),
    }).optional())
    .query(async ({ input }) => {
      const { getNewsItems } = await import('../newsSentimentService');
      return await getNewsItems(input ?? {});
    }),

  getSectorNewsSentiment: publicProcedure
    .query(async () => {
      const { getSectorSentiment } = await import('../newsSentimentService');
      return await getSectorSentiment();
    }),

  getCorporateEventNews: publicProcedure
    .query(async () => {
      const { getCorporateEventNews } = await import('../newsSentimentService');
      return await getCorporateEventNews();
    }),

  getInstitutionalFlows: publicProcedure
    .query(async () => {
      const rows = await dbAll<any>(
        `SELECT date, fii_buy, fii_sell, fii_net, dii_buy, dii_sell, dii_net
         FROM fii_dii_flow ORDER BY date DESC LIMIT 1`
      );

      const fmt = (n: number | null) => n != null ? Number(n).toFixed(2) : '0.00';

      if (rows.length) {
        const r = rows[0];
        const date = new Date(r.date).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' });
        return {
          success: 1,
          data: {
            institutionalDetails: [
              { category: 'FII/FPI', date, netBuySell: fmt(r.fii_net), buyValue: fmt(r.fii_buy), sellValue: fmt(r.fii_sell) },
              { category: 'DII',     date, netBuySell: fmt(r.dii_net), buyValue: fmt(r.dii_buy), sellValue: fmt(r.dii_sell) },
            ],
          },
        };
      }

      // DB empty — fetch live from NSE
      try {
        const res = await fetch('https://www.nseindia.com/api/fiidiiTradeReact', {
          signal: AbortSignal.timeout(8000),
          headers: { 'Accept': 'application/json', 'User-Agent': 'Mozilla/5.0' },
        });
        if (!res.ok) return null;
        const nseData = await res.json() as any[];
        if (!Array.isArray(nseData) || !nseData.length) return null;

        const details = nseData.map((row: any) => ({
          category:   row.category,
          date:       row.date,
          netBuySell: fmt(row.netBuySell ?? null),
          buyValue:   fmt(row.buyValue ?? null),
          sellValue:  fmt(row.sellValue ?? null),
        }));
        return { success: 1, data: { institutionalDetails: details } };
      } catch {
        return null;
      }
    }),

  refreshNewsSentiment: publicProcedure
    .mutation(async () => {
      const { newsSentimentQueue } = await import('../queues');
      if (newsSentimentQueue) {
        await newsSentimentQueue.add('news-sentiment-manual', {}, { removeOnComplete: 3 });
        return { queued: true };
      }
      const { runNewsSentimentCycle } = await import('../newsSentimentService');
      runNewsSentimentCycle().catch(console.error);
      return { queued: false };
    }),
});
