import { beforeEach, describe, expect, it } from 'vitest';

process.env.DATABASE_URL = ':memory:';
// Isolates this test from the host environment's USE_POSTGRES -- see backtestRunner.test.ts
// for the full explanation of why this must be set before any dbAsync.ts import.
process.env.USE_POSTGRES = 'false';
const dbModule = await import('../db');
const db = dbModule.default;
const { getStrategyStocks } = await import('../quantScoringService');

beforeEach(() => {
  ['quant_scores', 'unified_recommendations', 'nse_stocks', 'stock_fundamentals']
    .forEach(table => db.exec(`DELETE FROM ${table}`));
});

const insertQS = (symbol: string, rankComposite: number) =>
  db.prepare(`INSERT INTO quant_scores (symbol, rank_composite) VALUES (?, ?)`).run(symbol, rankComposite);

const insertUR = (symbol: string, computedAt: string, unifiedScore = 80) =>
  db.prepare(`INSERT INTO unified_recommendations
    (symbol, computed_at, regime, unified_score, conviction_level, classification)
    VALUES (?, ?, 'BULL', ?, 'B_MEDIUM', 'Buy')`).run(symbol, computedAt, unifiedScore);

// unified_recommendations context for getStrategyStocks (score-consolidation, 2026-08). A
// straight table swap (like getTopRatedStocks' UR-first/stock_scores-fallback) doesn't work
// here -- UR and quant_scores share no filterable columns -- so this adds read-only context
// columns plus an opt-in coverage gate that never changes default filtering/ranking.
describe('getStrategyStocks unified_recommendations involvement', () => {
  it('surfaces ur_unified_score/ur_classification as extra context by default (no filtering change)', async () => {
    insertQS('A', 90);
    insertQS('B', 80);
    insertUR('A', new Date().toISOString().split('T')[0], 77);

    const rows = await getStrategyStocks('composite', 10, {}) as any[];

    expect(rows.map(r => r.symbol).sort()).toEqual(['A', 'B']);
    const a = rows.find(r => r.symbol === 'A');
    const b = rows.find(r => r.symbol === 'B');
    expect(a.ur_unified_score).toBe(77);
    expect(a.ur_classification).toBe('Buy');
    expect(b.ur_unified_score ?? null).toBeNull();
  });

  it('requireUnifiedCoverage restricts to symbols in the latest UR snapshot when UR has rows', async () => {
    insertQS('A', 90);
    insertQS('B', 80);
    insertUR('A', new Date().toISOString().split('T')[0]);

    const rows = await getStrategyStocks('composite', 10, { requireUnifiedCoverage: true }) as any[];

    expect(rows.map(r => r.symbol)).toEqual(['A']);
  });

  it('requireUnifiedCoverage falls back to the full quant_scores universe when UR is empty (cold start)', async () => {
    insertQS('A', 90);
    insertQS('B', 80);

    const rows = await getStrategyStocks('composite', 10, { requireUnifiedCoverage: true }) as any[];

    expect(rows.map(r => r.symbol).sort()).toEqual(['A', 'B']);
  });

  it('requireUnifiedCoverage only matches the LATEST UR snapshot, not a stale earlier one', async () => {
    insertQS('A', 90);
    insertQS('B', 80);
    insertUR('A', '2020-01-01'); // stale snapshot -- must not count as coverage
    const today = new Date().toISOString().split('T')[0];
    insertUR('B', today);

    const rows = await getStrategyStocks('composite', 10, { requireUnifiedCoverage: true }) as any[];

    expect(rows.map(r => r.symbol)).toEqual(['B']);
  });
});
