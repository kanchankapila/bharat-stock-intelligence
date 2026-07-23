import { initTRPC, TRPCError } from "@trpc/server";
import superjson from "superjson";
import type { Context } from "./context";
import { verifyIdToken, AuthTokenError } from "./firebaseAdmin";

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
