import { z } from "zod";
import { router, publicProcedure } from "../trpc";

export const sentimentRouter = router({
  getMarketSentiment: publicProcedure
    .input(z.object({ historyHours: z.number().min(1).max(168).optional() }).optional())
    .query(async ({ input }) => {
      const { getLatestSentimentSnapshot, getSentimentHistory } = await import('../newsSentimentService');
      return {
        latest:  getLatestSentimentSnapshot(),
        history: getSentimentHistory(input?.historyHours ?? 24),
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
      return getNewsItems(input ?? {});
    }),

  getSectorNewsSentiment: publicProcedure
    .query(async () => {
      const { getSectorSentiment } = await import('../newsSentimentService');
      return getSectorSentiment();
    }),

  getCorporateEventNews: publicProcedure
    .query(async () => {
      const { getCorporateEventNews } = await import('../newsSentimentService');
      return getCorporateEventNews();
    }),

  getInstitutionalFlows: publicProcedure
    .query(() => ({
      success: 1,
      data: {
        institutionalDetails: [
          { category: 'FII/FPI', date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), netBuySell: '1243.80', buyValue: '11450.20', sellValue: '10206.40' },
          { category: 'DII',     date: new Date().toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }), netBuySell: '879.40',  buyValue: '9860.50',  sellValue: '8981.10' },
        ],
      },
    })),

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
