import { dbAll, dbRun, dbTransaction } from './dbAsync';
import { rowGroups, rowGroupsWith, bulkUpsert } from './dbBulk';
import { delay } from './lib/async';
import {
  initEtMarketstatsScreeners, getEtMarketstatsScreenerDefs,
  fetchEtMarketstatsScreener, getFieldValue, cleanNseSymbol, extractMetricRows,
  type EtMarketstatsScreenerDef,
} from './etMarketstats';

const METRIC_COLS = 7;
const buildMetricUpsertSql = (n: number) => `
  INSERT INTO mc_general_metrics (symbol, source_api, metric_group, metric_name, metric_value_num, metric_value_text, fetched_at)
  VALUES ${rowGroups(n, METRIC_COLS)}
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

  const STOCK_COLS = 10;
  const buildStockUpsertSql = (n: number) => `
    INSERT INTO et_marketstats_screener_stocks
      (screener_key, symbol, stock_name, asset_id, exchange_id, last_traded_price, percent_change, raw_data, first_seen, last_seen)
    VALUES ${rowGroups(n, STOCK_COLS)}
    ON CONFLICT(screener_key, symbol) DO UPDATE SET
      stock_name = excluded.stock_name,
      last_traded_price = excluded.last_traded_price,
      percent_change = excluded.percent_change,
      raw_data = excluded.raw_data,
      last_seen = excluded.last_seen
  `;
  // ON CONFLICT target is (source, scan_id) -- screener_master's PK, not scan_id alone (which
  // MC and ETnow independently collide on; see the 2026-08-04 screener_master memory). Not just
  // a correctness nuance here: after that PK migration, ON CONFLICT(scan_id) alone no longer
  // matches any unique constraint and Postgres rejects the upsert outright.
  const upsertMasterSql = `
    INSERT INTO screener_master (scan_id, name, source, inferred_timeframe, last_updated)
    VALUES (?, ?, 'et_marketstats', ?, CURRENT_TIMESTAMP)
    ON CONFLICT(source, scan_id) DO UPDATE SET
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

      // Fixed 2026-07-30 (Finding #37, full-stack audit): this loop used to run one
      // tx.run() per stock row plus one per extracted metric -- ~83,000-127,000
      // sequential statement executions per sync run (confirmed live: ~8,453 stock rows +
      // 75,512-118,398 metric rows per run). Batched into multi-row VALUES upserts via the
      // existing rowGroups()/bulkUpsert() helpers, already used correctly for the same
      // pattern in confluenceEngine.ts. dbBulk.ts requires rows deduped by their ON
      // CONFLICT key beforehand (a multi-row upsert touching the same key twice errors on
      // Postgres) -- Map-keyed-by-conflict-key with last-write-wins insertion order
      // preserves the exact same "later duplicate overwrites earlier" semantics the
      // sequential tx.run() calls had.
      const stockRowsByKey = new Map<string, unknown[]>();
      const metricRowsByKey = new Map<string, unknown[]>();

      for (const record of records) {
        const raw = record.assetSymbol || '';
        if (!raw) continue;
        const symbol = cleanNseSymbol(raw);
        if (!symbol) continue;

        const ltp = parseFloat(getFieldValue(record, 'lastTradedPrice') || '') || null;
        const pctChg = parseFloat(getFieldValue(record, 'percentChange') || '') || null;

        stockRowsByKey.set(`${def.screenerKey}|${symbol}`, [
          def.screenerKey, symbol, record.assetName || null, record.assetId || null,
          record.assetExchangeId || null, ltp, pctChg, JSON.stringify(record.data || []),
          today, today,
        ]);

        // Structured extraction into mc_general_metrics — makes every field this
        // screener returns (Beta, DSCR, Ultimate Oscillator, quarterly margin trail,
        // etc.) queryable without parsing raw_data. Applies to all 95 screeners
        // (existing + the 4 confirmed extra views), not just the new ones.
        for (const metricRow of extractMetricRows(def, symbol, record, today)) {
          const [sym, sourceApi, metricGroup, metricName, , , fetchedAt] = metricRow;
          metricRowsByKey.set(`${sym}|${sourceApi}|${metricGroup}|${metricName}|${fetchedAt}`, metricRow);
        }
      }

      await dbTransaction(async (tx) => {
        const existing = await tx.all<{ symbol: string }>(
          `SELECT symbol FROM et_marketstats_screener_stocks WHERE screener_key = ?`, [def.screenerKey]);
        const toRemove = existing.filter(r => !incomingSymbols.has(r.symbol));
        if (toRemove.length) {
          await tx.run(
            `DELETE FROM et_marketstats_screener_stocks WHERE screener_key = ? AND symbol IN (${toRemove.map(() => '?').join(',')})`,
            [def.screenerKey, ...toRemove.map(r => r.symbol)]
          );
        }

        await bulkUpsert(tx, [...stockRowsByKey.values()], STOCK_COLS, buildStockUpsertSql);
        await bulkUpsert(tx, [...metricRowsByKey.values()], METRIC_COLS, buildMetricUpsertSql);
      });

      const entered = Array.from(incomingSymbols).filter(s => !prevSymbols.has(s));
      const exited  = Array.from(prevSymbols).filter(s => !incomingSymbols.has(s));

      if (entered.length > 0) {
        // appeared_at records WHEN the sync saw it -- appeared_date is date-only and is
        // the dedup key, so it cannot carry a time. See the migration.
        const appearedAt = new Date().toISOString();
        // 4 bind params per row; the 'et_marketstats' literal stays in the SQL
        // (screenerAppearedAt.test.ts pins the source literal on the INSERT line).
        const buildAppSql = (n: number) =>
          `INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date, appeared_at) VALUES ${rowGroupsWith(n, "(?, 'et_marketstats', ?, ?, ?)")}`;
        await dbTransaction((tx) =>
          bulkUpsert(tx, entered.map(s => [def.screenerKey, s, today, appearedAt]), 4, buildAppSql));
      }
      if (exited.length > 0) {
        await dbRun(
          `UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`,
          [today, def.screenerKey, ...exited]);
      }

      synced++;
      console.log(`  [ET_MARKETSTATS] "${def.label}": ${records.length} rows, ${incomingSymbols.size} symbols resolved`);
      await delay(500);
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
