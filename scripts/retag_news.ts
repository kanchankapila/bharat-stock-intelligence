/**
 * Re-tag existing news_sentiment_items with the name-based entity tagger.
 * Measures the coverage lift vs the old ticker-substring tagging.
 *   npx tsx scripts/retag_news.ts
 */
import fs from 'fs';
import { Pool } from 'pg';
import { buildAliasIndex, extractSymbolsByName, NEWS_ALIAS_OVERRIDES } from '../src/server/newsEntityTagger';

const connectionString = fs.readFileSync('.env', 'utf8').match(/^POSTGRES_URL=(.+)$/m)![1].trim();

async function main() {
  const pool = new Pool({ connectionString });

  const stocks = (await pool.query(
    `SELECT symbol, name FROM nse_stocks WHERE status = 'ACTIVE' AND name IS NOT NULL`,
  )).rows as { symbol: string; name: string }[];
  const index = buildAliasIndex(stocks, NEWS_ALIAS_OVERRIDES);
  console.log(`alias index: ${index.length} aliases over ${stocks.length} stocks`);

  const articles = (await pool.query(
    `SELECT id, title, COALESCE(summary,'') AS summary, symbols_json FROM news_sentiment_items`,
  )).rows as { id: string; title: string; summary: string; symbols_json: string }[];

  let beforeTagged = 0, afterTagged = 0, changed = 0;
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    for (const a of articles) {
      const had = a.symbols_json && a.symbols_json !== '' && a.symbols_json !== '[]';
      if (had) beforeTagged++;
      const syms = extractSymbolsByName(`${a.title} ${a.summary}`, index);
      const json = JSON.stringify(syms);
      if (syms.length > 0) afterTagged++;
      if (json !== (a.symbols_json ?? '[]')) {
        await client.query(`UPDATE news_sentiment_items SET symbols_json = $1 WHERE id = $2`, [json, a.id]);
        changed++;
      }
    }
    await client.query('COMMIT');
  } catch (e) {
    await client.query('ROLLBACK'); throw e;
  } finally {
    client.release();
  }

  const n = articles.length;
  const pct = (x: number) => `${((100 * x) / n).toFixed(1)}%`;
  console.log(`\narticles:        ${n}`);
  console.log(`tagged BEFORE:   ${beforeTagged}  (${pct(beforeTagged)})`);
  console.log(`tagged AFTER:    ${afterTagged}  (${pct(afterTagged)})`);
  console.log(`rows updated:    ${changed}`);
  await pool.end();
}

main().catch((e) => { console.error(e); process.exit(1); });
