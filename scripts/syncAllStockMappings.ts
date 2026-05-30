import { nseStocksData } from '../src/data/nseStocks';
import { resolveMoneycontrolSymbol } from '../src/server/stockMapping';
import db from '../src/server/db';
import { getStockMapping } from '../src/server/stockMapping';

const BATCH_SIZE = 50;
const DELAY_MS = 500;

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function syncMappings() {
  console.log(`Starting sync for ${nseStocksData.length} stocks...`);
  
  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const stock of nseStocksData) {
    const symbol = stock.symbol;
    
    // Check if mapping already exists in db
    const row = db.prepare('SELECT mcsymbol, tlid, tlname FROM nse_stocks WHERE symbol = ?').get(symbol) as any;
    
    // Also check static mapping
    const staticMap = getStockMapping(symbol);

    let mcsymbol = row?.mcsymbol || staticMap?.mcsymbol;
    let tlid = row?.tlid || staticMap?.tlid;
    let tlname = row?.tlname || staticMap?.tlname;

    let needsUpdate = false;

    // 1. Resolve Moneycontrol Symbol if missing
    if (!mcsymbol) {
      try {
        const resolvedMc = await resolveMoneycontrolSymbol(symbol);
        if (resolvedMc) {
          mcsymbol = resolvedMc;
          needsUpdate = true;
          console.log(`[MC] Resolved ${symbol} -> ${mcsymbol}`);
        }
      } catch (err) {
        console.error(`[MC] Failed to resolve ${symbol}`);
      }
      // Delay to avoid hitting rate limits
      await sleep(DELAY_MS);
    }

    // 2. Resolve Trendlyne ID if missing (from existing screener table)
    if (!tlid) {
      const tlRow = db.prepare('SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?').get(symbol) as { stock_id: string } | undefined;
      if (tlRow?.stock_id) {
        tlid = tlRow.stock_id;
        needsUpdate = true;
        console.log(`[TL] Found ${symbol} -> ${tlid} in screener cache`);
      }
    }

    if (needsUpdate || (mcsymbol && !row?.mcsymbol) || (tlid && !row?.tlid)) {
      try {
        db.prepare(`
          UPDATE nse_stocks 
          SET mcsymbol = ?, tlid = ?, tlname = ? 
          WHERE symbol = ?
        `).run(mcsymbol || null, tlid || null, tlname || null, symbol);
        
        // Ensure the row exists just in case (though it should if nse_stocks is populated)
        // If row doesn't exist, we might need to insert it
        const checkRow = db.prepare('SELECT id FROM nse_stocks WHERE symbol = ?').get(symbol);
        if (!checkRow) {
           db.prepare(`
             INSERT INTO nse_stocks (symbol, name, sector, industry, isin, listing_date, mcsymbol, tlid, tlname)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
           `).run(symbol, stock.name, stock.sector, stock.industry, stock.isin, stock.listing_date, mcsymbol || null, tlid || null, tlname || null);
        }
        
        updatedCount++;
      } catch (e: any) {
        console.error(`Failed to update DB for ${symbol}: ${e.message}`);
        failedCount++;
      }
    } else {
      skippedCount++;
    }
  }

  console.log('--- Sync Complete ---');
  console.log(`Updated: ${updatedCount}`);
  console.log(`Skipped: ${skippedCount}`);
  console.log(`Failed:  ${failedCount}`);
}

syncMappings().catch(console.error);
