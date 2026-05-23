import db from './db';

function persistStrategySignal(
  symbol: string,
  signalType: string,
  score: number,
  detail: string,
): void {
  try {
    const today = new Date().toISOString().slice(0, 10);
    const existing = db.prepare(
      `SELECT 1 FROM technical_signals WHERE symbol = ? AND date = ?`
    ).get(symbol, today);
    if (existing) return;

    db.prepare(`
      INSERT INTO technical_signals
        (symbol, date, signals_json, signal_score, computed_at)
      VALUES
        (@symbol, @date, @signals_json, @signal_score, CURRENT_TIMESTAMP)
      ON CONFLICT(symbol, date) DO NOTHING
    `).run({
      symbol,
      date: today,
      signals_json: JSON.stringify([{ type: signalType, strength: 'MEDIUM', detail }]),
      signal_score: Math.min(10, Math.max(1, Math.round(score / 10))),
    });
  } catch { /* non-fatal — signal still returned to caller */ }
}

export interface ConvergenceSignal {
  symbol: string;
  score: number;
  trendlyneBullishCount: number;
  mcPositiveCount: number;
  etPositiveCount: number;
  classification: string;
}

export function crossSourceFilter(minScore = 65): ConvergenceSignal[] {
  try {
    const tlBullish = new Set<string>(
      (db.prepare(`
        SELECT DISTINCT tss.symbol
        FROM trendlyne_screener_stocks tss
        JOIN screener_master sm ON sm.scan_id = tss.screener_id
        WHERE sm.inferred_sentiment = 'bullish' AND tss.symbol IS NOT NULL
      `).all() as { symbol: string }[]).map(r => r.symbol)
    );

    const mcPositive = new Set<string>(
      (db.prepare(`
        SELECT DISTINCT mss.symbol
        FROM moneycontrol_screener_stocks mss
        JOIN moneycontrol_screeners ms ON ms.scan_id = mss.scan_id
        WHERE ms.is_positive = 1 AND mss.symbol IS NOT NULL
      `).all() as { symbol: string }[]).map(r => r.symbol)
    );

    const etPositive = new Set<string>(
      (db.prepare(`
        SELECT DISTINCT ess.symbol
        FROM etnow_screener_stocks ess
        LEFT JOIN screener_master sm ON sm.scan_id = ess.screener_id
        WHERE (sm.inferred_sentiment IS NULL OR sm.inferred_sentiment != 'bearish')
          AND ess.symbol IS NOT NULL
      `).all() as { symbol: string }[]).map(r => r.symbol)
    );

    const scoreRows = db.prepare(`
      SELECT symbol, score, classification, positive_count, negative_count
      FROM stock_scores
      WHERE timeframe = 'long_term' AND score >= ? AND negative_count = 0
        AND classification IN ('Buy', 'Strong Buy')
      ORDER BY score DESC
    `).all(minScore) as {
      symbol: string; score: number; classification: string;
      positive_count: number; negative_count: number;
    }[];

    const results: ConvergenceSignal[] = [];
    for (const row of scoreRows) {
      if (!tlBullish.has(row.symbol) || !mcPositive.has(row.symbol) || !etPositive.has(row.symbol)) continue;
      results.push({
        symbol: row.symbol,
        score: row.score,
        trendlyneBullishCount: 1,
        mcPositiveCount: 1,
        etPositiveCount: 1,
        classification: row.classification,
      });
      persistStrategySignal(
        row.symbol,
        'CONVERGENCE_SIGNAL',
        row.score,
        'Multi-source convergence: bullish in Trendlyne + MoneyControl + ETnow simultaneously',
      );
    }
    return results;
  } catch (err: any) {
    console.error('[STRATEGY] crossSourceFilter error:', err.message);
    return [];
  }
}

export interface RegimeSectorSignal {
  symbol: string;
  sector: string;
  score: number;
  winProbability: number | null;
  classification: string;
  regime: string;
}

export function regimeSectorFilter(topNSectors = 3, minScore = 60, minWinProbability = 0.50): RegimeSectorSignal[] {
  try {
    const regimeRow = db.prepare(`
      SELECT nifty_regime FROM technical_signals
      WHERE nifty_regime IS NOT NULL
      ORDER BY date DESC LIMIT 1
    `).get() as { nifty_regime: string } | undefined;
    const regime = regimeRow?.nifty_regime ?? 'SIDEWAYS';

    if (regime !== 'BULL') return [];

    const sectorScores = db.prepare(`
      SELECT ns.sector, AVG(ss.score) AS avg_score, COUNT(*) AS cnt
      FROM stock_scores ss
      JOIN nse_stocks ns ON ns.symbol = ss.symbol
      WHERE ss.timeframe = 'long_term'
        AND ss.classification IN ('Buy', 'Strong Buy')
        AND ns.sector IS NOT NULL AND ns.sector != ''
      GROUP BY ns.sector
      HAVING cnt >= 3
      ORDER BY avg_score DESC
      LIMIT ?
    `).all(topNSectors) as { sector: string; avg_score: number; cnt: number }[];

    if (sectorScores.length === 0) return [];
    const topSectorSet = new Set(sectorScores.map(s => s.sector));

    // win_probability added via db migration at line 720 in db.ts
    const wpRows = db.prepare(`
      SELECT symbol, MAX(win_probability) AS wp
      FROM technical_signals
      WHERE win_probability IS NOT NULL
        AND date >= date('now', '-7 days')
      GROUP BY symbol
    `).all() as { symbol: string; wp: number }[];
    const wpMap = new Map(wpRows.map(r => [r.symbol, r.wp]));

    const stockRows = db.prepare(`
      SELECT ss.symbol, ss.score, ss.classification, ns.sector
      FROM stock_scores ss
      JOIN nse_stocks ns ON ns.symbol = ss.symbol
      WHERE ss.timeframe = 'long_term'
        AND ss.score >= ?
        AND ss.classification IN ('Buy', 'Strong Buy')
        AND ns.sector IS NOT NULL
      ORDER BY ss.score DESC
    `).all(minScore) as { symbol: string; score: number; classification: string; sector: string }[];

    const results: RegimeSectorSignal[] = [];
    for (const row of stockRows) {
      if (!topSectorSet.has(row.sector)) continue;
      const wp = wpMap.get(row.symbol) ?? null;
      if (wp !== null && wp < minWinProbability) continue;
      results.push({
        symbol: row.symbol,
        sector: row.sector,
        score: row.score,
        winProbability: wp,
        classification: row.classification,
        regime,
      });
      persistStrategySignal(
        row.symbol,
        'REGIME_SECTOR_SIGNAL',
        row.score,
        `BULL regime sector rotation signal — sector: ${row.sector}`,
      );
    }
    return results;
  } catch (err: any) {
    console.error('[STRATEGY] regimeSectorFilter error:', err.message);
    return [];
  }
}

export interface QualityOversoldSignal {
  symbol: string;
  rsi: number | null;
  score: number;
  classification: string;
  qualityScreener: string;
}

export function qualityOversoldScanner(maxRsi = 35, maxScore = 65): QualityOversoldSignal[] {
  try {
    const qualityRows = db.prepare(`
      SELECT ess.symbol, es.screener_name
      FROM etnow_screener_stocks ess
      JOIN etnow_screeners es ON es.screener_id = ess.screener_id
      WHERE ess.screener_id IN ('et-79', 'et-73') AND ess.symbol IS NOT NULL
    `).all() as { symbol: string; screener_name: string }[];
    const qualityMap = new Map(qualityRows.map(r => [r.symbol, r.screener_name]));

    if (qualityMap.size === 0) return [];

    const rsiRows = db.prepare(`
      SELECT symbol, rsi FROM technical_analysis_signals
      WHERE rsi <= ? AND symbol IS NOT NULL
    `).all(maxRsi) as { symbol: string; rsi: number }[];
    const rsiMap = new Map(rsiRows.map(r => [r.symbol, r.rsi]));

    const et362Symbols = new Set<string>(
      (db.prepare(`
        SELECT symbol FROM etnow_screener_stocks
        WHERE screener_id = 'et-362' AND symbol IS NOT NULL
      `).all() as { symbol: string }[]).map(r => r.symbol)
    );

    const scoreRows = db.prepare(`
      SELECT symbol, score, classification, negative_count
      FROM stock_scores
      WHERE timeframe = 'long_term' AND score >= 40 AND score <= ? AND negative_count = 0
    `).all(maxScore) as { symbol: string; score: number; classification: string; negative_count: number }[];
    const scoreMap = new Map(scoreRows.map(r => [r.symbol, r]));

    const results: QualityOversoldSignal[] = [];
    for (const [symbol, screenerName] of qualityMap) {
      const isOversold = rsiMap.has(symbol) || et362Symbols.has(symbol);
      if (!isOversold) continue;
      const scoreData = scoreMap.get(symbol);
      if (!scoreData) continue;
      results.push({
        symbol,
        rsi: rsiMap.get(symbol) ?? null,
        score: scoreData.score,
        classification: scoreData.classification,
        qualityScreener: screenerName,
      });
      persistStrategySignal(
        symbol,
        'QUALITY_OVERSOLD_SIGNAL',
        scoreData.score,
        `Quality oversold entry: RSI ${rsiMap.get(symbol) ?? 'N/A'} in ${screenerName}`,
      );
    }
    results.sort((a, b) => (a.rsi ?? 99) - (b.rsi ?? 99));
    return results;
  } catch (err: any) {
    console.error('[STRATEGY] qualityOversoldScanner error:', err.message);
    return [];
  }
}
