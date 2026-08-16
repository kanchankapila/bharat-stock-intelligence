/**
 * Fail-fast environment validation (P5 hardening).
 *
 * Run once at server bootstrap, after `dotenv/config`. Catches misconfigurations that
 * would otherwise fail *silently*. Hard exit for those; softer gaps (missing AI keys)
 * get a warning.
 *
 * This used to validate the spelling of USE_POSTGRES and hard-exit on "True"/"1"/"yes",
 * on the grounds that a bad value "silently routes the app onto SQLite". That stopped
 * being true on 2026-08-15: `usePostgres()` consults no environment variable and there
 * is no SQLite path to route onto. The check therefore could only ever produce a FALSE
 * failure -- a stale `USE_POSTGRES=1` left in someone's .env would hard-crash the server
 * at boot over a variable that no longer does anything, and blame a fallback that no
 * longer exists. Removed 2026-08-16 (AF-20260816-09).
 *
 * What survives is the half that got MORE important, not less: with Postgres now
 * unconditional, missing connection info is always a real misconfiguration, so it is no
 * longer gated behind USE_POSTGRES=true being present.
 */
import { isPostgresConfigured } from './pgConfig';

const FATAL: string[] = [];
const WARN: string[] = [];

function isIntString(v: string | undefined): boolean {
  return v !== undefined && /^\d+$/.test(v.trim());
}

export function validateEnv(): void {
  FATAL.length = 0;
  WARN.length = 0;

  // ── DB connection info ──────────────────────────────────────────────────────
  // Postgres is the only database, so this is unconditional now (see the header note).
  if (!isPostgresConfigured()) {
    FATAL.push(
      `Neither POSTGRES_URL nor POSTGRES_HOST is set — the pg client would fall back to ` +
      `hardcoded localhost dev credentials.`,
    );
  }

  // ── Numeric ports ───────────────────────────────────────────────────────────
  if (process.env.PORT !== undefined && !isIntString(process.env.PORT)) {
    FATAL.push(`PORT must be an integer — got "${process.env.PORT}".`);
  }
  if (process.env.POSTGRES_PORT !== undefined && !isIntString(process.env.POSTGRES_PORT)) {
    FATAL.push(`POSTGRES_PORT must be an integer — got "${process.env.POSTGRES_PORT}".`);
  }

  // ── Soft gaps: degraded but functional ──────────────────────────────────────
  if (!process.env.GEMINI_API_KEY) {
    WARN.push('GEMINI_API_KEY not set — Gemini AI fallback is unavailable (Ollama-only).');
  }

  if (process.env.AI_PROVIDER === 'bedrock') {
    if (!process.env.AWS_ACCESS_KEY_ID || !process.env.AWS_SECRET_ACCESS_KEY) {
      WARN.push('AI_PROVIDER is set to "bedrock" but AWS credentials (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY) are missing.');
    }
  }

  for (const w of WARN) console.warn(`[ENV] WARN: ${w}`);

  if (FATAL.length > 0) {
    console.error('[ENV] Invalid environment configuration:');
    for (const f of FATAL) console.error(`[ENV]   ✗ ${f}`);
    console.error('[ENV] Refusing to start. Fix .env and retry.');
    process.exit(1);
  }

  // Was `${usePg === 'true' ? 'PostgreSQL/TimescaleDB' : 'SQLite'}` — a boot line that would
  // have printed "SQLite" on a correctly-configured server, since USE_POSTGRES is now unset
  // everywhere. Exactly the wrong thing to log while hunting a database problem.
  console.log('[ENV] Validated — DB engine: PostgreSQL/TimescaleDB.');
}
