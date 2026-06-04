import db from './db';
import { fetchCompanyOverview } from './trendlyneService';
import { analyzeCompanyProfile } from '../services/aiService';

export async function syncAndAnalyzeCompanyProfiles() {
  console.log('[PROFILE SYNC] Starting weekly company profile sync and AI analysis...');

  // Fetch all stocks with a mapped TLID
  const stocks = db.prepare(`
    SELECT symbol, name, tlid
    FROM nse_stocks
    WHERE tlid IS NOT NULL AND tlid != ''
  `).all() as { symbol: string; name: string; tlid: string }[];

  console.log(`[PROFILE SYNC] Found ${stocks.length} stocks to process.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];
    console.log(`[PROFILE SYNC] (${i + 1}/${stocks.length}) Processing ${stock.symbol}...`);

    try {
      // 1. Fetch Company Overview from Trendlyne
      const overview = await fetchCompanyOverview(stock.symbol);
      const description = overview?.companyProfileData?.companyDescription;

      if (!description) {
        console.warn(`[PROFILE SYNC] No profile description found for ${stock.symbol}. Skipping.`);
        failCount++;
        continue;
      }

      // 2. Perform Ollama AI Analysis
      const analysis = await analyzeCompanyProfile(stock.symbol, description);

      if (analysis.error) {
        console.warn(`[PROFILE SYNC] AI Analysis failed for ${stock.symbol}. Storing default.`);
      }

      // 3. Upsert into database
      db.prepare(`
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
      `).run(
        stock.symbol,
        stock.name,
        description,
        analysis.high_growth_scope ? 1 : 0,
        analysis.in_news_for_growth ? 1 : 0,
        analysis.growth_score || 0,
        analysis.reasoning || ''
      );

      successCount++;
      
      // Delay slightly between requests to not overwhelm local Ollama or APIs
      await new Promise(resolve => setTimeout(resolve, 2000));
    } catch (err: any) {
      console.error(`[PROFILE SYNC] Error processing ${stock.symbol}:`, err.message);
      failCount++;
    }
  }

  console.log(`[PROFILE SYNC] Completed. Success: ${successCount}, Failed: ${failCount}`);
  return { success: true, processed: successCount, failed: failCount };
}
