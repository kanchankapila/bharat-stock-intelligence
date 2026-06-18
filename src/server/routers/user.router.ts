import { z } from "zod";
import { dbAll, dbRun } from "../dbAsync";
import { router, publicProcedure } from "../trpc";

// camelCase columns (photoURL, userId, addedAt) are double-quoted so they resolve on both
// SQLite (current) and Postgres (post-cutover, which folds unquoted identifiers to lowercase).

export const userRouter = router({
  syncUser: publicProcedure
    .input(z.object({
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      photoURL: z.string().nullable(),
    }))
    .mutation(async ({ input }) => {
      await dbRun(`
        INSERT INTO users (id, email, name, "photoURL")
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          "photoURL" = excluded."photoURL"
      `, [input.id, input.email, input.name, input.photoURL]);
      return { success: true };
    }),

  getWatchlist: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      const rows = await dbAll<{ symbol: string }>(
        'SELECT symbol FROM watchlist WHERE "userId" = ? ORDER BY "addedAt" DESC',
        [input.userId],
      );
      return rows.map(r => r.symbol);
    }),

  getWatchlistDetails: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(async ({ input }) => {
      return dbAll<{ symbol: string; price?: number; name?: string; addedAt: string; source?: string }>(
        'SELECT symbol, price, name, "addedAt", source FROM watchlist WHERE "userId" = ? ORDER BY "addedAt" DESC',
        [input.userId],
      );
    }),

  addToWatchlist: publicProcedure
    .input(z.object({
      userId: z.string(),
      symbol: z.string(),
      price: z.number().optional(),
      name: z.string().optional(),
      source: z.string().optional(),
    }))
    .mutation(async ({ input }) => {
      await dbRun(`
        INSERT INTO watchlist ("userId", symbol, price, name, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT("userId", symbol) DO UPDATE SET
          price = coalesce(excluded.price, price),
          name = coalesce(excluded.name, name),
          source = coalesce(excluded.source, source)
      `, [input.userId, input.symbol, input.price ?? null, input.name ?? null, input.source ?? null]);
      return { success: true };
    }),

  removeFromWatchlist: publicProcedure
    .input(z.object({ userId: z.string(), symbol: z.string() }))
    .mutation(async ({ input }) => {
      await dbRun('DELETE FROM watchlist WHERE "userId" = ? AND symbol = ?', [input.userId, input.symbol]);
      return { success: true };
    }),
});
