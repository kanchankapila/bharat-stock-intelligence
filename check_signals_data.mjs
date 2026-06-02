import Database from 'better-sqlite3';

const db = new Database('./database.sqlite');

const signals = db.prepare(`
  SELECT COUNT(*) as count FROM technical_signals 
  WHERE date >= date('now', '-30 days') AND signal_score >= 5
`).get();

const confluence = db.prepare(`
  SELECT COUNT(*) as count FROM confluence_signals 
  WHERE computed_at >= date('now', '-30 days')
`).get();

const recommendations = db.prepare(`
  SELECT COUNT(*) as count FROM recommendation_log 
  WHERE actual_return_pct IS NOT NULL
`).get();

console.log('Technical signals (last 30 days, score >= 5):', signals.count);
console.log('Confluence signals (last 30 days):', confluence.count);
console.log('Recommendations with returns:', recommendations.count);

// Sample technical signal
const sample = db.prepare(`
  SELECT id, symbol, date, entry_price, signal_score, cmp, rsi, adx 
  FROM technical_signals 
  WHERE date >= date('now', '-30 days') AND signal_score >= 5
  LIMIT 3
`).all();

console.log('\nSample technical signals:');
sample.forEach(s => {
  console.log(`  ${s.symbol} (${s.date}): entry=${s.entry_price}, score=${s.signal_score}, cmp=${s.cmp}`);
});

db.close();
