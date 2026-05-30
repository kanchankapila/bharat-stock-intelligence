import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';

interface ScreenerNameRow {
  source: string;
  screener_id: string;
  screener_name: string;
}

const dbPath = path.resolve(process.cwd(), 'database.sqlite');
const outputPath = path.resolve(process.cwd(), 'screener_names.csv');
const db = new Database(dbPath, { readonly: true });

function quoteCsv(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

const rows: ScreenerNameRow[] = [
  ...db.prepare(`
    SELECT 'trendlyne' AS source, screener_id, screener_name
    FROM trendlyne_screeners
    ORDER BY screener_name, screener_id
  `).all() as ScreenerNameRow[],
  ...db.prepare(`
    SELECT 'moneycontrol' AS source, scan_id AS screener_id, screener_name
    FROM moneycontrol_screeners
    ORDER BY screener_name, scan_id
  `).all() as ScreenerNameRow[],
  ...db.prepare(`
    SELECT 'etnow' AS source, screener_id, screener_name
    FROM etnow_screeners
    ORDER BY screener_name, screener_id
  `).all() as ScreenerNameRow[],
];

const csv = [
  'source,screener_id,screener_name',
  ...rows.map(row => [
    quoteCsv(row.source),
    quoteCsv(row.screener_id),
    quoteCsv(row.screener_name),
  ].join(',')),
].join('\n');

fs.writeFileSync(outputPath, `${csv}\n`, 'utf8');
db.close();

const counts = rows.reduce<Record<string, number>>((result, row) => {
  result[row.source] = (result[row.source] ?? 0) + 1;
  return result;
}, {});

console.log(`Exported ${rows.length} screener names to ${outputPath}`);
console.log(counts);
