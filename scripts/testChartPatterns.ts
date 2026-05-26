import Database from 'better-sqlite3';
import path from 'path';
import stockData from '../src/data/stocklist.js';

const dbPath = path.resolve(process.cwd(), process.env.DATABASE_URL || 'database.sqlite');
console.log('📝 Initializing database at:', dbPath);

try {
  const db = new Database(dbPath, { timeout: 10000 });
  console.log('✓ Database connected');

  // Check if table exists
  const tableExists = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name='mc_chart_patterns'"
  ).get();

  console.log('✓ Table mc_chart_patterns exists:', !!tableExists);

  // Count stocks
  console.log(`✓ Total stocks loaded: ${stockData.length}`);

  // Test connection with first stock
  if (stockData.length > 0) {
    const firstStock = stockData[0];
    console.log(`✓ First stock: ${firstStock.symbol} (MC: ${firstStock.mcsymbol})`);
  }

  db.close();
  console.log('✓ Database closed successfully');
} catch (error) {
  const err = error as Error;
  console.error('✗ Error:', err.message);
  console.error(err.stack);
  process.exit(1);
}
