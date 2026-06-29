// Purge pre-2026-06-21 signal rows from Postgres after backing them up to JSON.
// Scope: core signal + outcome tables only (per user). Single transaction; all-or-nothing.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const envPath = path.join(__dirname, '..', '.env');
const env = fs.readFileSync(envPath, 'utf8');
const m = env.match(/^POSTGRES_URL=(.+)$/m);
const connectionString = m ? m[1].trim() : null;
if (!connectionString) { console.error('No POSTGRES_URL in .env'); process.exit(1); }

const CUTOFF = '2026-06-21';

// Backup SELECT predicates (must match the DELETE predicates below).
const backupQueries = {
  unified_signals:          `SELECT * FROM unified_signals WHERE signal_date < $1::timestamptz`,
  unified_signal_outcomes:  `SELECT * FROM unified_signal_outcomes WHERE signal_date < $1::text OR unified_signal_id IN (SELECT id FROM unified_signals WHERE signal_date < $1::timestamptz)`,
  technical_signals:        `SELECT * FROM technical_signals WHERE date < $1::text`,
  signal_outcomes:          `SELECT * FROM signal_outcomes WHERE signal_date < $1::text`,
  signal_excursions:        `SELECT * FROM signal_excursions WHERE signal_date < $1::text`,
};

(async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    // 1. BACKUP (read-only) ----------------------------------------------------
    const backup = { cutoff: CUTOFF, exported_at: new Date().toISOString(), tables: {} };
    for (const [tbl, q] of Object.entries(backupQueries)) {
      const r = await client.query(q, [CUTOFF]);
      backup.tables[tbl] = r.rows;
      console.log(`backed up ${tbl}: ${r.rows.length} rows`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `signals_purge_${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(backup, null, 2));
    const sizeMB = (fs.statSync(outFile).size / 1048576).toFixed(1);
    console.log(`\nBackup written: ${outFile} (${sizeMB} MB)\n`);

    // 2. DELETE (transaction, FK-safe order) -----------------------------------
    await client.query('BEGIN');
    const del = async (label, sql) => {
      const r = await client.query(sql, [CUTOFF]);
      console.log(`deleted ${label}: ${r.rowCount} rows`);
    };
    // children / independent tables first
    await del('unified_signal_outcomes', `DELETE FROM unified_signal_outcomes WHERE signal_date < $1::text OR unified_signal_id IN (SELECT id FROM unified_signals WHERE signal_date < $1::timestamptz)`);
    await del('signal_excursions',       `DELETE FROM signal_excursions WHERE signal_date < $1::text`);
    await del('signal_outcomes',         `DELETE FROM signal_outcomes WHERE signal_date < $1::text`);
    await del('technical_signals',       `DELETE FROM technical_signals WHERE date < $1::text`);
    // parent last (cascades signal_actions + signal_portfolio_correlation)
    await del('unified_signals',         `DELETE FROM unified_signals WHERE signal_date < $1::timestamptz`);
    await client.query('COMMIT');
    console.log('\nCOMMITTED.\n');

    // 3. VERIFY ----------------------------------------------------------------
    for (const tbl of Object.keys(backupQueries)) {
      const tot = await client.query(`SELECT COUNT(*)::int AS n FROM ${tbl}`);
      const rng = await client.query(
        `SELECT MIN(${tbl === 'technical_signals' ? 'date' : 'signal_date'})::text AS mn,
                MAX(${tbl === 'technical_signals' ? 'date' : 'signal_date'})::text AS mx FROM ${tbl}`);
      console.log(`${tbl}: ${tot.rows[0].n} rows remaining  (${rng.rows[0].mn} -> ${rng.rows[0].mx})`);
    }
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\nFAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
