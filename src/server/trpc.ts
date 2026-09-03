import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context";
import { verifyIdToken, AuthTokenError } from "./firebaseAdmin";
import { makeRateLimiter } from "./internalAuth";

const t = initTRPC.context<Context>().create({
  transformer: superjson,
});

export const router = t.router;
export const publicProcedure = t.procedure;
export const mergeRouters = t.mergeRouters;
export const createCallerFactory = t.createCallerFactory;

// Verifies the caller's Firebase ID token and injects ctx.uid. Use for any procedure that
// reads/writes data scoped to a specific user, or mutates global app settings/credentials.
export const protectedProcedure = t.procedure.use(async ({ ctx, next }) => {
  try {
    const uid = await verifyIdToken(ctx.req?.headers?.authorization);
    return next({ ctx: { ...ctx, uid } });
  } catch (err) {
    if (err instanceof AuthTokenError) {
      throw new TRPCError({ code: "UNAUTHORIZED", message: err.message });
    }
    throw err;
  }
});

// ADMIN_UIDS: comma-separated Firebase uids allowed to touch global app settings
// (Telegram/broker credentials, weight overrides). Set in .env; unset = nobody passes.
const ADMIN_UIDS = new Set((process.env.ADMIN_UIDS ?? "").split(",").map((s) => s.trim()).filter(Boolean));

export const adminProcedure = protectedProcedure.use(async ({ ctx, next }) => {
  if (!ADMIN_UIDS.has(ctx.uid)) {
    throw new TRPCError({ code: "FORBIDDEN", message: "Admin access required" });
  }
  return next({ ctx });
});

// Per-IP rate limit for the handful of PUBLIC mutations that each cost real money or real
// compute on the way through: an LLM call (getAIAnalysis, analyzePortfolio), a BullMQ AI-queue
// enqueue (enqueueSignals), a Python subprocess / full scoring pass (runBacktest, runScreener),
// or an unauthenticated write (saveBacktestStrategy).
//
// Rate limit rather than protectedProcedure DELIBERATELY: every one of these has a real
// logged-out caller in the current UI (V1StockDetails, V1Backtest, v2 ScreenerPage,
// ScreenerIntelligencePage, DashboardPage, V3Dashboard), and this app is usable without signing
// in -- gating them on auth would break working pages to close a cost vector that a limiter
// closes without touching behaviour for any legitimate user. server.ts:307 already reasons this
// way for its raw routes, but its stated premise ("tRPC procedures ... already sit behind
// protectedProcedure/adminProcedure") does not hold: 278 of 376 procedures are publicProcedure
// (278 public / 55 admin / 34 protected / 9 expensive — census 2026-09-03).
//
// 20/min/IP is far above any human interaction rate on these screens (each is a button press)
// and far below what makes an LLM bill or a queue flood interesting to an abuser.
const expensiveLimiter = makeRateLimiter({ windowMs: 60_000, max: 20 });

export const expensiveProcedure = t.procedure.use(async ({ ctx, next }) => {
  if (ctx.req && expensiveLimiter(ctx.req)) {
    throw new TRPCError({
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests — please wait a minute and try again.",
    });
  }
  return next({ ctx });
});
