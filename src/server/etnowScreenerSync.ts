import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';
import { fetchETnowScreener } from './etnow';
import { getSymbolFromMcsymbol } from './stockMapping';

export async function getETnowStockCount(): Promise<number> {
  try {
    return ((await dbGet<{ n: number }>('SELECT COUNT(*) as n FROM etnow_screener_stocks')) as { n: number }).n;
  } catch {
    return 0;
  }
}

/**
 * Sync ETNow screeners data and populate etnow_screener_stocks table.
 * Fetches stocks for each ETNow screener and inserts them into the DB.
 * Follows the pattern from moneycontrolScreener.ts and trendlyneScreener.ts.
 */
export async function syncETnowScreeners(timeframeFilter?: 'intraday' | 'long_term'): Promise<void> {
  console.log(`🔄 Starting ETNow screener synchronization (filter: ${timeframeFilter || 'all'})...`);

  let screeners = await dbAll<{ screener_id: string; screener_name: string; query_condition: string | null }>(`
    SELECT screener_id, screener_name, query_condition FROM etnow_screeners
  `);

  if (screeners.length === 0) {
    console.log('[SYNC] etnow_screeners is empty — seeding definitions with initEtnowScreeners()...');
    const { initEtnowScreeners } = await import('./etnow');
    await initEtnowScreeners();
    screeners = await dbAll<{ screener_id: string; screener_name: string; query_condition: string | null }>(`
      SELECT screener_id, screener_name, query_condition FROM etnow_screeners
    `);
  }

  if (timeframeFilter) {
    const { isIntradayScreener } = await import('./trendlyneScreener');
    screeners = screeners.filter(s => {
      const isIntraday = isIntradayScreener(s.screener_name);
      return timeframeFilter === 'intraday' ? isIntraday : !isIntraday;
    });
  }

  if (screeners.length === 0) {
    console.warn('⚠️  No ETNow screeners found in database even after seeding.');
    return;
  }

  console.log(`📊 Fetching data for ${screeners.length} ETNow screeners...`);

  const upsertSql = `
    INSERT INTO etnow_screener_stocks (screener_id, symbol, stock_name, first_seen, last_seen)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(screener_id, symbol) DO UPDATE SET
      stock_name = excluded.stock_name,
      last_seen  = excluded.last_seen
  `;

  for (const screener of screeners) {
    try {
      console.log(`  📍 Fetching: ${screener.screener_name} (ID: ${screener.screener_id})`);

      // Parse the stored query_condition (double-encoded JSON) to extract the actual filter string
      let queryCondition = '';
      if (screener.query_condition) {
        try {
          const outer = JSON.parse(screener.query_condition);
          const inner = typeof outer === 'string' ? JSON.parse(outer) : outer;
          queryCondition = inner?.queryCondition ?? '';
        } catch { /* fall back to empty string */ }
      }

      // Fetch screener data from ETNow API
      const response = await fetchETnowScreener(screener.screener_id, queryCondition);
      
      // Handle actual API response format: { dataList, message, statusCode, unixDateTime }
      const records = response.dataList || 
                      response.searchResult?.searchData?.records || 
                      response.data?.records ||
                      [];

      if (records.length === 0) {
        console.warn(`    ⚠️  No records returned for ${screener.screener_name}`);
        continue;
      }

      console.log(`    ✅ Fetched ${records.length} records`);

      // Snapshot previous active symbols BEFORE delete
      const prevSymbols = new Set<string>(
        (await dbAll<{ symbol: string }>(`SELECT symbol FROM screener_appearances WHERE screener_id = ? AND exited_date IS NULL`,
          [screener.screener_id]))
          .map(r => r.symbol).filter(Boolean)
      );

      // Upsert stocks, remove exits
      const today = new Date().toISOString().slice(0, 10);
      const currentSymbols = new Set<string>();
      const incomingSymbols = new Set<string>();

      for (const record of records) {
        const stockName = record.assetName || record.name || record.companyName || record.stock_name || record.shortName || '';
        const rawSymbol = record.assetSymbol || record.stkId || record.symbol || record.code || record.nseid || '';
        if (rawSymbol) {
          const nseSymbol = rawSymbol.replace(/-NSE$/i, '').replace(/EQ$/i, '').replace(/BE$/i, '').trim();
          if (nseSymbol) incomingSymbols.add(nseSymbol);
        }
      }

      await dbTransaction(async (tx) => {
        // Remove exits
        const existing = await tx.all<{ symbol: string }>(`SELECT symbol FROM etnow_screener_stocks WHERE screener_id = ?`,
          [screener.screener_id]);
        const toRemove = existing.filter(r => !incomingSymbols.has(r.symbol));
        if (toRemove.length) {
          const delSql = `DELETE FROM etnow_screener_stocks WHERE screener_id = ? AND symbol = ?`;
          for (const r of toRemove) await tx.run(delSql, [screener.screener_id, r.symbol]);
        }
        // Upsert current
        for (const record of records) {
          const stockName = record.assetName || record.name || record.companyName || record.stock_name || record.shortName || '';
          const rawSymbol = record.assetSymbol || record.stkId || record.symbol || record.code || record.nseid || '';
          if (rawSymbol) {
            const nseSymbol = rawSymbol.replace(/-NSE$/i, '').replace(/EQ$/i, '').replace(/BE$/i, '').trim();
            if (nseSymbol) {
              await tx.run(upsertSql, [screener.screener_id, nseSymbol, stockName, today, today]);
              currentSymbols.add(nseSymbol);
            }
          }
        }
      });

      // Update screener_master sync time. PK is (source, scan_id) -- scope to ETnow or this
      // would also touch MoneyControl's row for a colliding scan_id (2026-08-04 memory).
      await dbRun(`UPDATE screener_master SET last_updated = ?, stocks_synced_at = ? WHERE scan_id = ? AND source = 'ETnow'`,
        [today, today, screener.screener_id]);

      // Diff patch: record new appearances / exits
      const entered = Array.from(currentSymbols).filter(s => !prevSymbols.has(s));
      const exited  = Array.from(prevSymbols).filter(s => !currentSymbols.has(s));

      if (entered.length > 0) {
        // appeared_at records WHEN the sync saw it -- appeared_date is date-only and is the
        // dedup key, so it cannot carry a time. Without this the intraday question ("enter at
        // the moment of flagging, exit at the close") is unmeasurable; see the migration.
        const appearedAt = new Date().toISOString();
        const insertAppSql = `INSERT OR IGNORE INTO screener_appearances (screener_id, source, symbol, appeared_date, appeared_at) VALUES (?, 'etnow', ?, ?, ?)`;
        await dbTransaction(async (tx) => { for (const s of entered) await tx.run(insertAppSql, [screener.screener_id, s, today, appearedAt]); });
      }
      if (exited.length > 0) {
        await dbRun(`UPDATE screener_appearances SET exited_date = ? WHERE screener_id = ? AND symbol IN (${exited.map(() => '?').join(',')}) AND exited_date IS NULL`,
          [today, screener.screener_id, ...exited]);
      }

      // Small delay to avoid rate limiting
      await new Promise(resolve => setTimeout(resolve, 800));
    } catch (error) {
      console.error(`  ❌ Error fetching ${screener.screener_name}:`, error instanceof Error ? error.message : error);
      continue;
    }
  }

  console.log('✅ ETNow screener synchronization complete.');
}

/**
 * Get all ETNow screeners containing a specific stock
 */
export async function findEtScreenersByStock(symbol: string): Promise<Array<{
  screener_id: string;
  screener_name: string;
}>> {
  try {
    if (!symbol) return [];

    return await dbAll<{
      screener_id: string;
      screener_name: string;
    }>(`
      SELECT es.screener_id, es.screener_name
      FROM etnow_screeners es
      JOIN etnow_screener_stocks ess ON es.screener_id = ess.screener_id
      WHERE ess.symbol = ?
    `, [symbol]);
  } catch (error) {
    console.error(`❌ Error finding ETNow screeners for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get all stocks from a specific ETNow screener
 */
export async function getETnowScreenerStocks(screenerId: string): Promise<Array<{
  symbol: string;
  stock_name: string;
}>> {
  try {
    return await dbAll<{
      symbol: string;
      stock_name: string;
    }>(`
      SELECT symbol, stock_name
      FROM etnow_screener_stocks
      WHERE screener_id = ?
      ORDER BY symbol
    `, [screenerId]);
  } catch (error) {
    console.error(`❌ Error fetching stocks for ETNow screener ${screenerId}:`, error);
    return [];
  }
}
