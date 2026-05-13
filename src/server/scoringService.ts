import { exec } from 'child_process';
import path from 'path';
import db from './db';
import { syncAllScreenerStocksToDB } from './trendlyneScreener';
import { syncMoneyControlScreeners } from './moneycontrolScreener';

export interface ScoredStock {
  symbol: string;
  timeframe: string;
  stock_id: string;
  score: number;
  confidence: number;
  classification: string;
  positive_count: number;
  negative_count: number;
  reasons: Array<{ name: string; sentiment: string; source: string }>;
  last_updated: string;
}

export interface FactorBreakdown {
  symbol: string;
  timeframe: string;
  technical: number;
  fundamental: number;
  momentum: number;
  valuation: number;
  delivery: number;
  last_updated: string;
}

/**
 * Recalculate all stock scores by running the Python engine
 */
export async function recalculateScores(): Promise<{ success: boolean; message: string }> {
  return new Promise((resolve) => {
    const scriptPath = path.join(process.cwd(), 'src', 'server', 'scoring_engine.py');
    console.log(`🚀 Running AlphaQuant Scoring Engine v2: python "${scriptPath}"`);

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
export function getTopRatedStocks(limit: number = 50, timeframe: string = 'long_term'): ScoredStock[] {
  try {
    const stmt = db.prepare(`
      SELECT * FROM stock_scores 
      WHERE timeframe = ?
      ORDER BY score DESC 
      LIMIT ?
    `);
    const rows = stmt.all(timeframe, limit) as any[];
    
    return rows.map(row => ({
      ...row,
      reasons: JSON.parse(row.reasons || '[]')
    }));
  } catch (error) {
    console.error('❌ Error fetching top rated stocks:', error);
    return [];
  }
}

/**
 * Get detailed score and factor breakdown for a specific stock
 */
export function getStockScoreDetail(symbol: string, timeframe: string = 'long_term'): { score: ScoredStock; factors: FactorBreakdown } | null {
  try {
    const scoreRow = db.prepare('SELECT * FROM stock_scores WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe) as any;
    if (!scoreRow) return null;

    const factorRow = db.prepare('SELECT * FROM stock_factor_breakdown WHERE symbol = ? AND timeframe = ?').get(symbol, timeframe) as any;
    
    return {
      score: {
        ...scoreRow,
        reasons: JSON.parse(scoreRow.reasons || '[]')
      },
      factors: factorRow || {
        symbol,
        timeframe,
        technical: 0,
        fundamental: 0,
        momentum: 0,
        valuation: 0,
        delivery: 0,
        last_updated: new Date().toISOString()
      }
    };
  } catch (error) {
    console.error(`❌ Error fetching score details for ${symbol} (${timeframe}):`, error);
    return null;
  }
}
