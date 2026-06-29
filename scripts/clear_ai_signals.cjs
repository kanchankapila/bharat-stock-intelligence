// Clear ALL AI-source unified_signals (pre-fix producer output). Backup-first, FK-safe.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const connectionString = env.match(/^POSTGRES_URL=(.+)$/m)[1].trim();

(async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    const sigs = await client.query(`SELECT * FROM unified_signals WHERE signal_source = 'AI'`);
    const outs = await client.query(
      `SELECT * FROM unified_signal_outcomes WHERE unified_signal_id IN (SELECT id FROM unified_signals WHERE signal_source = 'AI')`);
    console.log(`AI signals to clear: ${sigs.rows.length} (+ ${outs.rows.length} outcomes)`);
    if (sigs.rows.length === 0) { console.log('Nothing to clear.'); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const dir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `ai_signals_cleared_${stamp}.json`);
    fs.writeFileSync(file, JSON.stringify(
      { exported_at: new Date().toISOString(), unified_signals: sigs.rows, unified_signal_outcomes: outs.rows }, null, 2));
    console.log(`Backup: ${file}\n`);

    await client.query('BEGIN');
    const o = await client.query(
      `DELETE FROM unified_signal_outcomes WHERE unified_signal_id IN (SELECT id FROM unified_signals WHERE signal_source = 'AI')`);
    console.log(`deleted unified_signal_outcomes: ${o.rowCount}`);
    const s = await client.query(`DELETE FROM unified_signals WHERE signal_source = 'AI'`);
    console.log(`deleted unified_signals (AI): ${s.rowCount}`);
    await client.query('COMMIT');
    console.log('\nCOMMITTED.');

    const remain = await client.query(
      `SELECT signal_source, COUNT(*)::int n FROM unified_signals GROUP BY signal_source ORDER BY signal_source`);
    console.table(remain.rows);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('FAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
