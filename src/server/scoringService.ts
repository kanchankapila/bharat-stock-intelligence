import { exec } from 'child_process';
import path from 'path';
import db from './db';
import { syncAllScreenerStocksToDB } from './trendlyneScreener';
import { syncMoneyControlScreeners } from './moneycontrolScreener';

export interface ScoredStock {
  symbol: string;
  stock_id: string;
  score: number;
  positive_count: number;
  negative_count: number;
  reasons: Array<{ name: string; sentiment: string }>;
  last_updated: string;
}

/**
 * Recalculate all stock scores by running the Python engine
 */
export async function recalculateScores(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), 'src', 'server', 'scoring_engine.py');
    console.log(`🚀 Running scoring engine: python "${scriptPath}"`);

    exec(`python "${scriptPath}"`, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ Scoring engine error: ${error.message}`);
        return resolve({ success: false, message: error.message });
      }
      if (stderr) {
        console.warn(`⚠️ Scoring engine warning: ${stderr}`);
      }
      console.log(`✅ Scoring engine output: ${stdout}`);
      resolve({ success: true, message: stdout });
    });
  });
}

/**
 * Perform a full sync and then recalculate scores
 */
export async function syncAndScore(): Promise<{ success: boolean; message: string }> {
  console.log('🔄 Initiating full sync and score process...');
  
  const syncResult = await syncAllScreenerStocksToDB();
  if (!syncResult.success) {
    console.error(`Trendlyne sync failed: ${syncResult.error}`);
  }
  
  try {
    await syncMoneyControlScreeners();
  } catch (err: any) {
    console.error(`MoneyControl sync failed: ${err.message}`);
  }
  
  const scoreResult = await recalculateScores();
  return scoreResult;
}

/**
 * Get top rated stocks from the database
 */
export function getTopRatedStocks(limit: number = 50): ScoredStock[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM stock_scores 
      ORDER BY score DESC 
      LIMIT ?
    `);
    const rows = stmt.all(limit) as any[];
    
    return rows.map(row => ({
      ...row,
      reasons: JSON.parse(row.reasons || '[]')
    }));
  } catch (error) {
    console.error('❌ Error fetching top rated stocks:', error);
    return [];
  }
}
