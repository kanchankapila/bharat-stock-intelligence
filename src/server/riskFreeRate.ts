/**
 * Single source of truth for the platform's annual risk-free rate (TypeScript mirror of
 * src/server/risk_free_rate.py).
 *
 * Before 2026-10-11 the rate was hard-coded four different ways across the producers of the
 * SAME columns: 4.0% in quantScoringWorker.ts, 6.5% fallback in risk_metrics_engine.py, 7.0%
 * in institutional_quant_engine.py and 7.0% in backend-python/app/portfolio_analytics.py
 * (2026-10-11 quant audit). Sharpe values written into one column were therefore not
 * comparable row-to-row, and the divergence was invisible because each writer looked healthy.
 *
 * Convention (identical to the Python module): the latest RBI repo rate from
 * macro_asset_prices (written daily by global_macro_fetcher.py), falling back to 6.5% — the
 * modern repo-rate mid-point. Compounding convention: arithmetic, rate/252 per session,
 * which matches risk_metrics_engine._daily_returns' arithmetic log returns. Stored macro
 * values are percent (e.g. 6.5); values below 1 are treated as already-decimal.
 */

/** Fallback when macro_asset_prices has no RBI_REPO_RATE row. Must match Python's constant. */
export const DEFAULT_RISK_FREE_ANNUAL = 0.065;

/** Percent (6.5) or decimal (0.065) -> decimal. null/undefined/zero/negative -> null. */
export function normalizeRiskFreeRate(raw: unknown): number | null {
  const rate = typeof raw === 'number' ? raw : Number(raw);
  if (!Number.isFinite(rate) || rate <= 0) return null;
  // Exactly 1.0 is the realistic 1% percent-scale boundary, not a 100% annual rate.
  return rate >= 1 ? rate / 100 : rate;
}

/**
 * Latest RBI repo rate as an annual decimal, else DEFAULT_RISK_FREE_ANNUAL.
 * `dbGet` is injected so this module stays free of a DB import cycle (it is read from
 * quantScoringService, which already owns dbGet, and unit-tested with a fake).
 */
export async function getRiskFreeAnnual(
  dbGet: (sql: string) => Promise<unknown>,
): Promise<number> {
  try {
    const row = (await dbGet(
      `SELECT close FROM macro_asset_prices WHERE symbol = 'RBI_REPO_RATE'
        ORDER BY date DESC LIMIT 1`,
    )) as { close?: unknown } | undefined;
    const rate = normalizeRiskFreeRate(row?.close);
    if (rate !== null) return rate;
  } catch {
    /* macro table unavailable — fall through to the default */
  }
  return DEFAULT_RISK_FREE_ANNUAL;
}
