import { z } from "zod";
import db from "../db";
import { router, publicProcedure } from "../trpc";

export const userRouter = router({
  syncUser: publicProcedure
    .input(z.object({
      id: z.string(),
      email: z.string().nullable(),
      name: z.string().nullable(),
      photoURL: z.string().nullable(),
    }))
    .mutation(async ({ input }) => {
      db.prepare(`
        INSERT INTO users (id, email, name, photoURL)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(id) DO UPDATE SET
          email = excluded.email,
          name = excluded.name,
          photoURL = excluded.photoURL
      `).run(input.id, input.email, input.name, input.photoURL);
      return { success: true };
    }),

  getWatchlist: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(({ input }) => {
      const rows = db.prepare('SELECT symbol FROM watchlist WHERE userId = ? ORDER BY addedAt DESC')
        .all(input.userId) as { symbol: string }[];
      return rows.map(r => r.symbol);
    }),

  getWatchlistDetails: publicProcedure
    .input(z.object({ userId: z.string() }))
    .query(({ input }) => {
      return db.prepare('SELECT symbol, price, name, addedAt, source FROM watchlist WHERE userId = ? ORDER BY addedAt DESC')
        .all(input.userId) as { symbol: string; price?: number; name?: string; addedAt: string; source?: string }[];
    }),

  addToWatchlist: publicProcedure
    .input(z.object({
      userId: z.string(),
      symbol: z.string(),
      price: z.number().optional(),
      name: z.string().optional(),
      source: z.string().optional(),
    }))
    .mutation(({ input }) => {
      db.prepare(`
        INSERT INTO watchlist (userId, symbol, price, name, source)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(userId, symbol) DO UPDATE SET
          price = coalesce(excluded.price, price),
          name = coalesce(excluded.name, name),
          source = coalesce(excluded.source, source)
      `).run(input.userId, input.symbol, input.price ?? null, input.name ?? null, input.source ?? null);
      return { success: true };
    }),

  removeFromWatchlist: publicProcedure
    .input(z.object({ userId: z.string(), symbol: z.string() }))
    .mutation(({ input }) => {
      db.prepare('DELETE FROM watchlist WHERE userId = ? AND symbol = ?').run(input.userId, input.symbol);
      return { success: true };
    }),
});
