import { pathToFileURL } from 'node:url';
import { nseStocksData } from '../src/data/nseStocks';
import { resolveMoneycontrolSymbol, getStockMapping } from '../src/server/stockMapping';
import { dbGet, dbRun } from '../src/server/dbAsync';

const DELAY_MS = 500;

interface NseStocksRow {
  mcsymbol: string | null;
  tlid: string | null;
  tlname: string | null;
  stockid: string | null;
  companyid: string | null;
  tickertape_sid: string | null;
  fincode: string | null;
  scripcode: string | null;
}

async function sleep(ms: number) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

export async function syncMappings() {
  console.log(`Starting sync for ${nseStocksData.length} stocks...`);

  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (const stock of nseStocksData) {
    const symbol = stock.symbol;

    // Check if mapping already exists in db. Routed through dbAsync (Postgres/SQLite-aware) --
    // this script previously imported the raw better-sqlite3 handle from db.ts, so it only ever
    // wrote to the SQLite dev-fallback DB regardless of USE_POSTGRES and never reached production.
    const row = await dbGet<NseStocksRow>(
      'SELECT mcsymbol, tlid, tlname, stockid, companyid, tickertape_sid, fincode, scripcode FROM nse_stocks WHERE symbol = ?',
      [symbol],
    );

    // Also check static mapping (src/data/stocklist.ts)
    const staticMap = getStockMapping(symbol);

    let mcsymbol = row?.mcsymbol || staticMap?.mcsymbol;
    let tlid = row?.tlid || staticMap?.tlid;
    let tlname = row?.tlname || staticMap?.tlname;
    const stockid = row?.stockid || staticMap?.stockid;
    const companyid = row?.companyid || staticMap?.companyid;
    const tickertapeSid = row?.tickertape_sid || staticMap?.tickertape_sid;
    const fincode = row?.fincode || staticMap?.fincode;
    const scripcode = row?.scripcode || staticMap?.scripcode;

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
      const tlRow = await dbGet<{ stock_id: string }>(
        'SELECT DISTINCT stock_id FROM trendlyne_screener_stocks WHERE symbol = ?',
        [symbol],
      );
      if (tlRow?.stock_id) {
        tlid = tlRow.stock_id;
        needsUpdate = true;
        console.log(`[TL] Found ${symbol} -> ${tlid} in screener cache`);
      }
    }

    const gainedNewField =
      (mcsymbol && !row?.mcsymbol) || (tlid && !row?.tlid) ||
      (stockid && !row?.stockid) || (companyid && !row?.companyid) ||
      (tickertapeSid && !row?.tickertape_sid) || (fincode && !row?.fincode) ||
      (scripcode && !row?.scripcode);

    if (needsUpdate || gainedNewField) {
      try {
        await dbRun(
          `UPDATE nse_stocks
           SET mcsymbol = ?, tlid = ?, tlname = ?, stockid = ?, companyid = ?,
               tickertape_sid = ?, fincode = ?, scripcode = ?
           WHERE symbol = ?`,
          [mcsymbol || null, tlid || null, tlname || null, stockid || null, companyid || null,
           tickertapeSid || null, fincode || null, scripcode || null, symbol],
        );

        // Ensure the row exists just in case (though it should if nse_stocks is populated)
        const checkRow = await dbGet('SELECT id FROM nse_stocks WHERE symbol = ?', [symbol]);
        if (!checkRow) {
          await dbRun(
            `INSERT INTO nse_stocks
             (symbol, name, sector, industry, isin, listing_date, mcsymbol, tlid, tlname,
              stockid, companyid, tickertape_sid, fincode, scripcode)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [symbol, stock.name, stock.sector, stock.industry, stock.isin, stock.listing_date,
             mcsymbol || null, tlid || null, tlname || null, stockid || null, companyid || null,
             tickertapeSid || null, fincode || null, scripcode || null],
          );
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
  return { updatedCount, skippedCount, failedCount };
}

// Only auto-run when executed directly (`npm run sync:mappings` / `tsx scripts/...`) --
// exported separately so processNSESync (jobs/sync.jobs.ts) can import and call it instead
// of shelling out, matching how nseService.ts's syncNSEStocksToDatabase is already imported
// and called there rather than run as its own subprocess.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  syncMappings().catch(console.error);
}
