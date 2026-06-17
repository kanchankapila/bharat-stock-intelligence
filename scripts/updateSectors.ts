import db from '../src/server/db';
import { fetchMcEquityCash } from '../src/server/mcApiService';

const DELAY_MS = 150; // Delay in milliseconds between API requests to avoid rate limits

async function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function updateSectors() {
  console.log('Fetching stocks from database...');
  const stocks = db.prepare(`
    SELECT symbol, name, mcsymbol, sector, industry 
    FROM nse_stocks 
    WHERE mcsymbol IS NOT NULL AND mcsymbol != ''
  `).all() as { symbol: string; name: string; mcsymbol: string; sector: string | null; industry: string | null }[];

  console.log(`Found ${stocks.length} stocks with mapped MoneyControl symbols.`);

  let updatedCount = 0;
  let skippedCount = 0;
  let failedCount = 0;

  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];
    const { symbol, mcsymbol } = stock;
    const progress = `(${i + 1}/${stocks.length})`;

    try {
      // Fetch details from MoneyControl API
      const data = await fetchMcEquityCash(mcsymbol, symbol);

      if (!data) {
        console.warn(`${progress} ⚠️ [${symbol}] Failed to fetch cash details from MoneyControl.`);
        failedCount++;
        await sleep(DELAY_MS);
        continue;
      }

      const sector = data.main_sector?.trim() || '';
      const industry = data.newSubsector?.trim() || '';

      if (!sector && !industry) {
        console.warn(`${progress} ⚠️ [${symbol}] Sector/industry empty in API response.`);
        skippedCount++;
        await sleep(DELAY_MS);
        continue;
      }

      // Check if values actually changed to avoid redundant DB writes
      if (stock.sector === sector && stock.industry === industry) {
        console.log(`${progress} ⏭️ [${symbol}] Sector and industry are already up to date.`);
        skippedCount++;
        await sleep(DELAY_MS);
        continue;
      }

      // Update the stock record in the DB
      db.prepare(`
        UPDATE nse_stocks 
        SET sector = ?, industry = ?, last_updated = CURRENT_TIMESTAMP 
        WHERE symbol = ?
      `).run(sector, industry, symbol);

      console.log(`${progress} ✅ [${symbol}] Updated -> Sector: "${sector}" | Industry: "${industry}"`);
      updatedCount++;
    } catch (error: any) {
      console.error(`${progress} ❌ [${symbol}] Error: ${error.message}`);
      failedCount++;
    }

    await sleep(DELAY_MS);
  }

  console.log('\n--- Sector Update Complete ---');
  console.log(`Total Stocks Checked: ${stocks.length}`);
  console.log(`Successfully Updated: ${updatedCount}`);
  console.log(`Skipped (Up to date/No data): ${skippedCount}`);
  console.log(`Failed:               ${failedCount}`);
}

updateSectors().catch((err) => {
  console.error('Fatal error in sector updater script:', err);
});
