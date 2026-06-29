/**
 * Fail-fast environment validation (P5 hardening).
 *
 * Run once at server bootstrap, after `dotenv/config`. Catches the misconfigurations
 * that fail *silently* — most importantly a mistyped USE_POSTGRES (e.g. "True", "1",
 * "yes") which would otherwise quietly route the whole app back onto SQLite instead of
 * the Postgres/TimescaleDB instance it was cut over to. Those get a hard exit; softer
 * gaps (missing AI keys) get a warning.
 */

const FATAL: string[] = [];
const WARN: string[] = [];

function isIntString(v: string | undefined): boolean {
  return v !== undefined && /^\d+$/.test(v.trim());
}

export function validateEnv(): void {
  FATAL.length = 0;
  WARN.length = 0;

  // ── DB routing: the silent-wrong-database trap ──────────────────────────────
  const usePg = process.env.USE_POSTGRES;
  if (usePg !== undefined && usePg !== 'true' && usePg !== 'false') {
    FATAL.push(
      `USE_POSTGRES must be exactly "true", "false", or unset — got "${usePg}". ` +
      `Any other value silently routes the app onto SQLite.`,
    );
  }
  if (usePg === 'true' && !process.env.POSTGRES_URL && !process.env.POSTGRES_HOST) {
    FATAL.push(
      `USE_POSTGRES=true but neither POSTGRES_URL nor POSTGRES_HOST is set — ` +
      `the pg client would fall back to hardcoded localhost dev credentials.`,
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

  console.log(
    `[ENV] Validated — DB engine: ${usePg === 'true' ? 'PostgreSQL/TimescaleDB' : 'SQLite'}.`,
  );
}
