import { dbTransaction } from './dbAsync';
import { fetchNiftyTraderStockData } from './niftytraderService';
import { getAllStocks } from './stockMapping';
import { getTrendlyneDVMFromDb } from './trendlyneService';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jittered = (base: number, jitterPercent: number) => {
  const min = base * (1 - jitterPercent / 100);
  const max = base * (1 + jitterPercent / 100);
  return Math.random() * (max - min) + min;
};

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

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      const stockTrend = data.analysisData?.stocktrend;
      if (stockTrend) {
        let techScore = 0;
        if (stockTrend.close > stockTrend.sma_20_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_50_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_200_days) techScore += 2; else techScore -= 2;
        if (stockTrend.performance_20_days > 0) techScore += 1; else techScore -= 1;

        const normalizedScore = (techScore + 5) * 10;
        let label = 'Neutral';
        if (normalizedScore >= 80) label = 'Very Bullish';
        else if (normalizedScore >= 60) label = 'Bullish';
        else if (normalizedScore <= 20) label = 'Very Bearish';
        else if (normalizedScore <= 40) label = 'Bearish';

        stockUpserts.push([stock.symbol, date, 'technical_rating', normalizedScore, label]);
        count++;
      }

      const finScore = data.financialData?.fin_score;
      if (finScore !== undefined && finScore !== null) {
        stockUpserts.push([stock.symbol, date, 'financial_score', finScore, '']);
      }

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'niftytrader', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
      }
    } catch (e: any) {
      console.error(`[NIFTYTRADER SCORES] Error for ${stock.symbol}:`, e.message);
    }

    // Jittered sleep to evade rate limits
    await sleep(jittered(baseDelay, jitterPercent));
  }
  
  console.log(`[NIFTYTRADER SCORES] Synced ${count} scores.`);
}

export async function syncTrendlyneScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[TRENDLYNE SCORES] Starting sync for ${stocks.length} symbols...`);

  let count = 0;

  for (const stock of stocks) {
    try {
      // DVM comes from trendlyne_dvm_scores (no live request). Checklist now has
      // its own dedicated pipeline (trendlyne-checklist-cycle queue, see queues.ts) —
      // running it here too would create a second, uncontrolled 3,000-request burst
      // once a day, defeating the whole point of pacing it.
      const dvm = await getTrendlyneDVMFromDb(stock.symbol);

      if (!dvm) {
        continue;
      }

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      if (dvm) {
        for (const [type, leg] of Object.entries(dvm) as Array<[string, { score: number; color: string | null } | null]>) {
          if (leg) stockUpserts.push([stock.symbol, date, type, leg.score, leg.color || '']);
        }
      }

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'trendlyne', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
        count++;
      }
    } catch (e: any) {
      console.error(`[TRENDLYNE SCORES] Error for ${stock.symbol}:`, e.message);
    }
  }

  console.log(`[TRENDLYNE SCORES] Synced ${count} stocks.`);
}
