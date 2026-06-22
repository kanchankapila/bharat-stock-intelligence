// One-off: retro-prune AI-source unified_signals that the new actionability gate would
// reject (HOLD, or confidence below the floor), so existing data matches the gate.
// Backs up to JSON first, deletes in a single transaction, FK-safe order.
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const connectionString = env.match(/^POSTGRES_URL=(.+)$/m)[1].trim();

const FLOOR = Number(process.argv[2] ?? 65);

// Rows the gate rejects: HOLD, NULL confidence, or confidence below the floor.
const PRED = `signal_source = 'AI' AND (signal_type = 'HOLD' OR confidence_score IS NULL OR confidence_score < $1)`;

(async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    // 1. BACKUP (parents + their outcomes) ------------------------------------
    const sigs = await client.query(`SELECT * FROM unified_signals WHERE ${PRED}`, [FLOOR]);
    const outs = await client.query(
      `SELECT * FROM unified_signal_outcomes WHERE unified_signal_id IN (SELECT id FROM unified_signals WHERE ${PRED})`,
      [FLOOR],
    );
    console.log(`AI rows to prune: ${sigs.rows.length}`);
    console.log(`  linked outcomes: ${outs.rows.length}`);
    if (sigs.rows.length === 0) { console.log('Nothing to prune.'); return; }

    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const outDir = path.join(__dirname, '..', 'backups');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, `ai_signals_prune_${stamp}.json`);
    fs.writeFileSync(outFile, JSON.stringify(
      { floor: FLOOR, exported_at: new Date().toISOString(),
        unified_signals: sigs.rows, unified_signal_outcomes: outs.rows }, null, 2));
    console.log(`Backup written: ${outFile}\n`);

    // 2. DELETE (children first; signal_actions + correlation cascade) --------
    await client.query('BEGIN');
    const o = await client.query(
      `DELETE FROM unified_signal_outcomes WHERE unified_signal_id IN (SELECT id FROM unified_signals WHERE ${PRED})`,
      [FLOOR]);
    console.log(`deleted unified_signal_outcomes: ${o.rowCount}`);
    const s = await client.query(`DELETE FROM unified_signals WHERE ${PRED}`, [FLOOR]);
    console.log(`deleted unified_signals (AI): ${s.rowCount}`);
    await client.query('COMMIT');
    console.log('\nCOMMITTED.\n');

    // 3. VERIFY ----------------------------------------------------------------
    const after = await client.query(
      `SELECT signal_type, COUNT(*)::int AS n,
              ROUND(MIN(confidence_score)::numeric,1) AS min_conf
       FROM unified_signals WHERE signal_source = 'AI'
       GROUP BY signal_type ORDER BY signal_type`);
    console.log('Remaining AI signals by type:');
    console.table(after.rows);
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('\nFAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
