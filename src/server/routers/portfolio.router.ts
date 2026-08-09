import { z } from "zod";
import { TRPCError } from "@trpc/server";
import { dbAll, dbRun } from "../dbAsync";
import { router, protectedProcedure } from "../trpc";
import { fetchStockDataWithCache } from "../liveStockData";

// Real portfolio tracking (buy/sell price, buy/sell date, per-lot quantity) -- distinct from
// PortfolioDeskPage.tsx's equal-weight scenario sandbox, which never persists anything.
// userId is always ctx.uid (verified Firebase token), never client-supplied, so one user can
// never read/write another user's holdings -- same IDOR-prevention convention as
// user.router.ts's watchlist procedures and alerts.router.ts's price alerts.

const HOLDING_COLUMNS = `
  id, "userId", symbol, quantity, "buyPrice", "buyDate", "sellPrice", "sellDate", notes,
  "createdAt", "updatedAt"
`;

interface HoldingRow {
  id: number;
  symbol: string;
  quantity: number;
  buyPrice: number;
  buyDate: string;
  sellPrice: number | null;
  sellDate: string | null;
  notes: string | null;
  createdAt: string;
  updatedAt: string;
}

/**
 * Splits a lot when a sell covers less than the full quantity: the original row is closed at
 * the sold quantity (buy/sell price+date all preserved for that slice), and a new open row is
 * inserted for the remainder at the same original buy price/date. A full-quantity sell (the
 * common case) just closes the existing row in place -- no split, no new row.
 */
async function closeLot(
  userId: string,
  id: number,
  sellPrice: number,
  sellDate: string,
  sellQuantity: number | undefined,
): Promise<void> {
  const lot = await dbAll<HoldingRow>(
    `SELECT ${HOLDING_COLUMNS} FROM portfolio_holdings WHERE id = ? AND "userId" = ?`,
    [id, userId],
  );
  if (lot.length === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
  const row = lot[0];
  if (row.sellDate) throw new TRPCError({ code: "BAD_REQUEST", message: "This lot is already closed" });

  const qty = sellQuantity ?? row.quantity;
  if (qty <= 0 || qty > row.quantity) {
    throw new TRPCError({ code: "BAD_REQUEST", message: `Sell quantity must be between 0 and ${row.quantity}` });
  }

  if (qty === row.quantity) {
    await dbRun(
      `UPDATE portfolio_holdings SET "sellPrice" = ?, "sellDate" = ?, "updatedAt" = CURRENT_TIMESTAMP
       WHERE id = ? AND "userId" = ?`,
      [sellPrice, sellDate, id, userId],
    );
    return;
  }

  // Partial sell: shrink the original (still-open) row to the remainder, insert a new closed
  // row for the sold slice. Order matters for the remainder-shrink to be safe under concurrent
  // calls -- not transaction-wrapped here since dbRun/dbAll route through two different engines
  // (better-sqlite3 sync vs pg async) with no shared cross-call transaction primitive exposed
  // by dbAsync.ts; acceptable for a single-user personal-portfolio feature at this scale.
  await dbRun(
    `UPDATE portfolio_holdings SET quantity = ?, "updatedAt" = CURRENT_TIMESTAMP WHERE id = ? AND "userId" = ?`,
    [row.quantity - qty, id, userId],
  );
  await dbRun(
    `INSERT INTO portfolio_holdings ("userId", symbol, quantity, "buyPrice", "buyDate", "sellPrice", "sellDate", notes)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    [userId, row.symbol, qty, row.buyPrice, row.buyDate, sellPrice, sellDate, row.notes],
  );
}

export const portfolioRouter = router({
  // ── Stocks ──────────────────────────────────────────────────────────────

  getPortfolioHoldings: protectedProcedure
    .query(async ({ ctx }) => {
      return dbAll<HoldingRow>(
        `SELECT ${HOLDING_COLUMNS} FROM portfolio_holdings WHERE "userId" = ? ORDER BY "buyDate" DESC, id DESC`,
        [ctx.uid],
      );
    }),

  addPortfolioHolding: protectedProcedure
    .input(z.object({
      symbol: z.string().min(1).max(30),
      quantity: z.number().positive(),
      buyPrice: z.number().positive(),
      buyDate: z.string().min(1),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(
        `INSERT INTO portfolio_holdings ("userId", symbol, quantity, "buyPrice", "buyDate", notes)
         VALUES (?, ?, ?, ?, ?, ?)`,
        [ctx.uid, input.symbol.toUpperCase(), input.quantity, input.buyPrice, input.buyDate, input.notes ?? null],
      );
      return { success: true };
    }),

  updatePortfolioHolding: protectedProcedure
    .input(z.object({
      id: z.number(),
      quantity: z.number().positive().optional(),
      buyPrice: z.number().positive().optional(),
      buyDate: z.string().min(1).optional(),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.quantity !== undefined) { sets.push('quantity = ?'); params.push(fields.quantity); }
      if (fields.buyPrice !== undefined) { sets.push('"buyPrice" = ?'); params.push(fields.buyPrice); }
      if (fields.buyDate !== undefined)  { sets.push('"buyDate" = ?');  params.push(fields.buyDate); }
      if (fields.notes !== undefined)    { sets.push('notes = ?');      params.push(fields.notes); }
      if (sets.length === 0) return { success: true };
      sets.push('"updatedAt" = CURRENT_TIMESTAMP');
      const result = await dbRun(
        `UPDATE portfolio_holdings SET ${sets.join(', ')} WHERE id = ? AND "userId" = ?`,
        [...params, id, ctx.uid],
      );
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  closePortfolioHolding: protectedProcedure
    .input(z.object({
      id: z.number(),
      sellPrice: z.number().positive(),
      sellDate: z.string().min(1),
      quantity: z.number().positive().optional(), // omit to close the full lot
    }))
    .mutation(async ({ input, ctx }) => {
      await closeLot(ctx.uid, input.id, input.sellPrice, input.sellDate, input.quantity);
      return { success: true };
    }),

  reopenPortfolioHolding: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await dbRun(
        `UPDATE portfolio_holdings SET "sellPrice" = NULL, "sellDate" = NULL, "updatedAt" = CURRENT_TIMESTAMP
         WHERE id = ? AND "userId" = ?`,
        [input.id, ctx.uid],
      );
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  deletePortfolioHolding: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await dbRun(`DELETE FROM portfolio_holdings WHERE id = ? AND "userId" = ?`, [input.id, ctx.uid]);
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  // One call renders the whole Portfolio Desk: holdings joined with live quotes (reusing the
  // same fetchStockDataWithCache getLiveQuotesBatch already calls, so this doesn't add a second
  // network-fetch path) plus every aggregate the UI needs, computed once server-side.
  getPortfolioInsights: protectedProcedure
    .query(async ({ ctx }) => {
      const holdings = await dbAll<HoldingRow>(
        `SELECT ${HOLDING_COLUMNS} FROM portfolio_holdings WHERE "userId" = ? ORDER BY "buyDate" DESC, id DESC`,
        [ctx.uid],
      );
      const symbols = Array.from(new Set(holdings.map((h) => h.symbol)));
      const quotes = await Promise.all(symbols.map((s) => fetchStockDataWithCache(s).catch(() => null)));
      const quoteBySymbol = new Map(symbols.map((s, i) => [s, quotes[i]]));

      let totalInvestedOpen = 0;
      let totalCurrentValue = 0;
      let realizedPnl = 0;
      let realizedInvested = 0;
      const sectorValue = new Map<string, number>();
      const enriched = holdings.map((h) => {
        const quote = quoteBySymbol.get(h.symbol);
        const currentPrice = quote?.price ?? null;
        const invested = h.quantity * h.buyPrice;
        const isOpen = !h.sellDate;
        let currentValue: number | null = null;
        let pnl: number | null = null;
        let pnlPct: number | null = null;
        if (isOpen) {
          totalInvestedOpen += invested;
          if (currentPrice != null) {
            currentValue = h.quantity * currentPrice;
            totalCurrentValue += currentValue;
            pnl = currentValue - invested;
            pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
            const sector = quote?.sector ?? 'Unknown';
            sectorValue.set(sector, (sectorValue.get(sector) ?? 0) + currentValue);
          }
        } else {
          const proceeds = h.quantity * (h.sellPrice ?? 0);
          currentValue = proceeds;
          pnl = proceeds - invested;
          pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
          realizedPnl += pnl;
          realizedInvested += invested;
        }
        return {
          ...h,
          currentPrice,
          currentValue,
          pnl,
          pnlPct,
          sector: quote?.sector ?? null,
          name: quote?.name ?? h.symbol,
        };
      });

      const openHoldings = enriched.filter((h) => !h.sellDate);
      const closedHoldings = enriched.filter((h) => h.sellDate);
      const unrealizedPnl = totalCurrentValue - totalInvestedOpen;
      const unrealizedPnlPct = totalInvestedOpen > 0 ? (unrealizedPnl / totalInvestedOpen) * 100 : null;
      const realizedPnlPct = realizedInvested > 0 ? (realizedPnl / realizedInvested) * 100 : null;

      const bySector = Array.from(sectorValue.entries())
        .map(([sector, value]) => ({ sector, value, pct: totalCurrentValue > 0 ? (value / totalCurrentValue) * 100 : 0 }))
        .sort((a, b) => b.value - a.value);

      const ranked = openHoldings.filter((h) => h.pnlPct != null).sort((a, b) => (b.pnlPct ?? 0) - (a.pnlPct ?? 0));
      const bestPerformer = ranked[0] ?? null;
      const worstPerformer = ranked.length > 0 ? ranked[ranked.length - 1] : null;

      return {
        holdings: enriched,
        openHoldings,
        closedHoldings,
        totals: {
          investedOpen: totalInvestedOpen,
          currentValue: totalCurrentValue,
          unrealizedPnl,
          unrealizedPnlPct,
          realizedPnl,
          realizedPnlPct,
          openPositions: openHoldings.length,
          closedPositions: closedHoldings.length,
        },
        bySector,
        bestPerformer,
        worstPerformer,
      };
    }),

  // ── Mutual Funds ────────────────────────────────────────────────────────

  getMfHoldings: protectedProcedure
    .query(async ({ ctx }) => {
      return dbAll(
        `SELECT id, "userId", "schemeName", "folioNumber", category, units, "buyNav", "buyDate",
                "currentNav", "sellNav", "sellDate", notes, "createdAt", "updatedAt"
         FROM mf_portfolio_holdings WHERE "userId" = ? ORDER BY "buyDate" DESC, id DESC`,
        [ctx.uid],
      );
    }),

  addMfHolding: protectedProcedure
    .input(z.object({
      schemeName: z.string().min(1).max(200),
      folioNumber: z.string().max(50).optional(),
      category: z.string().max(50).optional(),
      units: z.number().positive(),
      buyNav: z.number().positive(),
      buyDate: z.string().min(1),
      currentNav: z.number().positive().optional(),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      await dbRun(
        `INSERT INTO mf_portfolio_holdings
           ("userId", "schemeName", "folioNumber", category, units, "buyNav", "buyDate", "currentNav", notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [ctx.uid, input.schemeName, input.folioNumber ?? null, input.category ?? null, input.units,
         input.buyNav, input.buyDate, input.currentNav ?? input.buyNav, input.notes ?? null],
      );
      return { success: true };
    }),

  updateMfHolding: protectedProcedure
    .input(z.object({
      id: z.number(),
      units: z.number().positive().optional(),
      buyNav: z.number().positive().optional(),
      buyDate: z.string().min(1).optional(),
      currentNav: z.number().positive().optional(),
      category: z.string().max(50).optional(),
      folioNumber: z.string().max(50).optional(),
      notes: z.string().max(500).optional(),
    }))
    .mutation(async ({ input, ctx }) => {
      const { id, ...fields } = input;
      const sets: string[] = [];
      const params: unknown[] = [];
      if (fields.units !== undefined)       { sets.push('units = ?');           params.push(fields.units); }
      if (fields.buyNav !== undefined)      { sets.push('"buyNav" = ?');        params.push(fields.buyNav); }
      if (fields.buyDate !== undefined)     { sets.push('"buyDate" = ?');       params.push(fields.buyDate); }
      if (fields.currentNav !== undefined)  { sets.push('"currentNav" = ?');    params.push(fields.currentNav); }
      if (fields.category !== undefined)    { sets.push('category = ?');       params.push(fields.category); }
      if (fields.folioNumber !== undefined) { sets.push('"folioNumber" = ?');  params.push(fields.folioNumber); }
      if (fields.notes !== undefined)       { sets.push('notes = ?');          params.push(fields.notes); }
      if (sets.length === 0) return { success: true };
      sets.push('"updatedAt" = CURRENT_TIMESTAMP');
      const result = await dbRun(
        `UPDATE mf_portfolio_holdings SET ${sets.join(', ')} WHERE id = ? AND "userId" = ?`,
        [...params, id, ctx.uid],
      );
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  closeMfHolding: protectedProcedure
    .input(z.object({ id: z.number(), sellNav: z.number().positive(), sellDate: z.string().min(1) }))
    .mutation(async ({ input, ctx }) => {
      const result = await dbRun(
        `UPDATE mf_portfolio_holdings SET "sellNav" = ?, "sellDate" = ?, "updatedAt" = CURRENT_TIMESTAMP
         WHERE id = ? AND "userId" = ? AND "sellDate" IS NULL`,
        [input.sellNav, input.sellDate, input.id, ctx.uid],
      );
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found or already closed" });
      return { success: true };
    }),

  reopenMfHolding: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await dbRun(
        `UPDATE mf_portfolio_holdings SET "sellNav" = NULL, "sellDate" = NULL, "updatedAt" = CURRENT_TIMESTAMP
         WHERE id = ? AND "userId" = ?`,
        [input.id, ctx.uid],
      );
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  deleteMfHolding: protectedProcedure
    .input(z.object({ id: z.number() }))
    .mutation(async ({ input, ctx }) => {
      const result = await dbRun(`DELETE FROM mf_portfolio_holdings WHERE id = ? AND "userId" = ?`, [input.id, ctx.uid]);
      if (result.changes === 0) throw new TRPCError({ code: "NOT_FOUND", message: "Holding not found" });
      return { success: true };
    }),

  getMfInsights: protectedProcedure
    .query(async ({ ctx }) => {
      const rows = await dbAll<{
        id: number; schemeName: string; folioNumber: string | null; category: string | null;
        units: number; buyNav: number; buyDate: string; currentNav: number | null;
        sellNav: number | null; sellDate: string | null; notes: string | null;
      }>(
        `SELECT id, "schemeName", "folioNumber", category, units, "buyNav", "buyDate",
                "currentNav", "sellNav", "sellDate", notes
         FROM mf_portfolio_holdings WHERE "userId" = ? ORDER BY "buyDate" DESC, id DESC`,
        [ctx.uid],
      );

      let investedOpen = 0;
      let currentValue = 0;
      let realizedPnl = 0;
      let realizedInvested = 0;
      const categoryValue = new Map<string, number>();

      const enriched = rows.map((r) => {
        const invested = r.units * r.buyNav;
        const isOpen = !r.sellDate;
        let value: number | null = null;
        let pnl: number | null = null;
        let pnlPct: number | null = null;
        if (isOpen) {
          investedOpen += invested;
          const nav = r.currentNav ?? r.buyNav;
          value = r.units * nav;
          currentValue += value;
          pnl = value - invested;
          pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
          const cat = r.category ?? 'Uncategorized';
          categoryValue.set(cat, (categoryValue.get(cat) ?? 0) + value);
        } else {
          const proceeds = r.units * (r.sellNav ?? 0);
          value = proceeds;
          pnl = proceeds - invested;
          pnlPct = invested > 0 ? (pnl / invested) * 100 : null;
          realizedPnl += pnl;
          realizedInvested += invested;
        }
        return { ...r, currentValue: value, pnl, pnlPct };
      });

      const openHoldings = enriched.filter((r) => !r.sellDate);
      const closedHoldings = enriched.filter((r) => r.sellDate);
      const unrealizedPnl = currentValue - investedOpen;

      return {
        holdings: enriched,
        openHoldings,
        closedHoldings,
        totals: {
          investedOpen,
          currentValue,
          unrealizedPnl,
          unrealizedPnlPct: investedOpen > 0 ? (unrealizedPnl / investedOpen) * 100 : null,
          realizedPnl,
          realizedPnlPct: realizedInvested > 0 ? (realizedPnl / realizedInvested) * 100 : null,
          openPositions: openHoldings.length,
          closedPositions: closedHoldings.length,
        },
        byCategory: Array.from(categoryValue.entries())
          .map(([category, value]) => ({ category, value, pct: currentValue > 0 ? (value / currentValue) * 100 : 0 }))
          .sort((a, b) => b.value - a.value),
      };
    }),
});
