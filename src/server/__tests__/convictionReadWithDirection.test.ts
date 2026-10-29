import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun } = await import('../dbAsync');
const { cacheDel } = await import('../cacheService');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');
const { invalidateUrLatestAt } = await import('../routers/commandCenter.router');

// AF-20261021-01: unified_recommendations.conviction_level is direction-agnostic -- S_ELITE and
// A_HIGH sit on Strong Sell / Sell rows as well as on buys. A reader that filters on it alone
// presents sells as top-conviction picks.
const caller = createCallerFactory(appRouter)({} as any);
const AT = '2026-10-28T00:00:00.000Z';

async function ur(symbol: string, classification: string, conviction: string, score: number) {
  await dbRun(`INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level,
      classification, bullish_screener_count, bearish_screener_count, stop_loss, target_1)
    VALUES (?, ?, 'SIDEWAYS', ?, ?, ?, 3, 0, ?, ?)`,
    [symbol, AT, score, conviction, classification, classification.includes('Sell') ? 120 : 90, classification.includes('Sell') ? 80 : 115]);
}

beforeEach(async () => {
  for (const t of ['unified_recommendations', 'signal_outcomes', 'quant_scores', 'nse_stocks', 'market_regimes']) await dbExec(`DELETE FROM ${t}`);
  invalidateUrLatestAt();
  await ur('CV_BUY', 'Strong Buy', 'S_ELITE', 90);
  await ur('CV_SELL', 'Strong Sell', 'S_ELITE', 10);
  await ur('CV_ABUY', 'Buy', 'A_HIGH', 75);
  await ur('CV_ASELL', 'Sell', 'A_HIGH', 25);
});

describe('conviction is read together with direction', () => {
  it('screener confluence: a conviction filter returns only buy-side rows', async () => {
    const res: any = await caller.getScreenerConfluenceUniverse({ conviction: 'S_ELITE' });
    expect(res.stocks.map((s: any) => s.symbol)).toEqual(['CV_BUY']);
  });

  it('best combo signals: a Sell-side canonical row neither corroborates nor supplies levels', async () => {
    await dbRun(`INSERT INTO market_regimes (date, regime, regime_prob) VALUES ('2026-10-28', 'SIDEWAYS', 0.8)`);
    for (const s of ['CV_ABUY', 'CV_ASELL']) {
      await dbRun(`INSERT INTO nse_stocks (symbol, name, sector, status) VALUES (?, ?, 'Financials', 'ACTIVE')`, [s, s]);
      await dbRun(`INSERT INTO quant_scores (symbol, piotroski_f_score, above_sma200, sharpe_ratio, rank_composite) VALUES (?, 8, 1, 1.5, 90)`, [s]);
      await dbRun(`INSERT INTO signal_outcomes (symbol, signal_date, horizon_days, outcome, signal_source, signal_score, entry_price, signals_json)
        VALUES (?, '2026-10-27', 5, 'PENDING', 'technical', 6, 100, '[{"type":"EMA_BULL_STACK"}]')`, [s]);
    }
    await cacheDel('scoring:best-combo');
    const strict: any = await caller.getBestComboSignals({ requireUnifiedRec: true });
    expect(strict.stocks.map((s: any) => s.symbol)).toEqual(['CV_ABUY']);
    const loose: any = await caller.getBestComboSignals({ requireUnifiedRec: false });
    const sell = loose.stocks.find((s: any) => s.symbol === 'CV_ASELL');
    expect(sell).toBeDefined();
    expect(sell.convictionLevel ?? sell.conviction_level ?? null).toBeNull();
    expect(Number(sell.stopLoss ?? sell.stop_loss)).toBeLessThan(100);
  });
});
