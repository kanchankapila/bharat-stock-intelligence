import { dbTransaction } from './dbAsync';
import { fetchNiftyTraderStockData } from './niftytraderService';
import { getAllStocks } from './stockMapping';
import { getTrendlyneDVMFromDb } from './trendlyneService';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jittered = (base: number, jitterPercent: number) => {
  const min = base * (1 - jitterPercent / 100);
  const max = base * (1 + jitterPercent / 100);
  return Math.random() * (max - min) + min;
};

export async function syncNiftyTraderScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[NIFTYTRADER SCORES] Starting sync for ${stocks.length} symbols...`);

  const baseDelay = Number(process.env.TRENDLYNE_BASE_DELAY_MS || '400');
  const jitterPercent = Number(process.env.TRENDLYNE_JITTER_PERCENT || '20');

  let count = 0;
  let consecutiveFailures = 0;
  for (const stock of stocks) {
    try {
      const data = await fetchNiftyTraderStockData(stock.symbol);
      if (!data) {
        consecutiveFailures++;
        if (consecutiveFailures >= 5) {
          console.warn(`[NIFTYTRADER SCORES] 5 consecutive failures. Cool down for 30s...`);
          await new Promise(r => setTimeout(r, 30000));
          consecutiveFailures = 0;
        }
        continue;
      }
      consecutiveFailures = 0;

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      const stockTrend = data.analysisData?.stocktrend;
      if (stockTrend) {
        let techScore = 0;
        if (stockTrend.close > stockTrend.sma_20_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_50_days) techScore += 1; else techScore -= 1;
        if (stockTrend.close > stockTrend.sma_200_days) techScore += 2; else techScore -= 2;
        if (stockTrend.performance_20_days > 0) techScore += 1; else techScore -= 1;

        const normalizedScore = (techScore + 5) * 10;
        let label = 'Neutral';
        if (normalizedScore >= 80) label = 'Very Bullish';
        else if (normalizedScore >= 60) label = 'Bullish';
        else if (normalizedScore <= 20) label = 'Very Bearish';
        else if (normalizedScore <= 40) label = 'Bearish';

        stockUpserts.push([stock.symbol, date, 'technical_rating', normalizedScore, label]);
        count++;
      }

      // NOTE: NiftyTrader's stock-financial-data response no longer carries a `fin_score`
      // field (confirmed live 2026-08-06 — it now returns market_cap/book_value/stock_pe/
      // dividend_yield/roce/roe/sales_growth/face_value/current_price instead). This read
      // was always undefined against the current API shape, so 'financial_score' has zero
      // rows in proprietary_scores_history — a silent no-op, not a real data source. Every
      // field the endpoint DOES return is already covered elsewhere at equal-or-better
      // coverage (stock_fundamentals: market_cap 93.8%, book_value 97.1%, trailing_pe 79.1%,
      // revenue_growth 93.0%; tl_financial_quality.roce 97.7%; historical_fundamentals.roe
      // 77.7%) — not worth reviving as a 4th duplicate source. Removed rather than fixed.

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'niftytrader', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
      }
    } catch (e: any) {
      console.error(`[NIFTYTRADER SCORES] Error for ${stock.symbol}:`, e.message);
    }

    // Jittered sleep to evade rate limits
    await sleep(jittered(baseDelay, jitterPercent));
  }
  
  console.log(`[NIFTYTRADER SCORES] Synced ${count} scores.`);
}

export async function syncTrendlyneScores() {
  const stocks = getAllStocks(); // Sync all symbols
  const date = new Date().toISOString().split('T')[0];
  console.log(`[TRENDLYNE SCORES] Starting sync for ${stocks.length} symbols...`);

  let count = 0;

  for (const stock of stocks) {
    try {
      // DVM comes from trendlyne_dvm_scores (no live request). Checklist now has
      // its own dedicated pipeline (trendlyne-checklist-cycle queue, see queues.ts) —
      // running it here too would create a second, uncontrolled 3,000-request burst
      // once a day, defeating the whole point of pacing it.
      const dvm = await getTrendlyneDVMFromDb(stock.symbol);

      if (!dvm) {
        continue;
      }

      const stockUpserts: Array<[string, string, string, number, string]> = [];

      if (dvm) {
        for (const [type, leg] of Object.entries(dvm) as Array<[string, { score: number; color: string | null } | null]>) {
          if (leg) stockUpserts.push([stock.symbol, date, type, leg.score, leg.color || '']);
        }
      }

      if (stockUpserts.length > 0) {
        await dbTransaction(async (tx) => {
          for (const [sym, dt, scoreType, value, lbl] of stockUpserts) {
            await tx.run(`
              INSERT INTO proprietary_scores_history (symbol, date, source, score_type, score_value, score_label)
              VALUES (?, ?, 'trendlyne', ?, ?, ?)
              ON CONFLICT(symbol, date, source, score_type) DO UPDATE SET
                score_value = excluded.score_value,
                score_label = excluded.score_label,
                updated_at  = CURRENT_TIMESTAMP
            `, [sym, dt, scoreType, value, lbl]);
          }
        });
        count++;
      }
    } catch (e: any) {
      console.error(`[TRENDLYNE SCORES] Error for ${stock.symbol}:`, e.message);
    }
  }

  console.log(`[TRENDLYNE SCORES] Synced ${count} stocks.`);
  await stampDvmOntoTechnicalSignals();
}

/**
 * Copy trendlyne_dvm_scores onto technical_signals.dvm_durability/dvm_valuation/dvm_momentum.
 *
 * These three columns had NO writer anywhere in the repo -- yet ml_ensemble.py reads all three
 * (`num('dvm_momentum', 50.0)`) and exit_policy.py joins them. With nothing populating them the
 * model was being handed a fabricated constant 50.0 for every stock on every date, which is the
 * "coercing fabricates a value" failure in .claude/rules/recurring-bugs.md: a hardcoded default
 * is not a neutral no-op, it is a wrong number the model cannot distinguish from a real one.
 * The data existed in trendlyne_dvm_scores (24,748 rows / 2,007 symbols) the whole time and was
 * simply never joined across.
 *
 * Point-in-time safe: joins on (symbol, date), so a score lands only on the grid row for the
 * date it was actually observed -- never smeared backwards, unlike the snapshot-table leak
 * extra_features_parser.py guards against. trendlyne_dvm_scores has a real date dimension
 * (median 12 distinct dates per symbol), which is what makes that join meaningful rather than
 * cosmetic. Trendlyne publishes DVM roughly weekly, so this fills ~1,660 rows per fetch date
 * and leaves the rest NULL by design -- densify_feature_matrix.py forward-fills the gaps under
 * its own age cap, the standard path for every sparse column on this grid.
 *
 * Set-based on purpose: the loop above is per-symbol, and adding an UPDATE inside it would make
 * this N+1 across ~2,000 symbols.
 *
 * NOT yet gradeable for edge: 17 distinct dates starting 2026-06-30 puts DVM squarely in the
 * "Not testable -- calendar constraint" bucket in .claude/rules/measurement.md. This is a
 * correctness fix (stop feeding the model a fabricated constant), NOT a claim that DVM predicts
 * anything. Re-check once the panel is deep enough for factor_backtest.py to say.
 */
async function stampDvmOntoTechnicalSignals(): Promise<void> {
  try {
    const res = await dbTransaction(async (tx) => tx.run(`
      UPDATE technical_signals AS ts SET
        dvm_durability = d.d_score,
        dvm_valuation  = d.v_score,
        dvm_momentum   = d.m_score
      FROM trendlyne_dvm_scores AS d
      WHERE d.symbol = ts.symbol
        AND d.date = ts.date
        AND (ts.dvm_durability IS NULL OR ts.dvm_valuation IS NULL OR ts.dvm_momentum IS NULL)
    `));
    console.log(`[TRENDLYNE SCORES] Stamped DVM onto technical_signals (${(res as any)?.changes ?? '?'} rows).`);
  } catch (e: any) {
    // Best-effort, exactly like every other enrichment step in this pipeline: a DVM stamping
    // failure must not fail the whole quant-scoring job.
    console.warn('[TRENDLYNE SCORES] DVM stamping failed:', e.message);
  }
}
