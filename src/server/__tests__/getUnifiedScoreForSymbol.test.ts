import { beforeEach, describe, expect, it } from 'vitest';

const { dbExec, dbRun, dbGet, dbAll } = await import('../dbAsync');
import { createCallerFactory } from '../trpc';

const { appRouter } = await import('../router');
const createCaller = createCallerFactory(appRouter);
const caller = createCaller({} as any);

beforeEach(async () => {
  await dbExec('DELETE FROM market_claim_evidence');
  await dbExec('DELETE FROM market_claim');
  await dbExec('DELETE FROM market_evidence');
  await dbExec('DELETE FROM market_graph_edge');
  await dbExec('DELETE FROM market_graph_node');
  await dbExec('DELETE FROM unified_recommendations');
  await dbExec('DELETE FROM technical_signals');
});

describe('getUnifiedScoreForSymbol', () => {
  it('returns the latest unified_recommendations row merged with technical_signals features', async () => {
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level, timeframe, sector, classification)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01T07:30:00Z', 'BULL', 78.5, 'A_HIGH', 'swing', 'IT', 'Buy']);

    await dbRun(`
      INSERT INTO technical_signals (symbol, date, win_probability, rsi, is_nifty50, asm_flag)
      VALUES (?, ?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01', 0.62, 71, 1, 0]);

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result).toBeTruthy();
    expect(result.unified_score).toBe(78.5);
    expect(result.conviction_level).toBe('A_HIGH');
    expect(result.win_probability).toBe(0.62);
    expect(result.rsi).toBe(71);
    expect(result.is_nifty50).toBe(1);
  });

  it('returns null for a symbol with no unified_recommendations row (not ranked today)', async () => {
    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'NOTRANKED' });
    expect(result).toBeNull();
  });

  it('only returns the latest computed_at snapshot, not stale older rows', async () => {
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `, ['TEST', '2026-07-30T07:30:00Z', 'BULL', 50, 'C_LOW']);
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01T07:30:00Z', 'BULL', 90, 'S_ELITE']);

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result.unified_score).toBe(90);
    expect(result.conviction_level).toBe('S_ELITE');
  });

  it('returns the latest grounded ontology claim and its evidence', async () => {
    await dbRun(`
      INSERT INTO unified_recommendations (symbol, computed_at, regime, unified_score, conviction_level)
      VALUES (?, ?, ?, ?, ?)
    `, ['TEST', '2026-08-01T07:30:00Z', 'BULL', 90, 'S_ELITE']);
    const node = await dbGet<{ node_id: number }>(`
      INSERT INTO market_graph_node
        (node_key, node_type, label, canonical_symbol, source)
      VALUES (?, ?, ?, ?, ?)
      RETURNING node_id
    `, ['NSE:TEST', 'instrument', 'TEST', 'TEST', 'unified_recommendations']);
    await dbRun(`
      INSERT INTO market_claim
        (claim_key, subject_node_id, predicate, object_value, stance, claim_status, method, available_at)
      VALUES (?, ?, 'canonical_recommendation', ?::jsonb, 'bullish', 'inferred', ?, ?)
    `, ['claim:test', node!.node_id, JSON.stringify({ score: 90 }), 'ranker-v1', '2026-08-01T08:00:00Z']);
    await dbRun(`
      INSERT INTO market_evidence
        (evidence_key, source_type, content, available_at, quality_status)
      VALUES (?, ?, ?::jsonb, ?, 'candidate')
    `, ['evidence:test', 'component_score', JSON.stringify({ metric: 'ml_score', note: 'not a probability' }), '2026-08-01T08:00:00Z']);
    await dbRun(`
      INSERT INTO market_claim_evidence (claim_key, evidence_key, relation)
      VALUES (?, ?, 'supports')
    `, ['claim:test', 'evidence:test']);

    const result = await caller.getUnifiedScoreForSymbol({ symbol: 'TEST' });
    expect(result.ontologyClaim.claim_status).toBe('inferred');
    expect(result.ontologyClaim.evidence).toHaveLength(1);
    expect(result.ontologyClaim.evidence[0].content.metric).toBe('ml_score');
  });
});
