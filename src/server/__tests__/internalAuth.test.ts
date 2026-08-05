import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import type { Request } from "express";
import {
  isLoopbackRequest,
  isAuthorizedInternalCaller,
  isAuthorizedUser,
  isAuthorizedInternalOrUser,
  makeRateLimiter,
} from "../internalAuth";

vi.mock("../firebaseAdmin", () => ({
  verifyIdToken: vi.fn(async (header: string | undefined) => {
    if (header === "Bearer valid-token") return "uid-123";
    throw new Error("invalid token");
  }),
  AuthTokenError: class AuthTokenError extends Error {},
}));

function makeReq(opts: { remoteAddress?: string; headers?: Record<string, string> } = {}): Request {
  return {
    socket: { remoteAddress: opts.remoteAddress ?? "1.2.3.4" },
    headers: opts.headers ?? {},
  } as unknown as Request;
}

describe("internalAuth", () => {
  const ORIGINAL_SECRET = process.env.INTERNAL_API_SECRET;
  afterEach(() => {
    if (ORIGINAL_SECRET === undefined) delete process.env.INTERNAL_API_SECRET;
    else process.env.INTERNAL_API_SECRET = ORIGINAL_SECRET;
  });

  describe("isLoopbackRequest", () => {
    it("is true for IPv4 loopback", () => {
      expect(isLoopbackRequest(makeReq({ remoteAddress: "127.0.0.1" }))).toBe(true);
    });
    it("is true for IPv6 loopback", () => {
      expect(isLoopbackRequest(makeReq({ remoteAddress: "::1" }))).toBe(true);
    });
    it("is true for IPv4-mapped IPv6 loopback", () => {
      expect(isLoopbackRequest(makeReq({ remoteAddress: "::ffff:127.0.0.1" }))).toBe(true);
    });
    it("is false for a real remote address", () => {
      expect(isLoopbackRequest(makeReq({ remoteAddress: "203.0.113.5" }))).toBe(false);
    });
    it("does NOT trust a spoofable X-Forwarded-For header — only the raw socket peer counts", () => {
      const req = makeReq({
        remoteAddress: "203.0.113.5",
        headers: { "x-forwarded-for": "127.0.0.1" },
      });
      expect(isLoopbackRequest(req)).toBe(false);
    });
  });

  describe("isAuthorizedInternalCaller", () => {
    it("rejects a non-loopback caller even with no secret configured", () => {
      delete process.env.INTERNAL_API_SECRET;
      expect(isAuthorizedInternalCaller(makeReq({ remoteAddress: "203.0.113.5" }))).toBe(false);
    });
    it("allows a loopback caller when no secret is configured (today's Python callers)", () => {
      delete process.env.INTERNAL_API_SECRET;
      expect(isAuthorizedInternalCaller(makeReq({ remoteAddress: "127.0.0.1" }))).toBe(true);
    });
    it("requires the secret header too once INTERNAL_API_SECRET is set", () => {
      process.env.INTERNAL_API_SECRET = "s3cr3t";
      expect(isAuthorizedInternalCaller(makeReq({ remoteAddress: "127.0.0.1" }))).toBe(false);
      expect(
        isAuthorizedInternalCaller(
          makeReq({ remoteAddress: "127.0.0.1", headers: { "x-internal-secret": "s3cr3t" } })
        )
      ).toBe(true);
    });
    it("rejects a loopback caller with the wrong secret", () => {
      process.env.INTERNAL_API_SECRET = "s3cr3t";
      expect(
        isAuthorizedInternalCaller(
          makeReq({ remoteAddress: "127.0.0.1", headers: { "x-internal-secret": "wrong" } })
        )
      ).toBe(false);
    });
    it("a non-loopback caller is rejected even with the correct secret", () => {
      process.env.INTERNAL_API_SECRET = "s3cr3t";
      expect(
        isAuthorizedInternalCaller(
          makeReq({ remoteAddress: "203.0.113.5", headers: { "x-internal-secret": "s3cr3t" } })
        )
      ).toBe(false);
    });
  });

  describe("isAuthorizedUser", () => {
    it("accepts a valid bearer token", async () => {
      const req = makeReq({ headers: { authorization: "Bearer valid-token" } });
      expect(await isAuthorizedUser(req)).toBe(true);
    });
    it("rejects a missing or invalid token", async () => {
      expect(await isAuthorizedUser(makeReq())).toBe(false);
      expect(
        await isAuthorizedUser(makeReq({ headers: { authorization: "Bearer garbage" } }))
      ).toBe(false);
    });
  });

  describe("isAuthorizedInternalOrUser", () => {
    it("allows a loopback caller with no token (the CLI script case)", async () => {
      expect(await isAuthorizedInternalOrUser(makeReq({ remoteAddress: "127.0.0.1" }))).toBe(true);
    });
    it("allows a non-loopback caller with a valid Firebase token (the browser case)", async () => {
      const req = makeReq({
        remoteAddress: "203.0.113.5",
        headers: { authorization: "Bearer valid-token" },
      });
      expect(await isAuthorizedInternalOrUser(req)).toBe(true);
    });
    it("rejects a non-loopback caller with no token — the exact gap this closes", async () => {
      expect(await isAuthorizedInternalOrUser(makeReq({ remoteAddress: "203.0.113.5" }))).toBe(false);
    });
  });

  describe("makeRateLimiter", () => {
    it("allows up to max requests per window, then blocks", () => {
      const limited = makeRateLimiter({ windowMs: 60_000, max: 3 });
      const req = makeReq({ remoteAddress: "9.9.9.9" });
      expect(limited(req)).toBe(false);
      expect(limited(req)).toBe(false);
      expect(limited(req)).toBe(false);
      expect(limited(req)).toBe(true);
    });
    it("tracks separate IPs independently", () => {
      const limited = makeRateLimiter({ windowMs: 60_000, max: 1 });
      expect(limited(makeReq({ remoteAddress: "1.1.1.1" }))).toBe(false);
      expect(limited(makeReq({ remoteAddress: "2.2.2.2" }))).toBe(false);
      expect(limited(makeReq({ remoteAddress: "1.1.1.1" }))).toBe(true);
    });
    it("resets after the window elapses", () => {
      vi.useFakeTimers();
      try {
        const limited = makeRateLimiter({ windowMs: 1000, max: 1 });
        const req = makeReq({ remoteAddress: "5.5.5.5" });
        expect(limited(req)).toBe(false);
        expect(limited(req)).toBe(true);
        vi.advanceTimersByTime(1001);
        expect(limited(req)).toBe(false);
      } finally {
        vi.useRealTimers();
      }
    });
  });
});
