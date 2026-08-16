import { describe, it, expect, beforeEach } from 'vitest';

const { dbRun } = await import('../dbAsync');
const { createCallerFactory } = await import('../trpc');
const { appRouter } = await import('../router');

const caller = createCallerFactory(appRouter)({} as any);

describe('getAdvanceDecline', () => {
  it('accepts being called with no input at all (the shape every current frontend caller uses)', async () => {
    // Regression: z.object({ex: z.string().optional()}) without an outer .optional() rejects
    // `undefined` input with "expected object, received undefined" -- TradeDecisionCockpit.tsx
    // calls trpc.getAdvanceDecline.useQuery(undefined, ...), which hit exactly this. The
    // request never throws visibly to the user because it's part of a batched call that
    // returns 207 Multi-Status; the Adv/Dec figure just silently rendered "—" forever.
    await expect(caller.getAdvanceDecline(undefined)).resolves.toBeDefined();
  });

  it('still accepts an explicit ex parameter (existing MCIndexDetailPanel.tsx call shape)', async () => {
    await expect(caller.getAdvanceDecline({ ex: 'B' })).resolves.toBeDefined();
  });
});

describe('getMultiFactorScores / getRiskMetrics NaN guard', () => {
  beforeEach(async () => {
    await dbRun(`DELETE FROM quant_scores WHERE symbol = ?`, ['RISKTST1']);
  });

  it('emits a NULLIF(...,\'NaN\'::float8) guard around every mf_* column so Postgres NaN cannot rank #1 or leak to the UI as text "NaN"', async () => {
    // Real live bug (2026-08-04): multi_factor_scorer.py can compute a genuine IEEE754 NaN
    // (e.g. z-score against a zero-stdev factor); Postgres stores/returns it as a valid
    // non-null float that sorts GREATER than every real number, so a naive `IS NOT NULL` +
    // `ORDER BY ... DESC` put the broken row at rank #1 of "top stocks by multi-factor score",
    // and the frontend's `value != null` guards don't catch NaN either (NaN != null is true).
    // Can't reproduce genuine Postgres NaN storage/comparison semantics against the SQLite
    // dev-fallback DB this suite runs against, so this pins the SQL text itself -- reverting
    // the NULLIF wrapper (e.g. back to a bare `qs.mf_composite_score`) fails this test even
    // though the underlying query still runs fine on SQLite.
    const fs = await import('node:fs');
    const path = await import('node:path');
    const src = fs.readFileSync(path.join(import.meta.dirname, '../routers/risk.router.ts'), 'utf-8');

    expect(src).toContain("NULLIF(${alias}.${c}, 'NaN'::float8)");
    expect(src).toContain("NULLIF(${alias}.mf_composite_score, 'NaN'::float8) IS NOT NULL");
    expect(src).toContain("ORDER BY NULLIF(qs.mf_composite_score, 'NaN'::float8) DESC");
  });

  it('getMultiFactorScores still returns real rows on the non-Postgres path (no crash)', async () => {
    await dbRun(
      `INSERT INTO quant_scores (symbol, mf_composite_score, mf_quality_score, mf_momentum_score, mf_value_score, mf_risk_adj_score, mf_macro_score)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      ['RISKTST1', 72.5, 60, 55, 50, 65, 70],
    );
    const rows = await caller.getMultiFactorScores({ limit: 50, minScore: 0 });
    const row = rows.find((r: any) => r.symbol === 'RISKTST1');
    expect(row).toBeTruthy();
    expect(row.mf_composite_score).toBe(72.5);
  });
});
