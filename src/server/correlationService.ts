/**
 * Portfolio-Signal Correlation Service (PHASE 3.4)
 * 
 * Analyzes correlation between incoming signals and user's portfolio holdings.
 * Identifies:
 * - Hedge opportunities (negative correlation)
 * - Momentum aligned trades (positive correlation)
 * - Risk concentration (high correlation with portfolio)
 */

import { dbGet, dbAll, dbRun } from './dbAsync';

export interface PortfolioHolding {
  symbol: string;
  weight: number;  // 0-1, portfolio allocation
  quantity: number;
  avgCost: number;
  currentPrice: number;
}

export interface SignalPortfolioCorrelation {
  signalId: number;
  portfolioSymbol: string;
  correlationScore: number;  // -1 to 1
  coMovementPct: number;
  hedgePotential: boolean;
  momentumAlignment: boolean;
}

export class CorrelationService {
  /**
   * Calculate Pearson correlation between two price series
   */
  public calculatePearsonCorrelation(pricesA: number[], pricesB: number[]): number {
    if (pricesA.length < 2 || pricesB.length < 2) return 0;

    const meanA = pricesA.reduce((a, b) => a + b) / pricesA.length;
    const meanB = pricesB.reduce((a, b) => a + b) / pricesB.length;

    let covariance = 0;
    let varianceA = 0;
    let varianceB = 0;

    for (let i = 0; i < pricesA.length; i++) {
      const devA = pricesA[i] - meanA;
      const devB = pricesB[i] - meanB;
      covariance += devA * devB;
      varianceA += devA * devA;
      varianceB += devB * devB;
    }

    const denominator = Math.sqrt(varianceA * varianceB);
    return denominator === 0 ? 0 : covariance / denominator;
  }

  /**
   * Calculate co-movement percentage (% time both move in same direction)
   */
  public calculateCoMovementPct(pricesA: number[], pricesB: number[]): number {
    if (pricesA.length < 2 || pricesB.length < 2) return 0;

    let coMovementCount = 0;
    for (let i = 1; i < pricesA.length; i++) {
      const changeA = pricesA[i] - pricesA[i - 1];
      const changeB = pricesB[i] - pricesB[i - 1];
      if ((changeA > 0 && changeB > 0) || (changeA < 0 && changeB < 0)) {
        coMovementCount++;
      }
    }
    return (coMovementCount / (pricesA.length - 1)) * 100;
  }

  /**
   * Get historical prices for a symbol (last 90 days)
   */
  private async getHistoricalPrices(symbol: string, days: number = 90): Promise<number[]> {
    try {
      const cutoff = new Date(Date.now() - days * 86400000).toISOString().slice(0, 10);
      const query = `
        SELECT close FROM stock_ohlcv
        WHERE symbol = ? AND date >= ?
        ORDER BY date ASC
        LIMIT ?
      `;
      const result = await dbAll<{ close: number }>(query, [symbol, cutoff, 1000]);
      return result.map(r => r.close);
    } catch (err) {
      console.error(`[CorrelationService] Failed to fetch prices for ${symbol}:`, err);
      return [];
    }
  }

  /**
   * Analyze signal's correlation with portfolio
   */
  public async analyzeSignalPortfolioAlignment(
    signalId: number,
    signalSymbol: string,
    portfolio: PortfolioHolding[],
    signalMomentum: number = 1,  // 1 for bullish, -1 for bearish
  ): Promise<SignalPortfolioCorrelation[]> {
    const correlations: SignalPortfolioCorrelation[] = [];
    const signalPrices = await this.getHistoricalPrices(signalSymbol);

    if (signalPrices.length < 30) {
      console.warn(`[CorrelationService] Insufficient data for ${signalSymbol}`);
      return correlations;
    }

    for (const holding of portfolio) {
      const holdingPrices = await this.getHistoricalPrices(holding.symbol);

      if (holdingPrices.length < 30) {
        continue;  // Skip holdings with insufficient data
      }

      // Align arrays to same length (use most recent overlapping data)
      const minLen = Math.min(signalPrices.length, holdingPrices.length);
      const signalSliced = signalPrices.slice(-minLen);
      const holdingSliced = holdingPrices.slice(-minLen);

      const correlation = this.calculatePearsonCorrelation(signalSliced, holdingSliced);
      const coMovement = this.calculateCoMovementPct(signalSliced, holdingSliced);

      // Determine hedge potential: negative correlation = hedge
      const hedgePotential = correlation < -0.2;

      // Determine momentum alignment: correlation * momentum > 0
      const momentumAlignment = correlation * signalMomentum > 0.2;

      correlations.push({
        signalId,
        portfolioSymbol: holding.symbol,
        correlationScore: parseFloat(correlation.toFixed(4)),
        coMovementPct: parseFloat(coMovement.toFixed(2)),
        hedgePotential,
        momentumAlignment,
      });

      // Store in database
      await this.storeCorrelation(
        signalId,
        holding.symbol,
        signalSymbol,
        holding.weight,
        correlation,
        coMovement,
        hedgePotential ? 1 : 0,
        momentumAlignment ? 1 : 0,
      );
    }

    return correlations.sort((a, b) => Math.abs(b.correlationScore) - Math.abs(a.correlationScore));
  }

  /**
   * Store correlation results in database
   */
  private async storeCorrelation(
    signalId: number,
    portfolioSymbol: string,
    signalSymbol: string,
    weight: number,
    correlationScore: number,
    coMovementPct: number,
    hedgePotential: number,
    momentumAlignment: number,
  ): Promise<void> {
    try {
      await dbRun(`
        INSERT INTO signal_portfolio_correlation (
          signal_id, portfolio_symbol, signal_symbol, weight,
          correlation_score, co_movement_pct, hedge_potential, momentum_alignment
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(signal_id, portfolio_symbol) DO UPDATE SET
          signal_symbol      = excluded.signal_symbol,
          weight             = excluded.weight,
          correlation_score  = excluded.correlation_score,
          co_movement_pct    = excluded.co_movement_pct,
          hedge_potential    = excluded.hedge_potential,
          momentum_alignment = excluded.momentum_alignment
      `, [
        signalId,
        portfolioSymbol,
        signalSymbol,
        weight,
        correlationScore,
        coMovementPct,
        hedgePotential,
        momentumAlignment,
      ]);
    } catch (err) {
      console.error('[CorrelationService] Failed to store correlation:', err);
    }
  }

  /**
   * Get portfolio alignment score for a signal (0-100)
   * Higher score = better alignment with portfolio
   */
  public async getPortfolioAlignmentScore(signalId: number): Promise<number> {
    try {
      const result = await dbGet<any>(`
        SELECT
          AVG(ABS(correlation_score)) as avg_correlation,
          SUM(CASE WHEN momentum_alignment = 1 THEN 1 ELSE 0 END) as aligned_count,
          COUNT(*) as total_count
        FROM signal_portfolio_correlation
        WHERE signal_id = ?
      `, [signalId]);

      if (!result || result.total_count === 0) return 50;  // Neutral if no portfolio

      // Score: 50 base + momentum alignment bonus - concentration penalty
      let score = 50;
      score += (result.aligned_count / result.total_count) * 30;  // +30 for full alignment
      score += Math.max(0, 20 - result.avg_correlation * 100);  // +20 for diversification

      return Math.min(100, Math.max(0, score));
    } catch (err) {
      console.error('[CorrelationService] Failed to calculate alignment score:', err);
      return 50;
    }
  }

  /**
   * Get hedge recommendations from portfolio
   */
  public async getHedgeRecommendations(signalId: number, limit: number = 5) {
    try {
      const result = await dbAll<any>(`
        SELECT portfolio_symbol, correlation_score, weight
        FROM signal_portfolio_correlation
        WHERE signal_id = ? AND hedge_potential = 1
        ORDER BY ABS(correlation_score) DESC
        LIMIT ?
      `, [signalId, limit]);

      return result || [];
    } catch (err) {
      console.error('[CorrelationService] Failed to get hedge recommendations:', err);
      return [];
    }
  }

  /**
   * Get concentration risk (similar symbols in portfolio + signal)
   */
  public async getConcentrationRisk(signalId: number): Promise<number> {
    try {
      const result = await dbGet<any>(`
        SELECT COUNT(*) as high_correlation_count
        FROM signal_portfolio_correlation
        WHERE signal_id = ? AND correlation_score > 0.7
      `, [signalId]);

      return result?.high_correlation_count || 0;
    } catch (err) {
      console.error('[CorrelationService] Failed to get concentration risk:', err);
      return 0;
    }
  }
}

export const correlationService = new CorrelationService();
