import { dbTransaction } from './dbAsync';
import { fetchNiftyTraderStockData } from './niftytraderService';
import { getAllStocks } from './stockMapping';

export async function syncNiftyTraderScores() {
  const stocks = getAllStocks().slice(0, 50); // Just top 50 for now or Nifty50
  const date = new Date().toISOString().split('T')[0];
  console.log(`[NIFTYTRADER SCORES] Starting sync for ${stocks.length} symbols...`);

  let count = 0;
  for (const stock of stocks) {
    const data = await fetchNiftyTraderStockData(stock.symbol);
    if (!data) continue;

    const stockTrend = data.analysisData?.stocktrend;
    if (stockTrend) {
      // Calculate a simple Tech Score (-5 to +5) based on Moving averages and performance
      let techScore = 0;
      if (stockTrend.close > stockTrend.sma_20_days) techScore += 1;
      else techScore -= 1;
      if (stockTrend.close > stockTrend.sma_50_days) techScore += 1;
      else techScore -= 1;
      if (stockTrend.close > stockTrend.sma_200_days) techScore += 2;
      else techScore -= 2;
      if (stockTrend.performance_20_days > 0) techScore += 1;
      else techScore -= 1;

      // Map -5..+5 to 0..100
      const normalizedScore = (techScore + 5) * 10;
      let label = 'Neutral';
      if (normalizedScore >= 80) label = 'Very Bullish';
      else if (normalizedScore >= 60) label = 'Bullish';
      else if (normalizedScore <= 20) label = 'Very Bearish';
      else if (normalizedScore <= 40) label = 'Bearish';

      await dbTransaction(async (tx) => {
        await tx.run(`
          INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
          VALUES (?, ?, 'niftytrader', 'technical_rating', ?, ?)
          ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
            score_value = excluded.score_value,
            score_label = excluded.score_label,
            updated_at  = CURRENT_TIMESTAMP
        `, [stock.symbol, date, normalizedScore, label]);
      });
      count++;
    }
    
    const finScore = data.financialData?.fin_score;
    if (finScore !== undefined && finScore !== null) {
        await dbTransaction(async (tx) => {
          await tx.run(`
            INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
            VALUES (?, ?, 'niftytrader', 'financial_score', ?, ?)
            ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
              score_value = excluded.score_value,
              score_label = excluded.score_label,
              updated_at  = CURRENT_TIMESTAMP
          `, [stock.symbol, date, finScore, '']);
        });
    }

    // sleep briefly
    await new Promise(r => setTimeout(r, 200));
  }
  
  console.log(`[NIFTYTRADER SCORES] Synced ${count} scores.`);
}
