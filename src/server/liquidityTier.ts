/**
 * Tradability tier from ~30-session average daily turnover in Rs crore (AF-20261015-10).
 * Cuts follow the measurement standard (>= Rs 10 cr graded) and the measured result that the
 * ranker's 5d top-decile edge sits mostly under Rs 10 cr/day, where entries are not fillable.
 * A label only: it never changes a score or a classification.
 */
export type LiquidityTier = 'ok' | 'thin' | 'untradable';

export const LIQUIDITY_THIN_CR = 10;
export const LIQUIDITY_UNTRADABLE_CR = 1;

export function liquidityTier(adtCr: number | null | undefined): LiquidityTier | null {
  if (adtCr == null || !Number.isFinite(adtCr)) return null;
  if (adtCr < LIQUIDITY_UNTRADABLE_CR) return 'untradable';
  if (adtCr < LIQUIDITY_THIN_CR) return 'thin';
  return 'ok';
}
