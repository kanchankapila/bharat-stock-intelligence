// Task 4.3/4.4: research harness. Per .claude/rules/measurement.md's panel
// spec -- per-date then averaged (never pooled), winsorised, liquidity
// floor, next-session-open entry -- and per BUILD_STAGE_3_4_SPEC.md Task
// 4.3, must pass four negative controls before any factor result is
// trusted: leakage, exit-pricing, benchmark (rebalance-1 vs rebalance-21
// agreement), and known-null.
import { LIQUIDITY_FLOOR_ADT } from './compute-features.js';
import type { OpenPriceRow } from '@greenfield/db';

export interface ForwardReturn {
  symbol: string;
  sessionDate: string;
  forwardReturn: number | null;
  adt252d: number | null;
}

/** Forward return from next-session open (entry) to `rebalanceDays` sessions
 * later's open (exit). A symbol with no bar at the exit index is EXCLUDED
 * (null) by default -- conflating "no bar" with "delisted at -100%" is the
 * exact historical bug the exit-pricing negative control exists to catch;
 * `onMissingExit: 'writeOff'` re-introduces it deliberately for that test. */
export function computeForwardReturns(
  bars: OpenPriceRow[],
  rebalanceDays: number,
  onMissingExit: 'exclude' | 'writeOff' = 'exclude',
): ForwardReturn[] {
  const bySymbol = new Map<string, OpenPriceRow[]>();
  for (const b of bars) {
    const arr = bySymbol.get(b.symbol);
    if (arr) arr.push(b);
    else bySymbol.set(b.symbol, [b]);
  }

  const out: ForwardReturn[] = [];
  for (const [symbol, rows] of bySymbol) {
    for (let i = 0; i < rows.length; i++) {
      const signalRow = rows[i]!;
      const entryIdx = i + 1;
      const exitIdx = i + 1 + rebalanceDays;
      const entry = rows[entryIdx]?.open ?? null;
      const exit = rows[exitIdx]?.open ?? null;
      let forwardReturn: number | null;
      if (entry !== null && entry > 0 && exit !== null) {
        forwardReturn = exit / entry - 1;
      } else if (onMissingExit === 'writeOff' && entry !== null && entry > 0) {
        forwardReturn = -1; // the historical bug: no bar found -> treated as total loss
      } else {
        forwardReturn = null;
      }
      out.push({ symbol, sessionDate: signalRow.sessionDate, forwardReturn, adt252d: signalRow.adt252d });
    }
  }
  return out;
}

export interface FactorPoint {
  symbol: string;
  sessionDate: string;
  value: number | null;
}

/** Winsorise a value against its own date's cross-sectional distribution
 * (1st/99th percentile by default) -- per measurement.md, raw means on this
 * kind of panel are void without it (a single +127,900% bar once produced
 * an 850%-annualised phantom edge in the predecessor). Returns a Map keyed
 * `symbol|sessionDate` -> winsorised value. */
export function winsorizePerDate(points: Array<{ symbol: string; sessionDate: string; value: number }>, lowPct = 0.01, highPct = 0.99): Map<string, number> {
  const byDate = new Map<string, number[]>();
  for (const p of points) {
    const arr = byDate.get(p.sessionDate);
    if (arr) arr.push(p.value);
    else byDate.set(p.sessionDate, [p.value]);
  }
  const bounds = new Map<string, { lo: number; hi: number }>();
  for (const [date, values] of byDate) {
    const sorted = [...values].sort((a, b) => a - b);
    const lo = sorted[Math.floor(lowPct * (sorted.length - 1))]!;
    const hi = sorted[Math.floor(highPct * (sorted.length - 1))]!;
    bounds.set(date, { lo, hi });
  }
  const result = new Map<string, number>();
  for (const p of points) {
    const b = bounds.get(p.sessionDate)!;
    result.set(`${p.symbol}|${p.sessionDate}`, Math.min(Math.max(p.value, b.lo), b.hi));
  }
  return result;
}

function rank(values: number[]): number[] {
  const idx = values.map((v, i) => [v, i] as const).sort((a, b) => a[0] - b[0]);
  const ranks = new Array<number>(values.length);
  idx.forEach(([, origIdx], rankPos) => { ranks[origIdx] = rankPos; });
  return ranks;
}

function pearson(xs: number[], ys: number[]): number | null {
  const n = xs.length;
  if (n < 3) return null;
  const meanX = xs.reduce((a, b) => a + b, 0) / n;
  const meanY = ys.reduce((a, b) => a + b, 0) / n;
  let cov = 0, varX = 0, varY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xs[i]! - meanX;
    const dy = ys[i]! - meanY;
    cov += dx * dy; varX += dx * dx; varY += dy * dy;
  }
  if (varX === 0 || varY === 0) return null;
  return cov / Math.sqrt(varX * varY);
}

// Exported (not file-local like pearson/rank) so Task 5.3's dual-run
// divergence analysis (stage5/divergence.ts) can compute the SAME rank
// correlation this harness's own computeIC uses, rather than reimplementing
// it -- recurring-bugs.md's "a test that reimplements the logic under test"
// class applies just as much to a second production computation as to a test.
export function spearman(xs: number[], ys: number[]): number | null {
  return pearson(rank(xs), rank(ys));
}

export interface IcResult {
  perDateIC: Map<string, number>;
  meanIC: number | null;
  tStat: number | null;
  nDates: number;
}

/** Per-date Spearman IC between a factor and forward return, restricted to
 * the liquid (ADT >= floor) universe, then averaged across dates -- never
 * pooled (measurement.md: pooling has flipped conclusions here 3 times). */
export function computeIC(factorPoints: FactorPoint[], returns: ForwardReturn[], liquidityFloor = LIQUIDITY_FLOOR_ADT): IcResult {
  const winsorizedReturns = winsorizePerDate(
    returns.filter((r) => r.forwardReturn !== null).map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate, value: r.forwardReturn! })),
  );
  const adtByKey = new Map(returns.map((r) => [`${r.symbol}|${r.sessionDate}`, r.adt252d]));
  const byDate = new Map<string, { factor: number[]; ret: number[] }>();

  for (const f of factorPoints) {
    if (f.value === null) continue;
    const key = `${f.symbol}|${f.sessionDate}`;
    const ret = winsorizedReturns.get(key);
    if (ret === undefined) continue;
    const adt = adtByKey.get(key);
    if (adt === undefined || adt === null || adt < liquidityFloor) continue;
    const bucket = byDate.get(f.sessionDate) ?? { factor: [], ret: [] };
    bucket.factor.push(f.value);
    bucket.ret.push(ret);
    byDate.set(f.sessionDate, bucket);
  }

  const perDateIC = new Map<string, number>();
  for (const [date, { factor, ret }] of byDate) {
    if (factor.length < 5) continue; // too few names to rank meaningfully
    const ic = spearman(factor, ret);
    if (ic !== null) perDateIC.set(date, ic);
  }

  const values = Array.from(perDateIC.values());
  const n = values.length;
  if (n === 0) return { perDateIC, meanIC: null, tStat: null, nDates: 0 };

  const meanIC = values.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { perDateIC, meanIC, tStat: null, nDates: n };
  const variance = values.reduce((sum, v) => sum + (v - meanIC) ** 2, 0) / (n - 1);
  const stderr = Math.sqrt(variance / n);
  const tStat = stderr > 0 ? meanIC / stderr : null;

  return { perDateIC, meanIC, tStat, nDates: n };
}

export interface AnnualizedResult {
  meanExcessReturnPerPeriod: number | null;
  annualizedExcessReturnPct: number | null;
  nPeriods: number;
}

/** Top-K long-only portfolio, rebalanced every `rebalanceDays` sessions,
 * net excess return vs the equal-weight liquid universe over the same
 * holding period. Used by the benchmark negative control: rebalance-1 and
 * rebalance-21 must agree within ~5pp/yr (the predecessor's exact bug
 * class -- a wrong benchmark made --rebalance 1 diverge by ~35pp/yr). */
export function computeAnnualizedExcessReturn(
  factorPoints: FactorPoint[], returns: ForwardReturn[], rebalanceDays: number, topK = 20, liquidityFloor = LIQUIDITY_FLOOR_ADT,
): AnnualizedResult {
  const winsorizedReturns = winsorizePerDate(
    returns.filter((r) => r.forwardReturn !== null).map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate, value: r.forwardReturn! })),
  );
  const adtByKey = new Map(returns.map((r) => [`${r.symbol}|${r.sessionDate}`, r.adt252d]));
  const byDate = new Map<string, Array<{ symbol: string; value: number; ret: number }>>();

  for (const f of factorPoints) {
    if (f.value === null) continue;
    const key = `${f.symbol}|${f.sessionDate}`;
    const ret = winsorizedReturns.get(key);
    if (ret === undefined) continue;
    const adt = adtByKey.get(key);
    if (adt === undefined || adt === null || adt < liquidityFloor) continue;
    const bucket = byDate.get(f.sessionDate) ?? [];
    bucket.push({ symbol: f.symbol, value: f.value, ret });
    byDate.set(f.sessionDate, bucket);
  }

  const excessPerDate: number[] = [];
  const sortedDates = Array.from(byDate.keys()).sort();
  for (let i = 0; i < sortedDates.length; i += rebalanceDays) {
    const date = sortedDates[i]!;
    const cohort = byDate.get(date)!;
    if (cohort.length < topK) continue;
    const universeReturn = cohort.reduce((s, c) => s + c.ret, 0) / cohort.length;
    const top = [...cohort].sort((a, b) => b.value - a.value).slice(0, topK);
    const portfolioReturn = top.reduce((s, c) => s + c.ret, 0) / top.length;
    excessPerDate.push(portfolioReturn - universeReturn);
  }

  const n = excessPerDate.length;
  if (n === 0) return { meanExcessReturnPerPeriod: null, annualizedExcessReturnPct: null, nPeriods: 0 };
  const mean = excessPerDate.reduce((a, b) => a + b, 0) / n;
  const periodsPerYear = 252 / rebalanceDays;
  return { meanExcessReturnPerPeriod: mean, annualizedExcessReturnPct: mean * periodsPerYear * 100, nPeriods: n };
}

export interface NetAnnualizedResult extends AnnualizedResult {
  meanTurnover: number | null;
  meanNetExcessReturnPerPeriod: number | null;
  annualizedNetExcessReturnPct: number | null;
  /** t-stat of the net-of-cost per-period excess return series (mean / stderr
   * across periods) -- this, not the IC t-stat, is what Task 5.0.2's
   * Bonferroni bar is applied to: it reflects whether the actual tradeable
   * edge survives costs, not just whether the ranking correlates. */
  netTStat: number | null;
}

/** Task 5.0.1: same top-K long-only construction as computeAnnualizedExcessReturn,
 * but deducts real round-trip transaction cost from measured turnover (the
 * fraction of the top-K set that changed since the PREVIOUS rebalance),
 * never an assumed constant. Gross-only measurement is exactly how the
 * predecessor system read `delivery_pct` as a strong factor (t=+7.82) before
 * discovering it was dead as a long-only factor once cost-adjusted
 * (net excess -1.04%/period at 21d/25bps) -- see BUILD_STAGE_5_SPEC.md §0. */
export function computeNetAnnualizedExcessReturn(
  factorPoints: FactorPoint[], returns: ForwardReturn[], rebalanceDays: number,
  topK = 20, costBps = 25, liquidityFloor = LIQUIDITY_FLOOR_ADT,
): NetAnnualizedResult {
  const winsorizedReturns = winsorizePerDate(
    returns.filter((r) => r.forwardReturn !== null).map((r) => ({ symbol: r.symbol, sessionDate: r.sessionDate, value: r.forwardReturn! })),
  );
  const adtByKey = new Map(returns.map((r) => [`${r.symbol}|${r.sessionDate}`, r.adt252d]));
  const byDate = new Map<string, Array<{ symbol: string; value: number; ret: number }>>();

  for (const f of factorPoints) {
    if (f.value === null) continue;
    const key = `${f.symbol}|${f.sessionDate}`;
    const ret = winsorizedReturns.get(key);
    if (ret === undefined) continue;
    const adt = adtByKey.get(key);
    if (adt === undefined || adt === null || adt < liquidityFloor) continue;
    const bucket = byDate.get(f.sessionDate) ?? [];
    bucket.push({ symbol: f.symbol, value: f.value, ret });
    byDate.set(f.sessionDate, bucket);
  }

  const grossExcessPerDate: number[] = [];
  const netExcessPerDate: number[] = [];
  const turnoverPerDate: number[] = [];
  const sortedDates = Array.from(byDate.keys()).sort();
  let prevTopSet: Set<string> | null = null;

  for (let i = 0; i < sortedDates.length; i += rebalanceDays) {
    const date = sortedDates[i]!;
    const cohort = byDate.get(date)!;
    if (cohort.length < topK) continue;
    const universeReturn = cohort.reduce((s, c) => s + c.ret, 0) / cohort.length;
    const top = [...cohort].sort((a, b) => b.value - a.value).slice(0, topK);
    const portfolioReturn = top.reduce((s, c) => s + c.ret, 0) / top.length;
    const grossExcess = portfolioReturn - universeReturn;

    const topSet = new Set(top.map((t) => t.symbol));
    // One-way turnover: fraction of the new top-K that wasn't in the
    // previous top-K. The first rebalance has no prior portfolio to compare
    // against, so it isn't counted (buying from cash isn't a "trade cost"
    // in the same sense a rebalance is).
    if (prevTopSet !== null) {
      const entered = [...topSet].filter((s) => !prevTopSet!.has(s)).length;
      const turnover = entered / topK;
      const netExcess = grossExcess - (costBps / 10_000) * turnover;
      grossExcessPerDate.push(grossExcess);
      netExcessPerDate.push(netExcess);
      turnoverPerDate.push(turnover);
    }
    prevTopSet = topSet;
  }

  const n = netExcessPerDate.length;
  if (n === 0) {
    return {
      meanExcessReturnPerPeriod: null, annualizedExcessReturnPct: null, nPeriods: 0,
      meanTurnover: null, meanNetExcessReturnPerPeriod: null, annualizedNetExcessReturnPct: null, netTStat: null,
    };
  }
  const meanGross = grossExcessPerDate.reduce((a, b) => a + b, 0) / n;
  const meanNet = netExcessPerDate.reduce((a, b) => a + b, 0) / n;
  const meanTurnover = turnoverPerDate.reduce((a, b) => a + b, 0) / n;
  const periodsPerYear = 252 / rebalanceDays;

  let netTStat: number | null = null;
  if (n >= 2) {
    const variance = netExcessPerDate.reduce((sum, v) => sum + (v - meanNet) ** 2, 0) / (n - 1);
    const stderr = Math.sqrt(variance / n);
    netTStat = stderr > 0 ? meanNet / stderr : null;
  }

  return {
    meanExcessReturnPerPeriod: meanGross, annualizedExcessReturnPct: meanGross * periodsPerYear * 100, nPeriods: n,
    meanTurnover, meanNetExcessReturnPerPeriod: meanNet, annualizedNetExcessReturnPct: meanNet * periodsPerYear * 100,
    netTStat,
  };
}
