/**
 * NiftyTrader auto-login / token-refresh service (2026-08-07).
 *
 * Before this, niftytraderService.ts's Bearer token in app_settings.niftytrader_auth_token
 * was ONLY ever set by a human manually capturing a token from their browser devtools and
 * pasting it via the admin-only saveNiftyTraderToken tRPC mutation -- no automated fetch
 * existed anywhere in the codebase (confirmed by grep before building this).
 *
 * The token itself is a real per-account JWT (decoded live 2026-08-07: carries a
 * `nameidentifier` user-id claim and a `SessionId`, not a guest/anonymous token), so an
 * automated refresh genuinely needs to log in as a real account -- there is no public/guest
 * token-issuance endpoint (probed live, 404 on the plausible candidates).
 *
 * Login endpoint reverse-engineered from NiftyTrader's own production JS bundles (Next.js,
 * live 2026-08-07 -- not guessed) and confirmed live end-to-end (dummy credentials -> a real
 * "incorrect credentials" JSON error, not a 404/shape error -- see the git history for this
 * file's verification trail): `POST https://onboarding.niftytrader.in/webapi/Account/login`
 * with body `{user_email, user_password, login_type: 1, social_flag: 0, platform_type: 1}`.
 * Two non-obvious findings along the way, worth keeping in mind for any future NiftyTrader
 * reverse-engineering: (1) auth lives on a DIFFERENT subdomain (onboarding.niftytrader.in)
 * than every market-data endpoint this codebase already uses (webapi.niftytrader.in) --
 * `https://webapi.niftytrader.in/webapi/Account/login` 404s even though it looks like the
 * natural extension of the existing convention. (2) the login FORM's field names (`email`/
 * `password`, visible in the page's own HTML/JS) do NOT match the actual API payload keys
 * (`user_email`/`user_password`) -- don't assume form field ids equal API field names for this
 * site.
 *
 * FULLY LIVE-VERIFIED 2026-08-07 with a real account (the same nameidentifier=54338 the
 * original manually-pasted token in this session's history carries, confirming it's genuinely
 * the same account): loginNiftyTrader() obtained a fresh JWT, ensureNiftyTraderToken() wrote
 * it to app_settings, and a real downstream call (Screener/live-market-filter-data) using
 * getNiftyTraderHeaders() succeeded end-to-end (HTTP 200, 50 real rows). extractToken()'s
 * defensive multi-candidate check still stays as-is (cheap insurance against NiftyTrader
 * changing their response shape later), but the primary path (resultData is the token string
 * directly) is now confirmed correct, not just plausible.
 *
 * Architecturally mirrors trendlyneAuthService.ts (this codebase's existing, working
 * store-credentials-in-.env + auto-relogin-on-expiry pattern) rather than inventing a new
 * design -- NIFTYTRADER_EMAIL/NIFTYTRADER_PASSWORD follow the same env-var convention as
 * TRENDLYNE_USERNAME/TRENDLYNE_PASSWORD. The one real difference: Trendlyne's session is an
 * in-memory cookie jar (ensureTrendlyneSession() re-derives it on every process start);
 * NiftyTrader's token is DB-persisted (app_settings), because niftytraderService.ts's
 * getNiftyTraderHeaders() already reads it that way and many independent call sites rely on
 * that -- refreshing here writes back through the exact same saveNiftyTraderToken path a
 * human would have used, so nothing downstream needs to change.
 */
import { dbGet, dbRun } from './dbAsync';

const LOGIN_URL = process.env.NIFTYTRADER_LOGIN_URL || 'https://onboarding.niftytrader.in/webapi/Account/login';
const EMAIL = process.env.NIFTYTRADER_EMAIL;
const PASSWORD = process.env.NIFTYTRADER_PASSWORD;
// Refresh proactively once the stored token has less than this much life left, not only once
// it has fully expired -- avoids a request failing mid-flight right at the expiry boundary.
const REFRESH_MARGIN_MS = Number(process.env.NIFTYTRADER_REFRESH_MARGIN_MS ?? 48 * 60 * 60 * 1000); // 48h
const MAX_LOGIN_ATTEMPTS = 2;

let refreshInFlight: Promise<boolean> | null = null;

const HEADERS = {
  'Content-Type': 'application/json',
  'Accept': 'application/json, text/plain, */*',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
  'Origin': 'https://www.niftytrader.in',
  'Referer': 'https://www.niftytrader.in/login',
};

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Decodes a JWT's payload without verifying the signature -- we only need to read `exp` from
 * a token this same service (or a human) already obtained from NiftyTrader itself; there is
 * nothing to verify against, we're just reading our own token's expiry. */
export function decodeJwtExpiryMs(token: string): number | null {
  try {
    const payloadB64 = token.split('.')[1];
    if (!payloadB64) return null;
    const padded = payloadB64.replace(/-/g, '+').replace(/_/g, '/').padEnd(payloadB64.length + (4 - (payloadB64.length % 4)) % 4, '=');
    const json = Buffer.from(padded, 'base64').toString('utf8');
    const payload = JSON.parse(json);
    if (typeof payload.exp !== 'number') return null;
    return payload.exp * 1000; // JWT exp is seconds since epoch
  } catch {
    return null;
  }
}

/** Digs a bearer-token-shaped string out of NiftyTrader's login response. The response envelope
 * shape ({result, resultMessage, resultData}) matches every other webapi.niftytrader.in
 * endpoint already used in this codebase, but the exact key holding the token inside
 * resultData was not confirmed against a real successful login (see module docstring) -- checks
 * the plausible candidates in order and returns null (with the raw shape logged by the caller)
 * if none match, rather than guessing wrong silently. */
export function extractToken(body: any): string | null {
  const candidates = [
    body?.resultData,
    body?.resultData?.token,
    body?.resultData?.accessToken,
    body?.resultData?.access_token,
    body?.resultData?.jwt,
    body?.resultData?.bearerToken,
    body?.token,
    body?.accessToken,
  ];
  for (const c of candidates) {
    if (typeof c === 'string' && c.split('.').length === 3) {
      // JWTs are always 3 dot-separated base64url segments -- a cheap, reliable "does this
      // actually look like a token" check that a plain string field (e.g. a user's name)
      // sitting in one of the plausible-but-wrong candidate slots would fail.
      return c;
    }
  }
  return null;
}

export async function loginNiftyTrader(): Promise<string | null> {
  if (!EMAIL || !PASSWORD) {
    console.warn('[NIFTYTRADER AUTH] Missing NIFTYTRADER_EMAIL or NIFTYTRADER_PASSWORD — cannot auto-refresh; falling back to whatever token is already stored (set via saveNiftyTraderToken, if any).');
    return null;
  }

  try {
    const res = await fetch(LOGIN_URL, {
      method: 'POST',
      headers: HEADERS,
      body: JSON.stringify({
        user_email: EMAIL,
        user_password: PASSWORD,
        login_type: 1,   // 1 = email/password; 2 = social login (Google/Facebook), unused here
        social_flag: 0,
        platform_type: 1, // matches getNiftyTraderHeaders()'s existing "platform_type": "1" (web)
      }),
      signal: AbortSignal.timeout(15000),
    });

    if (!res.ok) {
      console.warn(`[NIFTYTRADER AUTH] Login request failed with HTTP ${res.status}`);
      return null;
    }

    const body = await res.json().catch(() => null);
    if (!body) {
      console.warn('[NIFTYTRADER AUTH] Login response was not valid JSON');
      return null;
    }

    const token = extractToken(body);
    if (!token) {
      // Loud and specific on purpose: this is the exact failure mode the module docstring
      // warns is unverified until tested against a real account. Logging the top-level keys
      // (not values — avoids leaking a real token/PII into logs) makes a shape mismatch
      // immediately diagnosable instead of a silent no-op.
      console.error(
        '[NIFTYTRADER AUTH] Login succeeded (HTTP 200) but no JWT-shaped token was found in the ' +
        `response. Top-level keys: [${Object.keys(body).join(', ')}]` +
        (body.resultData && typeof body.resultData === 'object' ? `, resultData keys: [${Object.keys(body.resultData).join(', ')}]` : '') +
        '. Update extractToken() in niftytraderAuthService.ts once the real shape is known.'
      );
      return null;
    }

    console.log('[NIFTYTRADER AUTH] Logged in successfully, obtained a fresh token.');
    return token;
  } catch (e: any) {
    console.warn('[NIFTYTRADER AUTH] Login request threw:', e.message);
    return null;
  }
}

async function writeToken(token: string): Promise<void> {
  await dbRun(
    `INSERT INTO app_settings (key, value, "updatedAt") VALUES (?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, "updatedAt" = excluded."updatedAt"`,
    ['niftytrader_auth_token', token]
  );
  // Local import to avoid a require cycle (niftytraderService.ts will import this module too).
  const { invalidateNiftyTraderToken } = await import('./niftytraderService');
  invalidateNiftyTraderToken();
}

/** Ensures app_settings.niftytrader_auth_token is present and not close to expiring. Returns
 * true if a usable (possibly pre-existing) token is available afterward, false only when
 * there's no token at all AND a refresh attempt couldn't obtain one (e.g. no credentials
 * configured yet) — matches ensureTrendlyneSession()'s return-value contract. */
export async function ensureNiftyTraderToken(): Promise<boolean> {
  const row = await dbGet<{ value: string }>(
    "SELECT value FROM app_settings WHERE key = 'niftytrader_auth_token'"
  ).catch(() => null);
  const existing = row?.value || '';

  if (existing) {
    const expMs = decodeJwtExpiryMs(existing);
    // A token whose exp we can't decode is treated as still-good rather than force-refreshed —
    // decodeJwtExpiryMs only fails on a malformed token, and blindly refreshing every call
    // whenever that happens would hammer the login endpoint for a decode bug, not an auth one.
    if (expMs === null || Date.now() < expMs - REFRESH_MARGIN_MS) {
      return true;
    }
    console.log('[NIFTYTRADER AUTH] Stored token is expired or close to expiry — refreshing.');
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    for (let attempt = 1; attempt <= MAX_LOGIN_ATTEMPTS; attempt += 1) {
      const token = await loginNiftyTrader();
      if (token) {
        await writeToken(token);
        refreshInFlight = null;
        return true;
      }
      if (attempt < MAX_LOGIN_ATTEMPTS) await sleep(1000 * attempt);
    }
    refreshInFlight = null;
    // Fall back to whatever was already stored (even if stale/expired) rather than leaving
    // getNiftyTraderHeaders() with nothing at all — an expired token failing with a clear 401
    // downstream is more diagnosable than every NiftyTrader call failing with no token at all.
    return !!existing;
  })();

  return refreshInFlight;
}

let _refreshTimer: ReturnType<typeof setInterval> | null = null;
const REFRESH_CHECK_INTERVAL_MS = Number(process.env.NIFTYTRADER_REFRESH_CHECK_INTERVAL_MS ?? 6 * 60 * 60 * 1000); // 6h

/** Starts a periodic background check (default every 6h) that keeps app_settings.
 * niftytrader_auth_token fresh without adding any per-request overhead to
 * getNiftyTraderHeaders() -- see that function's own comment for why this can't just live on
 * the request hot path (it broke the token-caching contract settingsCache.test.ts enforces).
 * ensureNiftyTraderToken() only actually logs in when the stored token is within
 * REFRESH_MARGIN_MS (48h) of expiring, so most ticks are a cheap DB read + JWT decode, not a
 * real network call. Idempotent -- calling this twice (e.g. a hot-reload) clears the previous
 * timer first rather than stacking a second one. Call once at server startup; call
 * stopNiftyTraderTokenRefreshTimer() on graceful shutdown if the process needs a clean exit. */
export function startNiftyTraderTokenRefreshTimer(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
  }
  // Check once shortly after startup too, not just on the first 6h tick -- a token that
  // expired while the process was down should be caught promptly, not up to 6h later.
  void ensureNiftyTraderToken().catch(e =>
    console.warn('[NIFTYTRADER AUTH] Startup token check failed (non-fatal):', e.message));
  _refreshTimer = setInterval(() => {
    void ensureNiftyTraderToken().catch(e =>
      console.warn('[NIFTYTRADER AUTH] Periodic token check failed (non-fatal):', e.message));
  }, REFRESH_CHECK_INTERVAL_MS);
  _refreshTimer.unref?.(); // don't keep the process alive solely for this timer
}

export function stopNiftyTraderTokenRefreshTimer(): void {
  if (_refreshTimer) {
    clearInterval(_refreshTimer);
    _refreshTimer = null;
  }
}
