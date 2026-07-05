import { dbAll, dbRun } from './dbAsync';
import { runPython } from './pythonRunner';
import { analyzeCompanyProfile, releaseOllamaModel } from '../services/aiService';

export async function syncAndAnalyzeCompanyProfiles() {
  console.log('[PROFILE SYNC] Fetching Trendlyne overview + company descriptions (also feeds the ML overview features)...');

  // trendlyne_overview_fetcher.py fetches overview-second-part once per stock and writes
  // both the ML-facing financial/shareholding/analyst fields AND the company description
  // into trendlyne_stock_profile — this used to be duplicated by a second, independent
  // Trendlyne call from this file (fetchCompanyOverview), 8.5 hours apart, same endpoint,
  // same ~3,022-stock universe. Reading from the DB instead removes that duplicate call.
  await runPython('trendlyne_overview_fetcher.py', [], 70 * 60_000);

  const stocks = await dbAll<{ symbol: string; name: string; company_description: string | null }>(`
    SELECT tsp.symbol, ns.name, tsp.company_description
    FROM trendlyne_stock_profile tsp
    JOIN nse_stocks ns ON ns.symbol = tsp.symbol
    WHERE tsp.date = (SELECT MAX(date) FROM trendlyne_stock_profile tsp2 WHERE tsp2.symbol = tsp.symbol)
  `);

  console.log(`[PROFILE SYNC] Found ${stocks.length} stocks with an overview snapshot.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];

    if (!stock.company_description) {
      failCount++;
      continue;
    }

    try {
      console.log(`[PROFILE SYNC] (${i + 1}/${stocks.length}) Analyzing ${stock.symbol}...`);
      const analysis = await analyzeCompanyProfile(stock.symbol, stock.company_description);

      if (analysis.error) {
        console.warn(`[PROFILE SYNC] AI Analysis failed for ${stock.symbol}. Storing default.`);
      }

      await dbRun(`
        INSERT INTO company_profiles (
          symbol, company_name, description, high_growth_scope,
          in_news_for_growth, growth_score, ai_analysis, last_updated
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(symbol) DO UPDATE SET
          company_name = excluded.company_name,
          description = excluded.description,
          high_growth_scope = excluded.high_growth_scope,
          in_news_for_growth = excluded.in_news_for_growth,
          growth_score = excluded.growth_score,
          ai_analysis = excluded.ai_analysis,
          last_updated = CURRENT_TIMESTAMP
      `, [
        stock.symbol,
        stock.name,
        stock.company_description,
        analysis.high_growth_scope ? 1 : 0,
        analysis.in_news_for_growth ? 1 : 0,
        analysis.growth_score || 0,
        analysis.reasoning || ''
      ]);

      successCount++;
    } catch (err: any) {
      console.error(`[PROFILE SYNC] Error processing ${stock.symbol}:`, err.message);
      failCount++;
    }
  }

  console.log(`[PROFILE SYNC] Completed. Success: ${successCount}, Failed: ${failCount}`);
  await releaseOllamaModel();
  return { success: true, processed: successCount, failed: failCount };
}
