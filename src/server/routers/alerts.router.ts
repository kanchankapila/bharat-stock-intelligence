import { z } from "zod";
import { dbAll, dbRun } from "../dbAsync";
import { router, protectedProcedure } from "../trpc";

// userId is derived from the verified Firebase ID token (ctx.uid), never accepted from the
// client, so one user can never read/cancel/create alerts against another user's account.
export const alertsRouter = router({
  getMyPriceAlerts: protectedProcedure
    .query(async ({ ctx }) => {
      return dbAll<any>(
        `SELECT id, symbol, condition, "thresholdPrice", status, "createdAt", "triggeredAt", "triggeredPrice"
         FROM price_alerts WHERE "userId" = ? ORDER BY "createdAt" DESC LIMIT 100`,
        [ctx.uid]
      );
    }),

  createPriceAlert: protectedProcedure
    .input(z.object({
      symbol: z.string(),
      condition: z.enum(["ABOVE", "BELOW"]),
      thresholdPrice: z.number().positive(),
    }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(
        `INSERT INTO price_alerts ("userId", symbol, condition, "thresholdPrice", status)
         VALUES (?, ?, ?, ?, 'ACTIVE')`,
        [ctx.uid, input.symbol.toUpperCase(), input.condition, input.thresholdPrice]
      );
      return { success: true };
    }),

  cancelPriceAlert: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(
        `UPDATE price_alerts SET status = 'CANCELLED' WHERE id = ? AND "userId" = ? AND status = 'ACTIVE'`,
        [input.id, ctx.uid]
      );
      return { success: true };
    }),
});
