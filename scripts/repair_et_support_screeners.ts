import 'dotenv/config';
import { getEtMarketstatsScreenerDefs, initEtMarketstatsScreeners } from '../src/server/etMarketstats';
import { syncEtMarketstatsScreeners } from '../src/server/etMarketstatsSync';
import { closePool } from '../src/server/pgClient';
import { dbTransaction } from '../src/server/dbAsync';
import { classifyByKeyword } from '../src/server/screenerClassifier';

try {
  if (!process.argv.includes('--apply')) throw new Error('Explicit --apply required to seed and capture corrected screeners.');
  await initEtMarketstatsScreeners();
  const defs = (await getEtMarketstatsScreenerDefs()).filter(d => /^Negative Breakout.*Support$/i.test(d.label));
  if (defs.length !== 3 || defs.some(d => d.operationType !== 'Below')) throw new Error('Expected exactly three corrected support filters.');
  await syncEtMarketstatsScreeners(undefined, defs.map(d => d.screenerKey));
  await dbTransaction(async tx => {
    for (const def of defs) {
      const c = classifyByKeyword(def.label, 'et_marketstats', def.screenerKey);
      await tx.run(`UPDATE screener_master SET inferred_sentiment='bearish', inferred_category=?, subcategory=?, inferred_timeframe=?,
        confidence=?, classified_by='keyword' WHERE source='et_marketstats' AND scan_id=?`,
      [c.category, c.subcategory, c.investment_horizon === 'intraday' ? 'intraday' : 'long_term', c.confidence, def.screenerKey]);
      await tx.run(`INSERT INTO screener_catalog (screener_id,source,screener_name,category,subcategory,
        signal_bias,investment_horizon,confidence,fetched_at) VALUES (?,'et_marketstats',?,?,?,?,?,?,CURRENT_TIMESTAMP)
        ON CONFLICT(screener_id,source) DO NOTHING`,
      [def.screenerKey, def.label, c.category, c.subcategory, 'bearish', c.investment_horizon, c.confidence]);
    }
    for (const id of ['negative-breakout-first-support-e1d50602', 'negative-breakout-second-support-c36e0e85',
      'negative-breakout-third-support-c98059b4']) {
      await tx.run(`UPDATE screener_master SET inferred_sentiment='neutral' WHERE source='et_marketstats' AND scan_id=?`, [id]);
      await tx.run(`UPDATE screener_catalog SET signal_bias='neutral' WHERE source='et_marketstats' AND screener_id=?`, [id]);
    }
  });
  console.log(JSON.stringify(defs.map(d => ({ key: d.screenerKey, label: d.label, operation: d.operationType }))));
} finally {
  await closePool();
}
