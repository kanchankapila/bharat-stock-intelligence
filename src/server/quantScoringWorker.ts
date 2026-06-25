/**
 * Worker thread for quantitative scoring CPU computation.
 * Receives OHLCV data + auxiliary maps via workerData, computes all
 * per-symbol metrics and percentile ranks, then posts back results.
 *
 * Runs entirely off the main event loop — no DB access, no I/O.
 */

import { workerData, parentPort } from 'worker_threads';

const RISK_FREE = 0.04;

// ── Types (duplicated here so the worker is self-contained) ──────────────────

interface OHLCVRow  { date: string; close: number; volume: number }
interface QuantRow  { symbol: string; [k: string]: unknown }

interface WorkerInput {
  eligible: [string, OHLCVRow[]][];
  screenerMap: Record<string, { bullish: number; bearish: number; netScore: number; categoryBreadth: number }>;
  fundMap:     Record<string, Record<string, number | null>>;
  techMap:     Record<string, { composite_score: number | null }>;
}

// ── Math helpers (identical to quantScoringService.ts) ───────────────────────

function pctReturn(rows: OHLCVRow[], lookbackDays: number): number | null {
  if (rows.length < lookbackDays) return null;
  const latest = rows[rows.length - 1].close;
  const base   = rows[rows.length - lookbackDays].close;
  return base > 0 ? ((latest - base) / base) * 100 : null;
}

function sma(rows: OHLCVRow[], period: number): number | null {
  if (rows.length < period) return null;
  const slice = rows.slice(-period);
  return slice.reduce((a, r) => a + r.close, 0) / period;
}

function annualizedMetrics(rows: OHLCVRow[]): { vol: number; sharpe: number; annualReturn: number } | null {
  if (rows.length < 30) return null;
  const returns: number[] = [];
  for (let i = 1; i < rows.length; i++) {
    const r = (rows[i].close - rows[i - 1].close) / rows[i - 1].close;
    returns.push(r);
  }
  const mean = returns.reduce((a, r) => a + r, 0) / returns.length;
  const variance = returns.reduce((a, r) => a + (r - mean) ** 2, 0) / returns.length;
  const dailyVol = Math.sqrt(variance);
  const annualVol = dailyVol * Math.sqrt(252);
  const annualReturn = mean * 252;
  const sharpe = annualVol > 0 ? (annualReturn - RISK_FREE) / annualVol : 0;
  return { vol: annualVol * 100, sharpe, annualReturn };
}

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

function percentileRanks(values: (number | null)[], higherIsBetter = true): number[] {
  const indexed = values.map((v, i) => ({ v, i }));
  const valid = indexed.filter(x => x.v !== null) as { v: number; i: number }[];
  valid.sort((a, b) => (higherIsBetter ? a.v - b.v : b.v - a.v));
  const ranks = new Array(values.length).fill(50);
  valid.forEach((x, pos) => {
    ranks[x.i] = valid.length > 1 ? (pos / (valid.length - 1)) * 100 : 50;
  });
  return ranks;
}

// ── Main worker logic ────────────────────────────────────────────────────────

const { eligible, screenerMap, fundMap, techMap } = workerData as WorkerInput;

const computed: QuantRow[] = [];

for (const [symbol, rows] of eligible) {
  const price  = rows[rows.length - 1].close;
  const s200   = sma(rows, 200);
  const r1w    = pctReturn(rows, 5);
  const r1m    = pctReturn(rows, 21);
  const r3m    = pctReturn(rows, 63);
  const r6m    = pctReturn(rows, 126);
  const r12m   = pctReturn(rows, Math.min(252, rows.length));
  const riskM  = annualizedMetrics(rows);
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

const peRanks  = percentileRanks(
  get('trailing_pe').map((v: number | null) => (v && v > 0 && v < 200) ? v : null),
  false
);
const roeRanks   = percentileRanks(get('return_on_equity'), true);
const deRanks    = percentileRanks(
  get('debt_to_equity').map((v: number | null) => (v !== null && v >= 0) ? v : null),
  false
);
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

const compositeRanks = momentumPct.map((m, i) =>
  0.30 * confluencePct[i] + 0.20 * valuationPct[i] + 0.15 * techRanks[i] + 0.15 * m + 0.10 * 50 + 0.10 * 50
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
