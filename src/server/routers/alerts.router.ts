import { z } from "zod";
import { dbAll, dbRun } from "../dbAsync";
import { router, publicProcedure } from "../trpc";

export const alertsRouter = router({
  getMyPriceAlerts: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      return dbAll<any>(
        `SELECT id, symbol, condition, "thresholdPrice", status, "createdAt", "triggeredAt", "triggeredPrice"
         FROM price_alerts WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 100`,
        [input.userId]
      );
    }),

  createPriceAlert: publicProcedure
    .input(z.object({
      userId: z.string(),
      symbol: z.string(),
      condition: z.enum(["ABOVE", "BELOW"]),
      thresholdPrice: z.number().positive(),
    }))
    .mutation(async ({ input }) => {
      await dbRun(
        `INSERT INTO price_alerts ("userId", symbol, condition, "thresholdPrice", status)
         VALUES (?, ?, ?, ?, 'ACTIVE')`,
        [input.userId, input.symbol.toUpperCase(), input.condition, input.thresholdPrice]
      );
      return { success: true };
    }),

  cancelPriceAlert: publicProcedure
    .input(z.object({ id: z.number(), userId: z.string() }))
    .mutation(async ({ input }) => {
      await dbRun(
        `UPDATE price_alerts SET status = 'CANCELLED' WHERE id = ? AND "userId" = ? AND status = 'ACTIVE'`,
        [input.id, input.userId]
      );
      return { success: true };
    }),
});
