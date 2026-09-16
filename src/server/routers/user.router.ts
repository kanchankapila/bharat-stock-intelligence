import { z } from "zod";
import { dbAll, dbRun } from "../dbAsync";
import { router, publicProcedure, protectedProcedure } from "../trpc";

// camelCase columns (photoURL, userId, addedAt) are double-quoted so they resolve on both
// SQLite (current) and Postgres (post-cutover, which folds unquoted identifiers to lowercase).

export const userRouter = router({
  // `id` is intentionally NOT accepted from the client — same rule as the watchlist
  // procedures below. It was a publicProcedure taking a client-supplied `id` until
  // 2026-08-22, so any unauthenticated caller could overwrite ANY user's email/name/photo
  // just by posting their uid. The only caller (App.tsx's handleLogin) already runs after
  // signInWithPopup and was passing its own result.user.uid, so ctx.uid is the same value.
  syncUser: protectedProcedure
    .input(z.object({
      email: z.string().nullable(),
      name: z.string().nullable(),
      photoURL: z.string().nullable(),
    }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(`
        INSERT INTO users (id, email, name, "photoURL")
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          "photoURL" = excluded."photoURL"
      `, [ctx.uid, input.email, input.name, input.photoURL]);
      return { success: true };
    }),

  // userId is intentionally NOT accepted from the client below — it's derived from the
  // verified Firebase ID token (ctx.uid), so one user can never read/write another's watchlist.
  getWatchlist: protectedProcedure
    .query(async ({ ctx }) => {
      const rows = await dbAll<{ symbol: string }>(
        'SELECT symbol FROM watchlist WHERE "userId" = ? ORDER BY "addedAt" DESC',
        [ctx.uid],
      );
      return rows.map(r => r.symbol);
    }),

  getWatchlistDetails: protectedProcedure
    .query(async ({ ctx }) => {
      return dbAll<{ symbol: string; price?: number; name?: string; addedAt: string; source?: string }>(
        'SELECT symbol, price, name, "addedAt", source FROM watchlist WHERE "userId" = ? ORDER BY "addedAt" DESC',
        [ctx.uid],
      );
    }),

  addToWatchlist: protectedProcedure
    .input(z.object({
      symbol: z.string(),
      price: z.number().optional(),
      name: z.string().optional(),
      source: z.string().optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(`
        INSERT INTO watchlist ("userId", symbol, price, name, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT("userId", symbol) DO UPDATE SET
          price = coalesce(excluded.price, price),
          name = coalesce(excluded.name, name),
          source = coalesce(excluded.source, source)
      `, [ctx.uid, input.symbol, input.price ?? null, input.name ?? null, input.source ?? null]);
      return { success: true };
    }),

  removeFromWatchlist: protectedProcedure
    .input(z.object({ symbol: z.string() }))
    .mutation(async ({ input, ctx }) => {
      await dbRun('DELETE FROM watchlist WHERE "userId" = ? AND symbol = ?', [ctx.uid, input.symbol]);
      return { success: true };
    }),
});
