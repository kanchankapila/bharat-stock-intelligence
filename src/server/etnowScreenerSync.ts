import db from './db';
import { fetchETnowScreener } from './etnow';
import { getSymbolFromMcsymbol } from './stockMapping';

export function getETnowStockCount(): number {
  try {
    return (db.prepare('SELECT COUNT(*) as n FROM etnow_screener_stocks').get() as { n: number }).n;
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

  let screeners = db.prepare(`
    SELECT screener_id, screener_name, query_condition FROM etnow_screeners
  `).all() as Array<{ screener_id: string; screener_name: string; query_condition: string | null }>;

  if (screeners.length === 0) {
    console.log('[SYNC] etnow_screeners is empty — seeding definitions with initEtnowScreeners()...');
    const { initEtnowScreeners } = await import('./etnow');
    initEtnowScreeners();
    screeners = db.prepare(`
      SELECT screener_id, screener_name, query_condition FROM etnow_screeners
    `).all() as Array<{ screener_id: string; screener_name: string; query_condition: string | null }>;
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

  const deleteStmt = db.prepare(`
    DELETE FROM etnow_screener_stocks WHERE screener_id = ?
  `);

  const insertStmt = db.prepare(`
    INSERT OR IGNORE INTO etnow_screener_stocks (screener_id, symbol, stock_name)
    VALUES (?, ?, ?)
  `);

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

      // Clear existing stocks for this screener
      db.transaction(() => {
        deleteStmt.run(screener.screener_id);

        // Insert each stock
        for (const record of records) {
          const stockName = record.assetName || record.name || record.companyName || record.stock_name || record.shortName || '';
          const rawSymbol = record.assetSymbol || record.stkId || record.symbol || record.code || record.nseid || '';

          if (rawSymbol) {
            // assetSymbol comes as e.g. "COALINDIAEQ" — strip exchange suffix
            const nseSymbol = rawSymbol
              .replace(/-NSE$/i, '')
              .replace(/EQ$/i, '')
              .replace(/BE$/i, '')
              .trim();

            if (nseSymbol) insertStmt.run(screener.screener_id, nseSymbol, stockName);
          }
        }
      })();

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
export function findEtScreenersByStock(symbol: string): Array<{
  screener_id: string;
  screener_name: string;
}> {
  try {
    if (!symbol) return [];

    const stmt = db.prepare(`
      SELECT es.screener_id, es.screener_name
      FROM etnow_screeners es
      JOIN etnow_screener_stocks ess ON es.screener_id = ess.screener_id
      WHERE ess.symbol = ?
    `);

    return stmt.all(symbol) as Array<{
      screener_id: string;
      screener_name: string;
    }>;
  } catch (error) {
    console.error(`❌ Error finding ETNow screeners for ${symbol}:`, error);
    return [];
  }
}

/**
 * Get all stocks from a specific ETNow screener
 */
export function getETnowScreenerStocks(screenerId: string): Array<{
  symbol: string;
  stock_name: string;
}> {
  try {
    const stmt = db.prepare(`
      SELECT symbol, stock_name
      FROM etnow_screener_stocks
      WHERE screener_id = ?
      ORDER BY symbol
    `);

    return stmt.all(screenerId) as Array<{
      symbol: string;
      stock_name: string;
    }>;
  } catch (error) {
    console.error(`❌ Error fetching stocks for ETNow screener ${screenerId}:`, error);
    return [];
  }
}
