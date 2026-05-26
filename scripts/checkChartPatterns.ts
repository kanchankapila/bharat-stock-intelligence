import Database from 'better-sqlite3';
import path from 'path';

const dbPath = path.resolve(process.cwd(), process.env.DATABASE_URL || 'database.sqlite');
const db = new Database(dbPath, { timeout: 10000 });

try {
  const stats = db.prepare(`
    SELECT 
      COUNT(*) as total,
      COUNT(DISTINCT mcsymbol) as stocks,
      COUNT(DISTINCT symbol) as nse_symbols
    FROM mc_chart_patterns
  `).get() as any;

  console.log('📊 MoneyControl Chart Patterns - Database Summary\n');
  console.log(`Total patterns stored: ${stats.total}`);
  console.log(`Stocks with patterns: ${stats.stocks}`);
  console.log(`NSE symbols resolved: ${stats.nse_symbols}`);

  // Sample data
  const samples = db.prepare(`
    SELECT 
      mcsymbol,
      symbol,
      pattern_name,
      target_price,
      target_return_pct
    FROM mc_chart_patterns
    LIMIT 5
  `).all() as any[];

  console.log('\n📌 Sample patterns:');
  samples.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.symbol || p.mcsymbol} - ${p.pattern_name} (${p.target_return_pct}% return)`);
  });

  // Top patterns by return
  const top = db.prepare(`
    SELECT 
      symbol,
      pattern_name,
      target_return_pct,
      COUNT(*) as count
    FROM mc_chart_patterns
    WHERE target_return_pct IS NOT NULL
    GROUP BY symbol
    ORDER BY target_return_pct DESC
    LIMIT 5
  `).all() as any[];

  console.log('\n🚀 Top patterns by return:');
  top.forEach((p, i) => {
    console.log(`  ${i + 1}. ${p.symbol} - ${p.pattern_name} (${p.target_return_pct}%)`);
  });

} finally {
  db.close();
}
