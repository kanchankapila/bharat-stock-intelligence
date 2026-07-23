import { dbAll, dbRun, dbTransaction } from './dbAsync';
import {
  initEtMarketstatsScreeners, getEtMarketstatsScreenerDefs,
  fetchEtMarketstatsScreener, getFieldValue, cleanNseSymbol, extractMetricRows,
  type EtMarketstatsScreenerDef,
} from './etMarketstats';

const upsertMetricSql = `
  INSERT INTO mc_general_metrics (symbol, source_api, metric_group, metric_name, metric_value_num, metric_value_text, fetched_at)
  VALUES (?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT(symbol, source_api, metric_group, metric_name, fetched_at) DO UPDATE SET
    metric_value_num  = excluded.metric_value_num,
    metric_value_text = excluded.metric_value_text
`;

export async function getEtMarketstatsStockCount(): Promise<number> {
  try {
    return ((await dbAll<{ n: number }>('SELECT COUNT(*) as n FROM et_marketstats_screener_stocks'))[0] as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * Sync ET Marketstats/Technicals screeners: fetch each definition's page-1 results and
 * upsert into et_marketstats_screener_stocks, seed/update screener_master (source =
 * 'et_marketstats') so the generic screener-intelligence surface (screeners.router.ts
 * leaderboard/detail/appearance-history + confluenceEngine.ts) picks it up automatically,
 * and track entries/exits via screener_appearances. Mirrors etnowScreenerSync.ts.
 */
export async function syncEtMarketstatsScreeners(timeframeFilter?: 'intraday' | 'long_term'): Promise<void> {
  console.log(`[ET_MARKETSTATS] Starting sync (filter: ${timeframeFilter || 'all'})...`);

  let defs = await getEtMarketstatsScreenerDefs();
  if (defs.length === 0) {
    console.log('[ET_MARKETSTATS] et_marketstats_screeners empty — seeding...');
    await initEtMarketstatsScreeners();
    defs = await getEtMarketstatsScreenerDefs();
  }

  if (timeframeFilter) {
    const { isIntradayScreener } = await import('./trendlyneScreener');
    defs = defs.filter(d => {
      const isIntraday = isIntradayScreener(d.label);
      return timeframeFilter === 'intraday' ? isIntraday : !isIntraday;
    });
  }

  if (defs.length === 0) {
    console.warn('[ET_MARKETSTATS] No screener definitions to sync.');
    return;
  }

  console.log(`[ET_MARKETSTATS] Fetching ${defs.length} screeners...`);

  const upsertStockSql = `
    INSERT INTO et_marketstats_screener_stocks
      (screener_key, symbol, stock_name, asset_id, exchange_id, last_traded_price, percent_change, raw_data, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(screener_key, symbol) DO UPDATE SET
      stock_name = excluded.stock_name,
      last_traded_price = excluded.last_traded_price,
      percent_change = excluded.percent_change,
      raw_data = excluded.raw_data,
      last_seen = excluded.last_seen
  `;
  const upsertMasterSql = `
    INSERT INTO screener_master (scan_id, name, source, inferred_timeframe, last_updated)
    VALUES (?, ?, 'et_marketstats', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(scan_id) DO UPDATE SET
      name = excluded.name,
      last_updated = CURRENT_TIMESTAMP
  `;

  const { isIntradayScreener } = await import('./trendlyneScreener');
  let synced = 0, failed = 0;

  for (const def of defs) {
    try {
      const response = await fetchEtMarketstatsScreener(def);
      const records = response.dataList || [];

      await dbRun(upsertMasterSql, [def.screenerKey, def.label, isIntradayScreener(def.label) ? 'intraday' : 'long_term']);

      if (records.length === 0) {
        console.warn(`  [ET_MARKETSTATS] No records for "${def.label}"`);
        continue;
      }

      const prevSymbols = new Set<string>(
        (await dbAll<{ symbol: string }>(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`,
          [def.screenerKey])).map(r => r.symbol).filter(Boolean)
      );

      const today = new Date().toISOString().slice(0, 10);
      const incomingSymbols = new Set<string>();

      for (const record of records) {
        const raw = record.assetSymbol || '';
        if (!raw) continue;
        const symbol = cleanNseSymbol(raw);
        if (symbol) incomingSymbols.add(symbol);
      }

      await dbTransaction(async (tx) => {
        const existing = await tx.all<{ symbol: string }>(
          `SELECT symbol FROM et_marketstats_screener_stocks WHERE screener_key = ?`, [def.screenerKey]);
        const toRemove = existing.filter(r => !incomingSymbols.has(r.symbol));
        for (const r of toRemove) {
          await tx.run(`DELETE FROM et_marketstats_screener_stocks WHERE screener_key = ? AND symbol = ?`, [def.screenerKey, r.symbol]);
        }

        for (const record of records) {
          const raw = record.assetSymbol || '';
          if (!raw) continue;
          const symbol = cleanNseSymbol(raw);
          if (!symbol) continue;

          const ltp = parseFloat(getFieldValue(record, 'lastTradedPrice') || '') || null;
          const pctChg = parseFloat(getFieldValue(record, 'percentChange') || '') || null;

          await tx.run(upsertStockSql, [
            def.screenerKey, symbol, record.assetName || null, record.assetId || null,
            record.assetExchangeId || null, ltp, pctChg, JSON.stringify(record.data || []),
            today, today,
          ]);

          // Structured extraction into mc_general_metrics — makes every field this
          // screener returns (Beta, DSCR, Ultimate Oscillator, quarterly margin trail,
          // etc.) queryable without parsing raw_data. Applies to all 95 screeners
          // (existing + the 4 confirmed extra views), not just the new ones.
          for (const metricRow of extractMetricRows(def, symbol, record, today)) {
            await tx.run(upsertMetricSql, metricRow);
          }
        }
      });

      const entered = Array.from(incomingSymbols).filter(s => !prevSymbols.has(s));
      const exited  = Array.from(prevSymbols).filter(s => !incomingSymbols.has(s));

      if (entered.length > 0) {
        await dbTransaction(async (tx) => {
          for (const s of entered) {
            await tx.run(
              `INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date) VALUES (?, 'et_marketstats', ?, ?)`,
              [def.screenerKey, s, today]);
          }
        });
      }
      if (exited.length > 0) {
        await dbRun(
          `UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`,
          [today, def.screenerKey, ...exited]);
      }

      synced++;
      console.log(`  [ET_MARKETSTATS] "${def.label}": ${records.length} rows, ${incomingSymbols.size} symbols resolved`);
      await new Promise(resolve => setTimeout(resolve, 500));
    } catch (error) {
      failed++;
      console.error(`  [ET_MARKETSTATS] Error syncing "${def.label}":`, error instanceof Error ? error.message : error);
    }
  }

  console.log(`[ET_MARKETSTATS] Sync complete: ${synced} succeeded, ${failed} failed.`);
}

export async function findEtMarketstatsScreenersByStock(symbol: string): Promise<Array<{
  id: string; name: string; source: string; description: string;
}>> {
  try {
    if (!symbol) return [];
    const matches = await dbAll<{ screener_key: string; label: string }>(`
      SELECT es.screener_key, es.label
      FROM et_marketstats_screeners es
      JOIN et_marketstats_screener_stocks ess ON es.screener_key = ess.screener_key
      WHERE ess.symbol = ?
    `, [symbol]);

    return matches.map(m => ({
      id: m.screener_key, name: m.label, source: 'et_marketstats',
      description: 'ET Marketstats/Technicals Screener',
    }));
  } catch (error) {
    console.error(`Error finding ET Marketstats screeners for ${symbol}:`, error);
    return [];
  }
}
