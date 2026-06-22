// Restore ground-truth ML training tables from a purge backup. Idempotent: ON CONFLICT
// DO NOTHING so existing (current-window) rows are never overwritten.
// Usage: node scripts/restore_from_backup.cjs <backup.json> table1 [table2 ...]
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');

const env = fs.readFileSync(path.join(__dirname, '..', '.env'), 'utf8');
const connectionString = env.match(/^POSTGRES_URL=(.+)$/m)[1].trim();

const file = process.argv[2];
const tables = process.argv.slice(3);
if (!file || tables.length === 0) {
  console.error('Usage: node restore_from_backup.cjs <backup.json> table1 [table2 ...]');
  process.exit(1);
}
const backup = JSON.parse(fs.readFileSync(file, 'utf8'));

async function restoreTable(client, table, rows) {
  if (!rows || rows.length === 0) { console.log(`${table}: nothing in backup`); return; }
  const cols = Object.keys(rows[0]);
  const colSql = cols.map(c => `"${c}"`).join(', ');
  const BATCH = 400;
  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH) {
    const slice = rows.slice(i, i + BATCH);
    const params = [];
    const tuples = slice.map(r => {
      const ph = cols.map(c => { params.push(r[c] === undefined ? null : r[c]); return `$${params.length}`; });
      return `(${ph.join(', ')})`;
    });
    const res = await client.query(
      `INSERT INTO ${table} (${colSql}) VALUES ${tuples.join(', ')} ON CONFLICT DO NOTHING`,
      params,
    );
    inserted += res.rowCount;
  }
  console.log(`${table}: ${inserted} inserted (of ${rows.length} in backup; rest were conflicts/duplicates)`);
}

(async () => {
  const pool = new Pool({ connectionString });
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const t of tables) {
      const before = (await client.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      await restoreTable(client, t, backup.tables[t]);
      const after = (await client.query(`SELECT COUNT(*)::int n FROM ${t}`)).rows[0].n;
      console.log(`   ${t}: ${before} -> ${after} rows`);
    }
    await client.query('COMMIT');
    console.log('\nCOMMITTED.');
  } catch (e) {
    try { await client.query('ROLLBACK'); } catch {}
    console.error('FAILED, rolled back:', e.message);
    process.exitCode = 1;
  } finally {
    client.release();
    await pool.end();
  }
})();
