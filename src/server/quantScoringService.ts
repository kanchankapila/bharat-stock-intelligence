/**
 * Quantitative Strategy Scoring Service
 *
 * Computes four strategy scores for every stock with sufficient OHLCV history:
 *
 *   MOMENTUM  — 12M/6M/3M price return (rank-weighted), price vs 200-SMA gate
 *   QUALITY   — momentum × low-volatility × high-Sharpe composite
 *   VALUE     — trailing/forward PE, D/E, ROE, revenue growth (from stock_fundamentals)
 *   COMPOSITE — weighted blend of all four pillars
 *
 * All scores are expressed as percentile ranks (0–100) across the eligible universe.
 * Risk-free rate assumed: 4.0% p.a. (Indian T-bill proxy).
 *
 * Runs nightly via BullMQ (QUEUE_QUANT_SCORING). First run is triggered at startup.
 */

import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';

const RISK_FREE = 0.04;
const MIN_DAYS  = 240; // require ~1 full trading year

// ─── Types ────────────────────────────────────────────────────────────────────

interface OHLCVRow  { date: string; close: number; volume: number }
interface QuantRow  { symbol: string; [k: string]: any }

// ─── Progress state ───────────────────────────────────────────────────────────

export interface QuantScoringProgress {
  isRunning: boolean;
  totalSymbols: number;
  processed: number;
  startedAt: string | null;
  completedAt: string | null;
  lastError: string | null;
}

let scoringProgress: QuantScoringProgress = {
  isRunning: false,
  totalSymbols: 0,
  processed: 0,
  startedAt: null,
  completedAt: null,
  lastError: null,
};

async function persistProgress(): Promise<void> {
  try {
    await dbRun(
      'INSERT INTO app_settings(key,value,"updatedAt") VALUES(?,?,CURRENT_TIMESTAMP) ' +
      'ON CONFLICT(key) DO UPDATE SET value=excluded.value, "updatedAt"=excluded."updatedAt"',
      ['quant_scoring_progress', JSON.stringify(scoringProgress)]
    );
  } catch (err: unknown) {
    console.warn('[QUANT] Could not persist progress:', (err as Error).message);
  }
}

void (async () => {
  try {
    const _row = await dbGet("SELECT value FROM app_settings WHERE key = 'quant_scoring_progress'") as { value: string } | undefined;
    if (_row) {
      const saved = JSON.parse(_row.value) as Partial<QuantScoringProgress>;
      scoringProgress = { ...scoringProgress, ...saved, isRunning: false };
    }
  } catch { /* no persisted state */ }
})();

export function getQuantScoringProgress(): QuantScoringProgress {
  return { ...scoringProgress };
}

export async function getQuantScoreCount(): Promise<number> {
  return ((await dbGet('SELECT COUNT(*) as n FROM quant_scores')) as any).n;
}

export async function bootstrapQuantScoring(bullmqReady: boolean): Promise<void> {
  const count = await getQuantScoreCount();
  if (count > 0) {
    console.log(`[QUANT] ${count} existing rows — skipping bootstrap`);
    return;
  }
  if (bullmqReady) {
    const { quantScoringQueue } = await import('./queues');
    if (quantScoringQueue) {
      await quantScoringQueue.add('quant-score-first-run', {}, { removeOnComplete: 3, removeOnFail: 3, attempts: 1, priority: 2 });
      console.log('[QUANT] First-run job enqueued via BullMQ');
      return;
    }
  }
  console.log('[QUANT] No Redis — starting first-time quant scoring directly');
  runQuantScoring().catch(err => {
    console.error('[QUANT] First-run error:', err.message);
    // Don't rethrow — startup must not crash if quant scoring fails
  });
  setInterval(() => {
    console.log('[QUANT] Triggering daily quant strategy scoring (fallback)');
    runQuantScoring().catch(err =>
      console.error('[QUANT] Scheduled fallback error:', (err as Error).message)
    );
  }, 24 * 60 * 60 * 1000);
}

// ─── Math helpers ─────────────────────────────────────────────────────────────

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

function annualizedMetrics(rows: OHLCVRow[]): {
  vol: number;
  sharpe: number;
  annualReturn: number;
} | null {
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

// ─── Percentile rank helper ───────────────────────────────────────────────────
// Returns 0–100 rank for each value. Nulls receive 50 (neutral).

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

// ─── Screener confluence (one-shot SQL) ──────────────────────────────────────

async function loadScreenerConfluence(): Promise<Map<string, {
  bullish: number; bearish: number; netScore: number; categoryBreadth: number;
}>> {
  const rows = await dbAll(`
    SELECT
      symbol,
      COUNT(DISTINCT sm.inferred_category) AS category_breadth,
      SUM(CASE WHEN sm.inferred_sentiment = 'bullish'
               THEN COALESCE(sm.confidence, 0.5) ELSE 0 END) AS bullish_score,
      SUM(CASE WHEN sm.inferred_sentiment = 'bearish'
               THEN COALESCE(sm.confidence, 0.5) ELSE 0 END) AS bearish_score,
      COUNT(CASE WHEN sm.inferred_sentiment = 'bullish' THEN 1 END) AS bullish_count,
      COUNT(CASE WHEN sm.inferred_sentiment = 'bearish' THEN 1 END) AS bearish_count
    FROM (
      SELECT symbol, screener_id AS sid FROM trendlyne_screener_stocks
        WHERE symbol IS NOT NULL
      UNION ALL
      SELECT symbol, scan_id AS sid FROM moneycontrol_screener_stocks
        WHERE symbol IS NOT NULL
    ) stocks
    JOIN screener_master sm ON sm.scan_id = stocks.sid
    WHERE sm.inferred_sentiment IN ('bullish', 'bearish')
    GROUP BY symbol
  `) as any[];

  const map = new Map<string, any>();
  for (const r of rows) {
    map.set(r.symbol, {
      bullish:        r.bullish_count,
      bearish:        r.bearish_count,
      netScore:       r.bullish_score - r.bearish_score,
      categoryBreadth: r.category_breadth,
    });
  }
  return map;
}

// ─── Fundamentals lookup (one-shot) ──────────────────────────────────────────

async function loadFundamentals(): Promise<Map<string, any>> {
  const rows = await dbAll(`
    SELECT symbol, trailing_pe, forward_pe, debt_to_equity, return_on_equity,
           operating_margins, revenue_growth, piotroski_f_score, earnings_growth
    FROM stock_fundamentals
  `) as any[];
  return new Map(rows.map(r => [r.symbol, r]));
}

// ─── Technical Composite lookup (one-shot) ───────────────────────────────────

async function loadTechnicalCompositeScores(): Promise<Map<string, any>> {
  const rows = await dbAll(`
    SELECT symbol, composite_score
    FROM technical_composite_scores
  `) as any[];
  return new Map(rows.map(r => [r.symbol, r]));
}

// ─── Main scorer ─────────────────────────────────────────────────────────────

export async function runQuantScoring(): Promise<void> {
  if (scoringProgress.isRunning) {
    console.warn('[QUANT] Already running — skipping');
    return;
  }

  scoringProgress = {
    isRunning: true,
    totalSymbols: 0,
    processed: 0,
    startedAt: new Date().toISOString(),
    completedAt: null,
    lastError: null,
  };
  await persistProgress();

  try {
    console.log('[QUANT] Loading OHLCV data...');

    // Load all OHLCV rows ordered by symbol then date
    const allRows = await dbAll(
      `SELECT symbol, date, close, volume FROM stock_ohlcv
       WHERE close > 0 ORDER BY symbol, date ASC`
    ) as (OHLCVRow & { symbol: string })[];

    // Group by symbol
    const bySymbol = new Map<string, OHLCVRow[]>();
    for (const r of allRows) {
      if (!bySymbol.has(r.symbol)) bySymbol.set(r.symbol, []);
      bySymbol.get(r.symbol)!.push({ date: r.date, close: r.close, volume: r.volume });
    }

    // Filter to symbols with enough history
    const eligible = [...bySymbol.entries()].filter(([, rows]) => rows.length >= MIN_DAYS);
    scoringProgress.totalSymbols = eligible.length;
    await persistProgress();
    console.log(`[QUANT] ${eligible.length} eligible symbols`);

    // Pre-load screener confluence, fundamentals, and technical composites
    const screenerMap  = await loadScreenerConfluence();
    const fundMap      = await loadFundamentals();
    const techMap      = await loadTechnicalCompositeScores();

    // ── Compute raw metrics per symbol ──────────────────────────────────────

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
      const conf   = screenerMap.get(symbol);
      const fund   = fundMap.get(symbol);
      const tech   = techMap.get(symbol);

      computed.push({
        symbol,
        return_1w:   r1w,
        return_1m:   r1m,
        return_3m:   r3m,
        return_6m:   r6m,
        return_12m:  r12m,
        above_sma200: s200 ? (price > s200 ? 1 : 0) : null,
        sma200_distance_pct: s200 ? ((price - s200) / s200) * 100 : null,
        annualized_vol:  riskM?.vol     ?? null,
        sharpe_ratio:    riskM?.sharpe  ?? null,
        max_drawdown_1y: maxDD,
        trailing_pe:     fund?.trailing_pe    ?? null,
        forward_pe:      fund?.forward_pe     ?? null,
        debt_to_equity:  fund?.debt_to_equity ?? null,
        return_on_equity: fund?.return_on_equity ?? null,
        operating_margins: fund?.operating_margins ?? null,
        revenue_growth:  fund?.revenue_growth   ?? null,
        piotroski_f_score: fund?.piotroski_f_score ?? null,
        bullish_screener_count:   conf?.bullish        ?? 0,
        bearish_screener_count:   conf?.bearish        ?? 0,
        screener_category_breadth: conf?.categoryBreadth ?? 0,
        screener_net_score:        conf?.netScore       ?? 0,
        technical_composite:       tech?.composite_score ?? null,
        ohlcv_days: rows.length,
      });

      // Yield the event loop every 50 symbols to prevent blocking tRPC requests.
      if (computed.length % 50 === 0) {
        await new Promise<void>(resolve => setImmediate(resolve));
      }
    }

    // ── Percentile ranks ────────────────────────────────────────────────────

    const get = (field: string) => computed.map(c => c[field] as number | null);

    // Momentum rank: 50% 12M, 30% 6M, 20% 3M (trim 1M to avoid reversal noise)
    const rank12m = percentileRanks(get('return_12m'), true);
    const rank6m  = percentileRanks(get('return_6m'),  true);
    const rank3m  = percentileRanks(get('return_3m'),  true);
    const momentumRanks = rank12m.map((r, i) =>
      0.50 * r + 0.30 * rank6m[i] + 0.20 * rank3m[i]
    );
    const momentumPct = percentileRanks(momentumRanks, true);

    // Risk ranks
    const volRanks    = percentileRanks(get('annualized_vol'),  false); // lower = better
    const sharpeRanks = percentileRanks(get('sharpe_ratio'),    true);
    const ddRanks     = percentileRanks(get('max_drawdown_1y'), false); // lower = better

    // Valuation rank: low PE (25%), high ROE (35%), low D/E (20%), high rev growth (20%)
    // Invert PE and D/E so higher percentile = better
    const peRanks  = percentileRanks(
      get('trailing_pe').map(v => (v && v > 0 && v < 200) ? v : null),
      false  // lower PE = better
    );
    const roeRanks = percentileRanks(get('return_on_equity'),   true);
    const deRanks  = percentileRanks(
      get('debt_to_equity').map(v => (v !== null && v >= 0) ? v : null),
      false  // lower D/E = better
    );
    const revGrRanks = percentileRanks(get('revenue_growth'), true);
    const valuationRanks = peRanks.map((r, i) =>
      0.25 * r + 0.35 * roeRanks[i] + 0.20 * deRanks[i] + 0.20 * revGrRanks[i]
    );
    const valuationPct = percentileRanks(valuationRanks, true);

    // Confluence rank
    const confluencePct = percentileRanks(get('screener_net_score'), true);

    // Quality rank: momentum × risk quality (low vol, high Sharpe, low drawdown)
    const qualityRanks = momentumPct.map((m, i) =>
      0.40 * m + 0.25 * sharpeRanks[i] + 0.20 * volRanks[i] + 0.15 * ddRanks[i]
    );
    const qualityPct = percentileRanks(qualityRanks, true);

    // Technical rank
    const techRanks = percentileRanks(get('technical_composite'), true);

    // Composite: 30% Screener, 20% Fundamentals, 15% Technical, 15% Momentum, 10% Institutional (50), 10% Historical (50)
    const compositeRanks = momentumPct.map((m, i) =>
      0.30 * confluencePct[i] + 0.20 * valuationPct[i] + 0.15 * techRanks[i] + 0.15 * m + 0.10 * 50 + 0.10 * 50
    );
    const compositePct = percentileRanks(compositeRanks, true);

    // Yield after all rank computation before hitting the DB
    await new Promise<void>(resolve => setImmediate(resolve));

    // ── Classify ────────────────────────────────────────────────────────────

    function classify(score: number): string {
      if (score >= 80) return 'Strong Buy';
      if (score >= 65) return 'Buy';
      if (score >= 40) return 'Hold';
      if (score >= 25) return 'Avoid';
      return 'Sell';
    }

    // ── Batch upsert ────────────────────────────────────────────────────────

    const UPSERT_SQL = `
      INSERT INTO quant_scores (
        symbol,
        return_1w, return_1m, return_3m, return_6m, return_12m,
        above_sma200, sma200_distance_pct, momentum_score,
        annualized_vol, sharpe_ratio, max_drawdown_1y,
        vol_rank, sharpe_rank,
        trailing_pe, forward_pe, debt_to_equity, return_on_equity,
        operating_margins, revenue_growth, piotroski_f_score, valuation_score,
        bullish_screener_count, bearish_screener_count,
        screener_category_breadth, screener_net_score, confluence_rank,
        rank_momentum, rank_quality, rank_value, rank_composite,
        composite_class, ohlcv_days, last_computed
      ) VALUES (
        ?,
        ?,?,?,?,?,
        ?,?,?,
        ?,?,?,
        ?,?,
        ?,?,?,?,
        ?,?,?,?,
        ?,?,
        ?,?,?,
        ?,?,?,?,
        ?,?,CURRENT_TIMESTAMP
      )
      ON CONFLICT(symbol) DO UPDATE SET
        return_1w = excluded.return_1w,
        return_1m = excluded.return_1m,
        return_3m = excluded.return_3m,
        return_6m = excluded.return_6m,
        return_12m = excluded.return_12m,
        above_sma200 = excluded.above_sma200,
        sma200_distance_pct = excluded.sma200_distance_pct,
        momentum_score = excluded.momentum_score,
        annualized_vol = excluded.annualized_vol,
        sharpe_ratio = excluded.sharpe_ratio,
        max_drawdown_1y = excluded.max_drawdown_1y,
        vol_rank = excluded.vol_rank,
        sharpe_rank = excluded.sharpe_rank,
        trailing_pe = excluded.trailing_pe,
        forward_pe = excluded.forward_pe,
        debt_to_equity = excluded.debt_to_equity,
        return_on_equity = excluded.return_on_equity,
        operating_margins = excluded.operating_margins,
        revenue_growth = excluded.revenue_growth,
        piotroski_f_score = excluded.piotroski_f_score,
        valuation_score = excluded.valuation_score,
        bullish_screener_count = excluded.bullish_screener_count,
        bearish_screener_count = excluded.bearish_screener_count,
        screener_category_breadth = excluded.screener_category_breadth,
        screener_net_score = excluded.screener_net_score,
        confluence_rank = excluded.confluence_rank,
        rank_momentum = excluded.rank_momentum,
        rank_quality = excluded.rank_quality,
        rank_value = excluded.rank_value,
        rank_composite = excluded.rank_composite,
        composite_class = excluded.composite_class,
        ohlcv_days = excluded.ohlcv_days,
        last_computed = CURRENT_TIMESTAMP
    `;

    await dbTransaction(async (tx) => {
      for (let i = 0; i < computed.length; i++) {
        const c = computed[i];
        await tx.run(UPSERT_SQL, [
          c.symbol,
          c.return_1w, c.return_1m, c.return_3m, c.return_6m, c.return_12m,
          c.above_sma200, c.sma200_distance_pct, momentumPct[i],
          c.annualized_vol, c.sharpe_ratio, c.max_drawdown_1y,
          volRanks[i], sharpeRanks[i],
          c.trailing_pe, c.forward_pe, c.debt_to_equity, c.return_on_equity,
          c.operating_margins, c.revenue_growth, c.piotroski_f_score, valuationPct[i],
          c.bullish_screener_count, c.bearish_screener_count,
          c.screener_category_breadth, c.screener_net_score, confluencePct[i],
          momentumPct[i], qualityPct[i], valuationPct[i], compositePct[i],
          classify(compositePct[i]),
          c.ohlcv_days,
        ]);
        scoringProgress.processed++;
      }
    });
    scoringProgress.completedAt = new Date().toISOString();
    await persistProgress();
    console.log(`[QUANT] Scoring complete — ${computed.length} symbols written to quant_scores`);

  } catch (err: any) {
    scoringProgress.lastError = err.message;
    await persistProgress();
    console.error('[QUANT] Scoring failed:', err.message);
    throw err;
  } finally {
    scoringProgress.isRunning = false;
    await persistProgress();
  }
}

// ─── Query helpers ────────────────────────────────────────────────────────────

export type Strategy = 'composite' | 'momentum' | 'quality' | 'value' | 'confluence' | 'investment_picks';

export interface StrategyFilters {
  minSharpe?: number;          // e.g. 0.5
  maxVol?: number;             // annualised % e.g. 35
  maxDrawdown?: number;        // 1-year % e.g. 30
  aboveSma200?: boolean;       // true = only uptrend stocks
  maxPE?: number;              // trailing PE cap
  minROE?: number;             // return on equity (decimal, e.g. 0.10 = 10%)
  maxDebtToEquity?: number;    // D/E cap (Yahoo stores as % so 100 = 1×)
  minPiotroski?: number;       // 0–9
  minMarketCapCr?: number;     // market cap in crores
}

export async function getStrategyStocks(
  strategy: Strategy = 'composite',
  limit = 25,
  filters: StrategyFilters = {},
): Promise<any[]> {
  let col = '';
  let customSelect = '';
  let customWhere = '';

  if (strategy === 'investment_picks') {
    col = '(0.40 * qs.rank_composite + 0.30 * qs.confluence_rank + 0.30 * qs.rank_quality)';
    customSelect = `, ${col} AS strategy_rank`;
    customWhere = `
      AND qs.above_sma200 = 1 
      AND (qs.return_on_equity IS NULL OR qs.return_on_equity >= 0.12)
      AND (qs.piotroski_f_score IS NULL OR qs.piotroski_f_score >= 5)
      AND (qs.debt_to_equity IS NULL OR qs.debt_to_equity < 150)
      AND qs.bullish_screener_count >= 3
      AND qs.bearish_screener_count <= 2
    `;
  } else {
    const rankCol: Record<Strategy, string> = {
      composite:  'rank_composite',
      momentum:   'rank_momentum',
      quality:    'rank_quality',
      value:      'rank_value',
      confluence: 'confluence_rank',
      investment_picks: '',
    };
    const cName = rankCol[strategy] || 'rank_composite';
    col = `qs.${cName}`;
    customSelect = `, ${col} AS strategy_rank`;
  }

  const selectColName = strategy === 'investment_picks' ? col : col;
  const conditions: string[] = [strategy === 'investment_picks' ? 'qs.rank_composite IS NOT NULL' : `${col} IS NOT NULL`];
  const params: any[] = [];

  if (filters.aboveSma200) {
    conditions.push('qs.above_sma200 = 1');
  }
  if (filters.minSharpe !== undefined) {
    conditions.push('qs.sharpe_ratio >= ?');
    params.push(filters.minSharpe);
  }
  if (filters.maxVol !== undefined) {
    conditions.push('qs.annualized_vol <= ?');
    params.push(filters.maxVol);
  }
  if (filters.maxDrawdown !== undefined) {
    conditions.push('qs.max_drawdown_1y <= ?');
    params.push(filters.maxDrawdown);
  }
  if (filters.maxPE !== undefined) {
    conditions.push('(qs.trailing_pe IS NULL OR qs.trailing_pe <= ?)');
    params.push(filters.maxPE);
  }
  if (filters.minROE !== undefined) {
    conditions.push('(qs.return_on_equity IS NULL OR qs.return_on_equity >= ?)');
    params.push(filters.minROE);
  }
  if (filters.maxDebtToEquity !== undefined) {
    conditions.push('(qs.debt_to_equity IS NULL OR qs.debt_to_equity <= ?)');
    params.push(filters.maxDebtToEquity);
  }
  if (filters.minPiotroski !== undefined) {
    conditions.push('(qs.piotroski_f_score IS NULL OR qs.piotroski_f_score >= ?)');
    params.push(filters.minPiotroski);
  }
  if (filters.minMarketCapCr !== undefined) {
    const capInr = filters.minMarketCapCr * 1e7;
    conditions.push('(sf.market_cap IS NULL OR sf.market_cap >= ?)');
    params.push(capInr);
  }

  const where = conditions.join(' AND ');
  params.push(limit);

  const rows = await dbAll(`
    SELECT
      qs.symbol,
      ns.name,
      ns.sector,
      -- momentum
      qs.return_1w, qs.return_1m, qs.return_3m, qs.return_6m, qs.return_12m,
      qs.above_sma200, qs.sma200_distance_pct, qs.momentum_score,
      -- risk
      qs.annualized_vol, qs.sharpe_ratio, qs.max_drawdown_1y,
      qs.vol_rank, qs.sharpe_rank,
      -- fundamentals
      qs.trailing_pe, qs.forward_pe, qs.debt_to_equity,
      qs.return_on_equity, qs.operating_margins, qs.revenue_growth,
      qs.piotroski_f_score, qs.valuation_score,
      -- screeners
      qs.bullish_screener_count, qs.bearish_screener_count,
      qs.screener_category_breadth, qs.screener_net_score, qs.confluence_rank,
      -- composite ranks
      qs.rank_momentum, qs.rank_quality, qs.rank_value, qs.rank_composite,
      qs.composite_class, qs.ohlcv_days,
      -- live price ref
      sf.market_cap, sf.analyst_rating
      ${customSelect}
    FROM quant_scores qs
    LEFT JOIN nse_stocks  ns ON ns.symbol = qs.symbol
    LEFT JOIN stock_fundamentals sf ON sf.symbol = qs.symbol
    WHERE ${where} ${customWhere}
    ORDER BY ${selectColName} DESC
    LIMIT ?
  `, params) as any[];

  return rows;
}

export async function getQuantScore(symbol: string): Promise<any | null> {
  return await dbGet(`
    SELECT qs.*, ns.name, ns.sector, sf.market_cap, sf.analyst_rating,
           sf.book_value, sf.eps_ttm, sf.eps_forward, sf.dividend_yield,
           sf.fifty_two_week_high, sf.fifty_two_week_low, sf.avg_volume_3m
    FROM quant_scores qs
    LEFT JOIN nse_stocks ns ON ns.symbol = qs.symbol
    LEFT JOIN stock_fundamentals sf ON sf.symbol = qs.symbol
    WHERE qs.symbol = ?
  `, [symbol]) as any | null;
}

export async function getQuantScoreSummary(): Promise<{
  totalScored: number;
  byClass: Record<string, number>;
  lastComputed: string | null;
}> {
  const total = ((await dbGet('SELECT COUNT(*) as n FROM quant_scores')) as any).n;
  const classes = await dbAll(
    `SELECT composite_class, COUNT(*) as n FROM quant_scores GROUP BY composite_class`
  ) as any[];
  const byClass: Record<string, number> = {};
  for (const r of classes) byClass[r.composite_class] = r.n;
  const ts = ((await dbGet(
    `SELECT last_computed FROM quant_scores ORDER BY last_computed DESC LIMIT 1`
  )) as any)?.last_computed ?? null;
  return { totalScored: total, byClass, lastComputed: ts };
}
