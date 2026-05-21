import db from './db';
import { fetchETnowScreener } from './etnow';
import { getSymbolFromMcsymbol } from './stockMapping';

/**
 * Sync ETNow screeners data and populate etnow_screener_stocks table.
 * Fetches stocks for each ETNow screener and inserts them into the DB.
 * Follows the pattern from moneycontrolScreener.ts and trendlyneScreener.ts.
 */
export async function syncETnowScreeners(): Promise<void> {
  console.log('🔄 Starting ETNow screener synchronization...');

  const screeners = db.prepare(`
    SELECT screener_id, screener_name FROM etnow_screeners
  `).all() as Array<{ screener_id: string; screener_name: string }>;

  if (screeners.length === 0) {
    console.warn('⚠️  No ETNow screeners found in database. Run initEtnowScreeners() first.');
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

      // Fetch screener data from ETNow API
      const response = await fetchETnowScreener(screener.screener_id, '');
      
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
          // ETNow API returns data in various formats depending on screener
          const stockName = record.name || record.companyName || record.stock_name || record.shortName || '';
          const stockSymbol = record.stkId || record.symbol || record.code || record.nseid || '';

          if (stockSymbol) {
            // Try to resolve to NSE symbol if it's a different format
            const nseSymbol = stockSymbol.includes('-NSE') 
              ? stockSymbol.replace('-NSE', '')
              : stockSymbol;

            insertStmt.run(screener.screener_id, nseSymbol, stockName);
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
