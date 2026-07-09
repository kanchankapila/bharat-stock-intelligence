import { z } from 'zod';
import { dbGet, dbAll } from '../dbAsync';
import { router, publicProcedure } from '../trpc';

// ── Types ─────────────────────────────────────────────────────────────────────

interface RiskRow {
  symbol: string;
  name: string | null;
  sector: string | null;
  // Risk metrics (from risk_metrics_engine.py)
  beta_1y: number | null;
  beta_6m: number | null;
  sortino_ratio: number | null;
  var_95: number | null;
  // Existing quant_scores risk fields (TypeScript worker)
  sharpe_ratio: number | null;
  annualized_vol: number | null;
  max_drawdown_1y: number | null;
  // Multi-factor scores (from multi_factor_scorer.py)
  mf_composite_score: number | null;
  mf_quality_score: number | null;
  mf_momentum_score: number | null;
  mf_value_score: number | null;
  mf_risk_adj_score: number | null;
  mf_macro_score: number | null;
  // Context
  rank_composite: number | null;
  composite_class: string | null;
}

// ── Risk tier classification ─────────────────────────────────────────────────

function riskTier(beta: number | null, vol: number | null, maxDD: number | null): string {
  // Composite risk: equally weighted z-score of beta, vol, drawdown
  const factors: number[] = [];
  if (beta !== null)  factors.push(beta);
  if (vol !== null)   factors.push(vol / 30);   // normalise: 30% vol = 1.0
  if (maxDD !== null) factors.push(maxDD / 20);  // normalise: 20% drawdown = 1.0

  if (!factors.length) return 'Unknown';
  const avg = factors.reduce((a, b) => a + b, 0) / factors.length;

  if (avg >= 2.0)  return 'Extreme';
  if (avg >= 1.4)  return 'High';
  if (avg >= 0.8)  return 'Medium';
  return 'Low';
}

// ── Regime helpers ────────────────────────────────────────────────────────────

async function getCurrentRegime(): Promise<{ regime: string; prob: number; hmm_state: number } | null> {
  const row = await dbGet<{ regime: string; regime_prob: number; hmm_state: number }>(
    `SELECT regime, regime_prob, hmm_state
     FROM market_regimes
     ORDER BY date DESC LIMIT 1`
  );
  if (!row) return null;
  return { regime: row.regime, prob: row.regime_prob, hmm_state: row.hmm_state };
}

// ── Router ────────────────────────────────────────────────────────────────────

export const riskRouter = router({

  /** Risk metrics + multi-factor scores for one stock */
  getRiskMetrics: publicProcedure
    .input(z.object({ symbol: z.string() }))
    .query(async ({ input }) => {
      const row = await dbGet<RiskRow>(`
        SELECT
          qs.symbol,
          ns.name,
          ns.sector,
          qs.beta_1y, qs.beta_6m,
          qs.sortino_ratio, qs.var_95,
          qs.sharpe_ratio, qs.annualized_vol, qs.max_drawdown_1y,
          qs.mf_composite_score, qs.mf_quality_score, qs.mf_momentum_score,
          qs.mf_value_score, qs.mf_risk_adj_score, qs.mf_macro_score,
          qs.rank_composite, qs.composite_class
        FROM quant_scores qs
        LEFT JOIN nse_stocks ns ON ns.symbol = qs.symbol
        WHERE qs.symbol = ?
      `, [input.symbol]);

      if (!row) return null;

      return {
        ...row,
        risk_tier: riskTier(row.beta_1y, row.annualized_vol, row.max_drawdown_1y),
      };
    }),

  /** Top stocks ranked by multi-factor composite score */
  getMultiFactorScores: publicProcedure
    .input(z.object({
      limit:    z.number().optional().default(50),
      minScore: z.number().optional().default(0),
      maxBeta:  z.number().optional(),
      sector:   z.string().optional(),
    }))
    .query(async ({ input }) => {
      const conditions: string[] = ['qs.mf_composite_score IS NOT NULL'];
      const params: (number | string)[] = [];

      if (input.minScore > 0) {
        conditions.push('qs.mf_composite_score >= ?');
        params.push(input.minScore);
      }
      if (input.maxBeta !== undefined) {
        conditions.push('(qs.beta_1y IS NULL OR qs.beta_1y <= ?)');
        params.push(input.maxBeta);
      }
      if (input.sector && input.sector !== 'ALL') {
        conditions.push('ns.sector = ?');
        params.push(input.sector);
      }

      params.push(input.limit);
      const where = conditions.join(' AND ');

      const rows = await dbAll<RiskRow>(`
        SELECT
          qs.symbol,
          ns.name,
          ns.sector,
          qs.beta_1y, qs.beta_6m,
          qs.sortino_ratio, qs.var_95,
          qs.sharpe_ratio, qs.annualized_vol, qs.max_drawdown_1y,
          qs.mf_composite_score, qs.mf_quality_score, qs.mf_momentum_score,
          qs.mf_value_score, qs.mf_risk_adj_score, qs.mf_macro_score,
          qs.rank_composite, qs.composite_class
        FROM quant_scores qs
        LEFT JOIN nse_stocks ns ON ns.symbol = qs.symbol
        WHERE ${where}
        ORDER BY qs.mf_composite_score DESC
        LIMIT ?
      `, params);

      return rows.map(row => ({
        ...row,
        risk_tier: riskTier(row.beta_1y, row.annualized_vol, row.max_drawdown_1y),
      }));
    }),

  /** Current HMM market regime + regime-aware signal filter advice */
  getRegimeSummary: publicProcedure
    .query(async () => {
      const regime = await getCurrentRegime();

      // Regime → suggested action for long/swing traders
      const regimeGuidance: Record<string, { action: string; color: string; icon: string }> = {
        BULL:     { action: 'Full allocation — favour momentum + quality',   color: 'emerald', icon: '🐂' },
        SIDEWAYS: { action: 'Selective — prefer value + range breakouts',    color: 'amber',   icon: '↔' },
        HIGH_VOL: { action: 'Reduce size — hedge with low-beta defensives',  color: 'orange',  icon: '⚡' },
        BEAR:     { action: 'Capital preservation — avoid new longs',        color: 'rose',    icon: '🐻' },
        CRASH:    { action: 'Cash only — wait for stabilisation signal',     color: 'red',     icon: '⛔' },
      };

      // Also load last 30 days of regime history for mini sparkline
      const history = await dbAll<{ date: string; regime: string; regime_prob: number }>(
        `SELECT date, regime, regime_prob
         FROM market_regimes
         ORDER BY date DESC LIMIT 30`
      );

      return {
        current: regime
          ? {
              ...regime,
              guidance: regimeGuidance[regime.regime] ?? {
                action: 'Check regime detector',
                color: 'slate',
                icon: '?',
              },
            }
          : null,
        history: history.reverse(),
      };
    }),

  /** Risk distribution summary across the full universe */
  getRiskDistribution: publicProcedure
    .query(async () => {
      const rows = await dbAll<{ beta_1y: number | null; annualized_vol: number | null; max_drawdown_1y: number | null }>(
        `SELECT beta_1y, annualized_vol, max_drawdown_1y FROM quant_scores WHERE ohlcv_days >= 63`
      );

      const tiers = { Low: 0, Medium: 0, High: 0, Extreme: 0, Unknown: 0 };
      for (const r of rows) {
        const t = riskTier(r.beta_1y, r.annualized_vol, r.max_drawdown_1y) as keyof typeof tiers;
        tiers[t] = (tiers[t] ?? 0) + 1;
      }

      return {
        total: rows.length,
        tiers,
        avgBeta:   rows.filter(r => r.beta_1y != null).reduce((s, r) => s + r.beta_1y!, 0) / rows.filter(r => r.beta_1y != null).length || null,
        avgVol:    rows.filter(r => r.annualized_vol != null).reduce((s, r) => s + r.annualized_vol!, 0) / rows.filter(r => r.annualized_vol != null).length || null,
      };
    }),
});
