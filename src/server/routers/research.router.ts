import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure, adminProcedure } from '../trpc';
import { researchPremarketQueue, researchPostcloseQueue } from '../queues';

export const researchRouter = router({

  getDailyResearch: publicProcedure
    .input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']).optional(),
    }).optional())
    .query(async ({ input }) => {
      const date = input?.date;
      const type = input?.type;
      const COLS = `id, report_date, report_type, status, generated_at,
                    market_regime, sentiment_score, fii_net_5d,
                    top_picks_json, report_json, ai_blurbs_json, error_message`;

      if (date && type) {
        return (await dbGet<any>(
          `SELECT ${COLS} FROM daily_research_reports WHERE report_date = ? AND report_type = ?`,
          [date, type])) ?? null;
      }

      const today = new Date().toISOString().split('T')[0];
      const candidates = [
        await dbGet<any>(`SELECT ${COLS} FROM daily_research_reports
          WHERE report_date = ? AND report_type = 'POST_CLOSE' AND status = 'READY'`, [today]),
        await dbGet<any>(`SELECT ${COLS} FROM daily_research_reports
          WHERE report_date = ? AND report_type = 'PRE_MARKET' AND status = 'READY'`, [today]),
        await dbGet<any>(`SELECT ${COLS} FROM daily_research_reports
          WHERE status = 'READY' ORDER BY generated_at DESC LIMIT 1`),
      ];

      return candidates.find(Boolean) ?? null;
    }),

  getDailyResearchHistory: publicProcedure
    .input(z.object({ limit: z.number().min(1).max(14).default(7) }).optional())
    .query(async ({ input }) => {
      return dbAll(`
        SELECT id, report_date, report_type, status, generated_at,
               market_regime, sentiment_score, fii_net_5d, error_message
        FROM daily_research_reports
        ORDER BY generated_at DESC
        LIMIT ?
      `, [input?.limit ?? 7]);
    }),

  getResearchStatus: publicProcedure
    .input(z.object({
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']).optional(),
    }).optional())
    .query(async ({ input }) => {
      const today = new Date().toISOString().split('T')[0];
      const date  = input?.date ?? today;
      const type  = input?.type ?? 'POST_CLOSE';
      return (await dbGet<any>(`
        SELECT status, generated_at, error_message
        FROM daily_research_reports
        WHERE report_date = ? AND report_type = ?
      `, [date, type])) ?? { status: 'PENDING', generated_at: null, error_message: null };
    }),

  triggerResearchGeneration: adminProcedure
    .input(z.object({
      date: z.string(),
      type: z.enum(['PRE_MARKET', 'POST_CLOSE']),
    }))
    .mutation(async ({ input }) => {
      const queue = input.type === 'PRE_MARKET'
        ? researchPremarketQueue
        : researchPostcloseQueue;

      if (!queue) {
        const { generateDailyReport } = await import('../researchEngine');
        generateDailyReport(input.date, input.type).catch(console.error);
        return { queued: false, inline: true };
      }

      await queue.add('manual-trigger', { date: input.date, type: input.type }, {
        removeOnComplete: { age: 3600 },
        attempts: 1,
      });
      return { queued: true, inline: false };
    }),
});
