// Task 0.3 Acceptance Gate 0: "a schema dump of the result contains exactly the
// expected tables and no others." This issues a real query against the live
// database -- per the repo's own documented history of "verification" scripts
// that formatted plausible output without ever connecting to a database
// (BUILD_STAGE_0_2_SPEC.md §0.4), that is a hard requirement, not a style choice.
import pg from 'pg';

try {
  process.loadEnvFile();
} catch {
  // no .env present -- rely on process.env already being set
}

const EXPECTED_TABLES = [
  // 002 reference_identity
  'security',
  'provider_security_id',
  'provider_mapping_gap',
  'trading_session',
  'index_definition',
  'index_membership',
  // 003 provider_registry_and_runs
  'provider',
  'provider_endpoint',
  'job_definition',
  'ingestion_run',
  'raw_object',
  // 004 market_facts
  'market_bar',
  'delivery_stat',
  'index_bar',
  'corporate_action',
  'price_adjustment',
  // 005 quality_and_audit
  'dq_check',
  'dq_result',
  'audit_metric',
  // 007 fundamentals_events_screeners
  'fundamental_fact',
  'ownership_fact',
  'analyst_estimate',
  'market_flow',
  'event_fact',
  'screener_definition',
  'screener_membership',
  'transfer_reject',
  // node-pg-migrate's own bookkeeping table
  'pgmigrations',
].sort();

async function main(): Promise<void> {
  const pool = new pg.Pool({ connectionString: process.env.DATABASE_URL });
  try {
    // Exclude partition children (e.g. market_bar_2021) -- they are implementation
    // detail of market_bar, not independent tables a migration "created" in the
    // sense this gate cares about.
    const { rows } = await pool.query<{ table_name: string }>(`
      SELECT c.relname AS table_name
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      WHERE n.nspname = 'public'
        AND c.relkind IN ('r', 'p')
        AND NOT EXISTS (
          SELECT 1 FROM pg_inherits i WHERE i.inhrelid = c.oid
        )
      ORDER BY c.relname
    `);
    const actual = rows.map((r) => r.table_name).sort();

    const missing = EXPECTED_TABLES.filter((t) => !actual.includes(t));
    const unexpected = actual.filter((t) => !EXPECTED_TABLES.includes(t));

    console.log(`[schema:verify] connected to ${process.env.DATABASE_URL?.replace(/:[^:@/]*@/, ':***@')}`);
    console.log(`[schema:verify] expected ${EXPECTED_TABLES.length} tables, found ${actual.length} tables`);

    if (missing.length > 0) {
      console.error(`[schema:verify] MISSING tables: ${missing.join(', ')}`);
    }
    if (unexpected.length > 0) {
      console.error(`[schema:verify] UNEXPECTED tables: ${unexpected.join(', ')}`);
    }
    if (missing.length > 0 || unexpected.length > 0) {
      process.exitCode = 1;
      return;
    }
    console.log('[schema:verify] PASS -- schema matches exactly.');
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error('[schema:verify] FAILED to query database:', err);
  process.exitCode = 1;
});
