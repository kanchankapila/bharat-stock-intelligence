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

import { Worker } from 'worker_threads';
import path from 'path';
import { fileURLToPath } from 'url';
import { dbGet, dbAll, dbRun, dbTransaction } from './dbAsync';

const MIN_DAYS  = 240; // require ~1 full trading year

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function runQuantWorker(workerData: unknown): Promise<{
  computed: Record<string, unknown>[];
  momentumPct: number[];
  volRanks: number[];
  sharpeRanks: number[];
  valuationPct: number[];
  confluencePct: number[];
  qualityPct: number[];
  compositePct: number[];
}> {
  return new Promise((resolve, reject) => {
    const workerPath = path.join(__dirname, 'quantScoringWorker.js');
    const worker = new Worker(workerPath, { workerData });
    worker.once('message', resolve);
    worker.once('error',   reject);
    worker.once('exit', code => {
      if (code !== 0) reject(new Error(`quantScoringWorker exited with code ${code}`));
    });
  });
}

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
  const _quantFallbackTimer = setInterval(() => {
    console.log('[QUANT] Triggering daily quant strategy scoring (fallback)');
    runQuantScoring().catch(err =>
      console.error('[QUANT] Scheduled fallback error:', (err as Error).message)
    );
  }, 24 * 60 * 60 * 1000);
  _quantFallbackTimer.unref?.();
}

// Math helpers and percentileRanks live in quantScoringWorker.ts (worker thread).

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

    // Limit to 500 trading days (~2 years) — enough for 252-day return + vol metrics.
    // Loading the full table (millions of rows) blocks the event loop during deserialization.
    const ohlcvCutoff = new Date();
    ohlcvCutoff.setDate(ohlcvCutoff.getDate() - 500);
    const cutoffStr = ohlcvCutoff.toISOString().slice(0, 10);

    const allRows = await dbAll(
      `SELECT symbol, date, close, volume FROM stock_ohlcv
       WHERE close > 0 AND date >= ? ORDER BY symbol, date ASC`,
      [cutoffStr]
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

    // ── Delegate all CPU work to a worker thread ────────────────────────────
    // Maps are serialised to plain objects for structured-clone transfer.

    console.log('[QUANT] Starting worker thread for metric + rank computation…');
    const {
      computed,
      momentumPct,
      volRanks,
      sharpeRanks,
      valuationPct,
      confluencePct,
      qualityPct,
      compositePct,
    } = await runQuantWorker({
      eligible,
      screenerMap: Object.fromEntries(screenerMap),
      fundMap:     Object.fromEntries(fundMap),
      techMap:     Object.fromEntries(techMap),
    });
    console.log(`[QUANT] Worker done — ${computed.length} symbols computed`);

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

    // Batch upsert in chunks of 50 rows — reduces 500 round-trips to ~10.
    // translateSql converts ? → $N for Postgres; multi-row VALUES works on both engines.
    const BATCH_SIZE = 50;
    const ROW_PLACEHOLDER = `(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,CURRENT_TIMESTAMP)`;
    const BATCH_COLUMNS = `symbol,
        return_1w, return_1m, return_3m, return_6m, return_12m,
        above_sma200, sma200_distance_pct, momentum_score,
        annualized_vol, sharpe_ratio, max_drawdown_1y,
        vol_rank, sharpe_rank,
        trailing_pe, forward_pe, debt_to_equity, return_on_equity,
        operating_margins, revenue_growth, piotroski_f_score, valuation_score,
        bullish_screener_count, bearish_screener_count,
        screener_category_breadth, screener_net_score, confluence_rank,
        rank_momentum, rank_quality, rank_value, rank_composite,
        composite_class, ohlcv_days, last_computed`;
    const CONFLICT_SET = `return_1w=excluded.return_1w, return_1m=excluded.return_1m,
        return_3m=excluded.return_3m, return_6m=excluded.return_6m,
        return_12m=excluded.return_12m, above_sma200=excluded.above_sma200,
        sma200_distance_pct=excluded.sma200_distance_pct,
        momentum_score=excluded.momentum_score, annualized_vol=excluded.annualized_vol,
        sharpe_ratio=excluded.sharpe_ratio, max_drawdown_1y=excluded.max_drawdown_1y,
        vol_rank=excluded.vol_rank, sharpe_rank=excluded.sharpe_rank,
        trailing_pe=excluded.trailing_pe, forward_pe=excluded.forward_pe,
        debt_to_equity=excluded.debt_to_equity, return_on_equity=excluded.return_on_equity,
        operating_margins=excluded.operating_margins, revenue_growth=excluded.revenue_growth,
        piotroski_f_score=excluded.piotroski_f_score, valuation_score=excluded.valuation_score,
        bullish_screener_count=excluded.bullish_screener_count,
        bearish_screener_count=excluded.bearish_screener_count,
        screener_category_breadth=excluded.screener_category_breadth,
        screener_net_score=excluded.screener_net_score, confluence_rank=excluded.confluence_rank,
        rank_momentum=excluded.rank_momentum, rank_quality=excluded.rank_quality,
        rank_value=excluded.rank_value, rank_composite=excluded.rank_composite,
        composite_class=excluded.composite_class, ohlcv_days=excluded.ohlcv_days,
        last_computed=CURRENT_TIMESTAMP`;

    await dbTransaction(async (tx) => {
      for (let batch = 0; batch < computed.length; batch += BATCH_SIZE) {
        const chunk = computed.slice(batch, batch + BATCH_SIZE);
        const batchSql = `INSERT INTO quant_scores (${BATCH_COLUMNS})
          VALUES ${chunk.map(() => ROW_PLACEHOLDER).join(',')}
          ON CONFLICT(symbol) DO UPDATE SET ${CONFLICT_SET}`;
        const batchParams = chunk.flatMap((c, j) => {
          const i = batch + j;
          return [
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
          ];
        });
        await tx.run(batchSql, batchParams);
        scoringProgress.processed += chunk.length;
        await new Promise<void>(resolve => setImmediate(resolve)); // yield between batches
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
