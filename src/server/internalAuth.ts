import type { Request } from "express";
import { verifyIdToken } from "./firebaseAdmin";

// Shared guards for the handful of raw Express routes in server.ts that sit outside the tRPC
// router (and therefore outside protectedProcedure/adminProcedure). Added 2026-08-05 after an
// audit found /mcapi/*, /api/export-picks, and /api/internal/notify were all reachable by any
// unauthenticated internet caller — /mcapi/* is an open relay to MoneyControl, /api/export-picks
// spawns a backtest subprocess, and /api/internal/notify writes straight into the live SSE alert
// stream every connected browser is subscribed to.

const LOOPBACK_ADDRESSES = new Set(["127.0.0.1", "::1", "::ffff:127.0.0.1"]);

/**
 * True only for a connection whose actual TCP peer is loopback. Deliberately reads
 * req.socket.remoteAddress rather than req.ip/X-Forwarded-For — the latter is a client-supplied
 * header and trivially spoofable unless `trust proxy` is configured exactly right; the raw socket
 * peer address cannot be forged by the client.
 */
export function isLoopbackRequest(req: Request): boolean {
  const addr = req.socket?.remoteAddress ?? "";
  return LOOPBACK_ADDRESSES.has(addr);
}

/**
 * Same-host callers (the Python job runner, a local ops script) are implicitly trusted without a
 * token — that mirrors how these processes already reach the server today (localhost HTTP calls
 * with no auth header). If INTERNAL_API_SECRET is configured, a loopback caller must also present
 * it; if unset, loopback alone is sufficient (closes the "reachable from the internet" hole
 * without requiring every existing internal caller to be updated first).
 */
export function isAuthorizedInternalCaller(req: Request): boolean {
  if (!isLoopbackRequest(req)) return false;
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret) return true;
  return req.headers["x-internal-secret"] === secret;
}

/** A logged-in app user, verified the same way protectedProcedure verifies tRPC callers. */
export async function isAuthorizedUser(req: Request): Promise<boolean> {
  try {
    await verifyIdToken(req.headers.authorization as string | undefined);
    return true;
  } catch {
    return false;
  }
}

/**
 * For routes a real logged-in user legitimately calls from the browser (export-picks) or that
 * should just never be reachable anonymously from the internet (mcapi): allow either a same-host
 * caller (CLI script, local tooling) or a verified Firebase user.
 */
export async function isAuthorizedInternalOrUser(req: Request): Promise<boolean> {
  if (isLoopbackRequest(req)) return true;
  return isAuthorizedUser(req);
}

/**
 * Minimal in-memory sliding-window rate limiter, scoped to the handful of raw routes that need
 * one. Deliberately not a general Express middleware applied to every route — those are already
 * covered by tRPC auth, and a blanket limiter tuned blind (no way to load-test in this sandbox)
 * risks throttling legitimate batched tRPC/SSE traffic more than it protects anything.
 */
export function makeRateLimiter(opts: { windowMs: number; max: number }) {
  const hits = new Map<string, number[]>();
  return function rateLimited(req: Request): boolean {
    const key = req.socket?.remoteAddress ?? "unknown";
    const now = Date.now();
    const windowStart = now - opts.windowMs;
    const existing = (hits.get(key) ?? []).filter((t) => t > windowStart);
    if (existing.length >= opts.max) {
      hits.set(key, existing);
      return true;
    }
    existing.push(now);
    hits.set(key, existing);
    // Bound memory: forget IPs that haven't hit in a while.
    if (hits.size > 5000) {
      for (const [k, times] of hits) {
        if (times.every((t) => t <= windowStart)) hits.delete(k);
      }
    }
    return false;
  };
}
