import { dbTransaction } from './dbAsync';
import { fetchNiftyTraderStockData } from './niftytraderService';
import { getAllStocks } from './stockMapping';
import { fetchTrendlyneDVM, fetchTrendlyneChecklist } from './trendlyneService';

export async function syncNiftyTraderScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[NIFTYTRADER SCORES] Starting sync for ${stocks.length} symbols...`);

  const baseDelay = Number(process.env.TRENDLYNE_BASE_DELAY_MS || '400');
  const jitterPercent = Number(process.env.TRENDLYNE_JITTER_PERCENT || '20');

  let count = 0;
  let consecutiveFailures = 0;
  for (const stock of stocks) {
    try {
      const data = await fetchNiftyTraderStockData(stock.symbol);
      if (!data) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          console.warn(`[NIFTYTRADER SCORES] 5 consecutive failures. Cool down for 30s...`);
          await new Promise(r => setTimeout(r, 30000));
          consecutiveFailures = 0;
        }
        continue;
      }
      consecutiveFailures = 0;

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
    } catch (e: any) {
      console.error(`[NIFTYTRADER SCORES] Error for ${stock.symbol}:`, e.message);
    }

    // Jittered sleep to evade rate limits
    const min = baseDelay * (1 - jitterPercent / 100);
    const max = baseDelay * (1 + jitterPercent / 100);
    const ms = Math.random() * (max - min) + min;
    await new Promise(r => setTimeout(r, ms));
  }
  
  console.log(`[NIFTYTRADER SCORES] Synced ${count} scores.`);
}

export async function syncTrendlyneScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[TRENDLYNE SCORES] Starting sync for ${stocks.length} symbols...`);

  const baseDelay = Number(process.env.TRENDLYNE_BASE_DELAY_MS || '500');
  const jitterPercent = Number(process.env.TRENDLYNE_JITTER_PERCENT || '15');

  let count = 0;
  let consecutiveFailures = 0;
  for (const stock of stocks) {
    if (!stock.tlid) {
      continue;
    }

    try {
      // 1. Fetch DVM
      const dvm = await fetchTrendlyneDVM(stock.symbol);
      
      // 2. Fetch Checklist
      const checklist = await fetchTrendlyneChecklist(stock.symbol);

      if (!dvm && !checklist) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          console.warn(`[TRENDLYNE SCORES] 5 consecutive failures. Cool down for 30s...`);
          await new Promise(r => setTimeout(r, 30000));
          consecutiveFailures = 0;
        }
        continue;
      }
      consecutiveFailures = 0;

      if (dvm) {
        for (const type of ['quality', 'valuation', 'momentum', 'durability']) {
          const data = dvm[type];
          if (data) {
            await dbTransaction(async (tx) => {
              await tx.run(`
                INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
                VALUES (?, ?, 'trendlyne', ?, ?, ?)
                ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                  score_value = excluded.score_value,
                  score_label = excluded.score_label,
                  updated_at  = CURRENT_TIMESTAMP
              `, [stock.symbol, date, type, data.score, data.insight || '']);
            });
          }
        }
      }

      if (checklist && checklist.score !== undefined) {
        await dbTransaction(async (tx) => {
          await tx.run(`
            INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
            VALUES (?, ?, 'trendlyne', 'checklist', ?, ?)
            ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
              score_value = excluded.score_value,
              score_label = excluded.score_label,
              updated_at  = CURRENT_TIMESTAMP
          `, [stock.symbol, date, checklist.score, checklist.insight || '']);
        });
      }

      count++;
    } catch (e: any) {
      console.error(`[TRENDLYNE SCORES] Error for ${stock.symbol}:`, e.message);
    }

    // Jittered sleep to evade rate limits
    const min = baseDelay * (1 - jitterPercent / 100);
    const max = baseDelay * (1 + jitterPercent / 100);
    const ms = Math.random() * (max - min) + min;
    await new Promise(r => setTimeout(r, ms));
  }
  
  console.log(`[TRENDLYNE SCORES] Synced ${count} stocks.`);
}
