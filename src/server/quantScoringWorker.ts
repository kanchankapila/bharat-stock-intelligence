/**
 * Worker thread for quantitative scoring CPU computation.
 * Receives OHLCV data + auxiliary maps via workerData, computes all
 * per-symbol metrics and percentile ranks, then posts back results.
 *
 * Runs entirely off the main event loop — no DB access, no I/O.
 */

import { workerData, parentPort } from 'worker_threads';
// Worker threads run this source file in a fresh Node ESM instance. Unlike the parent tsx
// process, Node's worker resolver does not add `.ts` to extensionless relative imports (live
// failure 2026-10-12: ERR_MODULE_NOT_FOUND for `src/server/riskFreeRate`). Keep the explicit
// extension here; tsconfig enables allowImportingTsExtensions.
import { DEFAULT_RISK_FREE_ANNUAL } from './riskFreeRate.ts';

// ── Types (duplicated here so the worker is self-contained) ──────────────────

interface OHLCVRow  { date: string; close: number; volume: number }
interface QuantRow  { symbol: string; [k: string]: unknown }

interface WorkerInput {
  eligible: [string, OHLCVRow[]][];
  screenerMap: Record<string, { bullish: number; bearish: number; netScore: number; categoryBreadth: number }>;
  fundMap:     Record<string, Record<string, number | null>>;
  techMap:     Record<string, { composite_score: number | null }>;
  /** Annual decimal risk-free rate, resolved once by quantScoringService from
   *  macro_asset_prices (riskFreeRate.ts). Injected because this worker has no DB access.
   *  2026-10-11 quant audit: this was a hard-coded 0.04 while risk_metrics_engine.py used
   *  6.5% and institutional_quant_engine.py 7.0%, so sharpe_ratio values in one column
   *  were not comparable row-to-row. */
  riskFreeAnnual?: number;
}

// ── Rank constants ───────────────────────────────────────────────────────────

/**
 * Rank assigned to a MISSING value: absence of data is not evidence of anything, so a
 * name with no reading sits at the middle of the cross-section rather than at either end.
 */
const MISSING_RANK = 50;

/**
 * Rank assigned to a KNOWN-BAD value: the input is present but economically undefined
 * (a non-positive P/E from a loss-making company, a non-positive book value). That is not
 * the same as missing — a loss-maker is not "as cheap as the average stock", it is off the
 * value screen entirely, so it takes the WORST rank. Before 2026-10-11 both cases were
 * nulled and neutral-filled to 50, which ranked distress as average pricing.
 */
const KNOWN_BAD_RANK = 0;

// ── Math helpers (mirrors of quantScoringService.ts) ─────────────────────────

function pctReturn(rows: OHLCVRow[], lookbackDays: number): number | null {
  // N-session return = close(t)/close(t-N)-1, so an N-session lookback needs N+1 bars.
  // The old `rows.length < lookbackDays` guard let a 5-session slice through with
  // base = rows[0] and reported return_1w as a 4-session return; return_12m likewise
  // silently spanned 251 sessions, and (worse) `Math.min(252, rows.length)` redefined
  // "12m" to whatever history existed while keeping the label (2026-10-11 quant audit).
  if (rows.length < lookbackDays + 1) return null;
  const latest = rows[rows.length - 1].close;
  const base   = rows[rows.length - 1 - lookbackDays].close;
  return base > 0 ? ((latest - base) / base) * 100 : null;
}

function sma(rows: OHLCVRow[], period: number): number | null {
  if (rows.length < period) return null;
  const slice = rows.slice(-period);
  return slice.reduce((a, r) => a + r.close, 0) / period;
}

function annualizedMetrics(rows: OHLCVRow[], riskFree: number): { vol: number; sharpe: number; annualReturn: number } | null {
  if (rows.length < 30) return null;
  const returns: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = (rows[i].close - rows[i - 1].close) / rows[i - 1].close;
    returns.push(r);
  }
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  // Sample variance (n-1), not population (n): the population divisor biases annualised
  // vol low and Sharpe high, and did so inconsistently with institutional_quant_engine.py
  // which uses np.std(ddof=1) on the same column (2026-10-11 quant audit).
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / (returns.length - 1);
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(252);
  const annualReturn = mean * 252;
  const sharpe = annualVol > 0 ? (annualReturn - riskFree) / annualVol : 0;
  return { vol: annualVol * 100, sharpe, annualReturn };
}

/**
 * Max drawdown as a POSITIVE percentage magnitude over the trailing `lookbackDays`
 * sessions (12.5 means "fell 12.5% from its peak").
 *
 * The sign convention is positive-magnitude and every consumer depends on it:
 * `max_drawdown_1y <= ?` (quantScoringService screener filter), `maxDD / 20` risk-tier
 * normalisation (risk.router.ts), `good="low"` (RiskMetricsDashboard) and `ddRanks`
 * (`higherIsBetter: false`) below. institutional_quant_engine.py writes the same column as
 * a NEGATIVE number, so ~218 rows in quant_scores carry the opposite sign and rank as the
 * LEAST risky names in the universe; that writer is the one that gets corrected
 * (2026-10-11 quant audit).
 */
function maxDrawdown(rows: OHLCVRow[], lookbackDays = 252): number {
  const slice = rows.slice(-lookbackDays);
  let peak = slice[0]?.close ?? 0;
  let maxDD = 0;
  for (const r of slice) {
    if (r.close > peak) peak = r.close;
    const dd = peak > 0 ? (peak - r.close) / peak : 0;
    if (dd > maxDD) maxDD = dd;
  }
  return maxDD * 100;
}

/**
 * Cross-sectional percentile rank 0-100 over the non-missing entries, ties → average rank
 * (pos/(n-1) makes the best entry exactly 100 and the worst exactly 0).
 *
 * `missingRank` (default MISSING_RANK) is what a null gets.
 * `knownBad` (optional, same length as `values`) marks entries that are PRESENT but
 * economically undefined; those get KNOWN_BAD_RANK instead of the neutral fill.
 */
function percentileRanks(
  values: (number | null)[],
  higherIsBetter = true,
  missingRank: number = MISSING_RANK,
  knownBad?: (boolean | null)[],
): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  const valid = indexed.filter(x => x.v !== null) as { v: number; i: number }[];
  valid.sort((a, b) => (higherIsBetter ? a.v - b.v : b.v - a.v));
  const ranks = new Array<number>(values.length).fill(missingRank);
  valid.forEach((x, pos) => {
    ranks[x.i] = valid.length > 1 ? (pos / (valid.length - 1)) * 100 : missingRank;
  });
  if (knownBad) {
    for (let i = 0; i < knownBad.length; i++) {
      if (knownBad[i]) ranks[i] = KNOWN_BAD_RANK;
    }
  }
  return ranks;
}


// ── Main worker logic ────────────────────────────────────────────────────────

const { eligible, screenerMap, fundMap, techMap, riskFreeAnnual } = workerData as WorkerInput;
// 2026-10-11 quant audit: was 0.04 here while institutional_quant_engine.py used 7.0%
// and risk_metrics_engine.py 6.5% — three different risk-free rates feeding the same
// quant_scores.sharpe_ratio column, so Sharpe values were not comparable row-to-row.
// The service resolves the rate once (riskFreeRate.ts) and injects it; the module default
// only applies to direct/test invocations of this worker.
const RISK_FREE = typeof riskFreeAnnual === 'number' && riskFreeAnnual > 0
  ? riskFreeAnnual
  : DEFAULT_RISK_FREE_ANNUAL;

const computed: QuantRow[] = [];

for (const [symbol, rows] of eligible) {
  const price  = rows[rows.length - 1].close;
  const s200   = sma(rows, 200);
  const r1w    = pctReturn(rows, 5);
  const r1m    = pctReturn(rows, 21);
  const r3m    = pctReturn(rows, 63);
  const r6m    = pctReturn(rows, 126);
  // Fixed 252-session lookback, not Math.min(252, rows.length): the old form silently
  // redefined "12m" to whatever history existed while keeping the label — a 90-day
  // listing's "return_12m" was really a 3-month return, ranked against genuine 12-month
  // returns (2026-10-11 quant audit). pctReturn now returns null below 253 bars instead.
  const r12m   = pctReturn(rows, 252);
  const riskM  = annualizedMetrics(rows, RISK_FREE);
  const maxDD  = maxDrawdown(rows, 252);
  const conf   = screenerMap[symbol];
  const fund   = fundMap[symbol];
  const tech   = techMap[symbol];

  computed.push({
    symbol,
    return_1w:   r1w,
    return_1m:   r1m,
    return_3m:   r3m,
    return_6m:   r6m,
    return_12m:  r12m,
    above_sma200: s200 ? (price > s200 ? 1 : 0) : null,
    sma200_distance_pct: s200 ? ((price - s200) / s200) * 100 : null,
    annualized_vol:   riskM?.vol     ?? null,
    sharpe_ratio:     riskM?.sharpe  ?? null,
    max_drawdown_1y:  maxDD,
    trailing_pe:      fund?.trailing_pe    ?? null,
    forward_pe:       fund?.forward_pe     ?? null,
    debt_to_equity:   fund?.debt_to_equity ?? null,
    return_on_equity: fund?.return_on_equity ?? null,
    operating_margins: fund?.operating_margins ?? null,
    revenue_growth:   fund?.revenue_growth   ?? null,
    piotroski_f_score: fund?.piotroski_f_score ?? null,
    bullish_screener_count:    conf?.bullish        ?? 0,
    bearish_screener_count:    conf?.bearish        ?? 0,
    screener_category_breadth: conf?.categoryBreadth ?? 0,
    screener_net_score:        conf?.netScore       ?? 0,
    technical_composite:       tech?.composite_score ?? null,
    ohlcv_days: rows.length,
  });
}

// ── All percentile rank passes ───────────────────────────────────────────────

const get = (field: string) => computed.map(c => c[field] as number | null);

const rank12m = percentileRanks(get('return_12m'), true);
const rank6m  = percentileRanks(get('return_6m'),  true);
const rank3m  = percentileRanks(get('return_3m'),  true);
const momentumRanks = rank12m.map((r, i) => 0.50 * r + 0.30 * rank6m[i] + 0.20 * rank3m[i]);
const momentumPct   = percentileRanks(momentumRanks, true);

const volRanks    = percentileRanks(get('annualized_vol'),  false);
const sharpeRanks = percentileRanks(get('sharpe_ratio'),    true);
const ddRanks     = percentileRanks(get('max_drawdown_1y'), false);

// P/E: values are gated to (0, 200) before ranking (a loss-maker's negative P/E would
// otherwise sort as the "cheapest" name in the universe). Before 2026-10-11 the gate
// nulled them and percentileRanks neutral-filled 50, so a loss-maker ranked identically
// to a median-P/E compounder. A PRESENT-but-non-positive P/E is now flagged known-bad and
// takes the WORST rank; a genuinely absent reading still takes the neutral rank.
const peRaw    = get('trailing_pe');
const peValues = peRaw.map((v: number | null) => (v !== null && v > 0 && v < 200) ? v : null);
const peKnownBad = peRaw.map((v: number | null) => v !== null && !(v > 0 && v < 200));
const peRanks  = percentileRanks(peValues, false, MISSING_RANK, peKnownBad);
const roeRanks   = percentileRanks(get('return_on_equity'), true);
// D/E: same known-bad treatment as P/E — a PRESENT negative D/E (negative equity, i.e. a
// balance-sheet-stressed name) is the riskiest reading, not a missing one. Before
// 2026-10-11 it was nulled and neutral-filled to 50, ranking stressed balance sheets as
// average leverage.
const deRaw    = get('debt_to_equity');
const deValues = deRaw.map((v: number | null) => (v !== null && v >= 0) ? v : null);
const deKnownBad = deRaw.map((v: number | null) => v !== null && v < 0);
const deRanks  = percentileRanks(deValues, false, MISSING_RANK, deKnownBad);
const revGrRanks = percentileRanks(get('revenue_growth'), true);
const valuationRanks = peRanks.map((r, i) =>
  0.25 * r + 0.35 * roeRanks[i] + 0.20 * deRanks[i] + 0.20 * revGrRanks[i]
);
const valuationPct = percentileRanks(valuationRanks, true);

const confluencePct = percentileRanks(get('screener_net_score'), true);

const qualityRanks = momentumPct.map((m, i) =>
  0.40 * m + 0.25 * sharpeRanks[i] + 0.20 * volRanks[i] + 0.15 * ddRanks[i]
);
const qualityPct = percentileRanks(qualityRanks, true);

const techRanks = percentileRanks(get('technical_composite'), true);

// Weights sum to 0.90: the macro block was two hard-coded `0.10 * 50` constants, an
// additive constant that is invariant under the cross-sectional percentile rank below and
// therefore contributed nothing to the ordering while silently deflating every other
// weight (0.30 confluence was really 0.30/0.90 of the signal). multi_factor_scorer.py's
// regime overlay (`_build_macro`) is the interactive macro implementation; this scalar
// no-op is removed and the four surviving weights normalised to 1.0 in place
// (2026-10-11 quant audit).
const COMPOSITE_WEIGHTS = {
  confluence: 0.30 / 0.90,
  valuation:  0.20 / 0.90,
  technical:  0.15 / 0.90,
  momentum:   0.15 / 0.90,
};

const compositeRanks = momentumPct.map((m, i) =>
  COMPOSITE_WEIGHTS.confluence * confluencePct[i] +
  COMPOSITE_WEIGHTS.valuation  * valuationPct[i] +
  COMPOSITE_WEIGHTS.technical  * techRanks[i] +
  COMPOSITE_WEIGHTS.momentum   * m
);
const compositePct = percentileRanks(compositeRanks, true);

// ── Post results back to main thread ────────────────────────────────────────

parentPort!.postMessage({
  computed,
  momentumPct,
  volRanks,
  sharpeRanks,
  valuationPct,
  confluencePct,
  qualityPct,
  compositePct,
});
