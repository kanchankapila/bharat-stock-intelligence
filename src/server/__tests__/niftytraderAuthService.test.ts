import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// Real token captured live during this session (2026-08-06) -- a genuine NiftyTrader JWT,
// used here purely as a fixture to prove decodeJwtExpiryMs reads a real token's `exp` claim
// correctly. Its own decoded exp (1787207854 = 2026-08-20T06:37:34Z) is asserted below rather
// than hardcoded blind, so this test documents its own derivation.
const REAL_JWT_FIXTURE =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.' +
  'eyJodHRwOi8vc2NoZW1hcy54bWxzb2FwLm9yZy93cy8yMDA1LzA1L2lkZW50aXR5L2NsYWltcy9uYW1laWRlbnRpZmllciI6IjU0MzM4IiwiaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS93cy8yMDA4LzA2L2lkZW50aXR5L2NsYWltcy9yb2xlIjoiMCIsIlNlc3Npb25JZCI6IjUzOTkiLCJleHAiOjE3ODcyMDc4NTQsImlzcyI6InByb2QtbmlmdHl0cmFkZXIuaW4iLCJhdWQiOiJwcm9kLW5pZnR5dHJhZGVyLmluIn0.' +
  '7wZff73yxry1sfgqX0P9D8XGgypVsnmi4KSMM-fXd6g';

vi.mock('../dbAsync', () => ({
  dbGet: vi.fn(),
  dbRun: vi.fn().mockResolvedValue({ changes: 1 }),
}));
vi.mock('../niftytraderService', () => ({
  invalidateNiftyTraderToken: vi.fn(),
}));

const { decodeJwtExpiryMs, extractToken, ensureNiftyTraderToken } = await import('../niftytraderAuthService');
const { dbGet, dbRun } = await import('../dbAsync');

describe('decodeJwtExpiryMs', () => {
  it('decodes a real captured NiftyTrader JWT exp claim correctly', () => {
    const expMs = decodeJwtExpiryMs(REAL_JWT_FIXTURE);
    expect(expMs).toBe(1787207854 * 1000);
    expect(new Date(expMs!).toISOString()).toBe('2026-08-20T06:37:34.000Z');
  });

  it('returns null for a malformed token instead of throwing', () => {
    expect(decodeJwtExpiryMs('not-a-jwt')).toBeNull();
    expect(decodeJwtExpiryMs('')).toBeNull();
    expect(decodeJwtExpiryMs('a.b')).toBeNull(); // only 2 segments
  });

  it('returns null when the payload has no exp claim', () => {
    const noExpPayload = Buffer.from(JSON.stringify({ foo: 'bar' })).toString('base64url');
    expect(decodeJwtExpiryMs(`header.${noExpPayload}.sig`)).toBeNull();
  });
});

describe('extractToken', () => {
  it('finds a JWT-shaped string at resultData directly', () => {
    expect(extractToken({ resultData: REAL_JWT_FIXTURE })).toBe(REAL_JWT_FIXTURE);
  });

  it('finds a JWT-shaped string at resultData.token', () => {
    expect(extractToken({ resultData: { token: REAL_JWT_FIXTURE } })).toBe(REAL_JWT_FIXTURE);
  });

  it('finds a JWT-shaped string at resultData.accessToken', () => {
    expect(extractToken({ resultData: { accessToken: REAL_JWT_FIXTURE } })).toBe(REAL_JWT_FIXTURE);
  });

  it('does not mistake a plain non-JWT string field for the token', () => {
    expect(extractToken({ resultData: { userName: 'Amit Kapila', token: 'not-a-real-jwt' } })).toBeNull();
  });

  it('returns null for a response with no plausible token field at all', () => {
    expect(extractToken({ result: 1, resultMessage: 'Success', resultData: { foo: 'bar' } })).toBeNull();
  });

  it('returns null for null/undefined input rather than throwing', () => {
    expect(extractToken(null)).toBeNull();
    expect(extractToken(undefined)).toBeNull();
    expect(extractToken({})).toBeNull();
  });
});

describe('ensureNiftyTraderToken', () => {
  const originalEmail = process.env.NIFTYTRADER_EMAIL;
  const originalPassword = process.env.NIFTYTRADER_PASSWORD;
  const originalFetch = global.fetch;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  afterEach(() => {
    process.env.NIFTYTRADER_EMAIL = originalEmail;
    process.env.NIFTYTRADER_PASSWORD = originalPassword;
    global.fetch = originalFetch;
  });

  it('returns true without refreshing when the stored token has plenty of life left', async () => {
    // exp far in the future relative to "now" -- encode a fresh-looking JWT.
    const farFutureExp = Math.floor(Date.now() / 1000) + 30 * 24 * 60 * 60; // 30 days out
    const payload = Buffer.from(JSON.stringify({ exp: farFutureExp })).toString('base64url');
    const freshToken = `h.${payload}.s`;
    (dbGet as any).mockResolvedValueOnce({ value: freshToken });
    const fetchSpy = vi.fn();
    global.fetch = fetchSpy as any;

    const result = await ensureNiftyTraderToken();
    expect(result).toBe(true);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it('falls back gracefully (no throw) when no credentials are configured and no token exists', async () => {
    delete process.env.NIFTYTRADER_EMAIL;
    delete process.env.NIFTYTRADER_PASSWORD;
    (dbGet as any).mockResolvedValueOnce({ value: '' });

    const result = await ensureNiftyTraderToken();
    expect(result).toBe(false);
    expect(dbRun).not.toHaveBeenCalled();
  });
});
