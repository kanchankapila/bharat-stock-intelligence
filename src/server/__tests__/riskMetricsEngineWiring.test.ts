import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/**
 * Regression test for the 2026-08-07 dead-column fix: quant_scores.beta_1y/beta_6m/
 * sortino_ratio/var_95 had a fully-built writer (risk_metrics_engine.py) that was never
 * scheduled anywhere -- confirmed live, 0/2,424 rows populated before this fix; 2,422/2,424
 * (99.9%) after wiring it into processQuantScoring alongside multi_factor_scorer.py.
 */
const SOURCE = readFileSync(join(__dirname, '..', 'jobs', 'screeners.jobs.ts'), 'utf8');

describe('quant-scoring risk-metrics wiring', () => {
  it('processQuantScoring calls risk_metrics_engine.py', () => {
    expect(SOURCE).toMatch(/runPython\(['"]risk_metrics_engine\.py['"]/);
  });

  it('runs AFTER runQuantScoring() (needs the row to already exist for its UPDATE)', () => {
    const quantScoringIdx = SOURCE.indexOf('runQuantScoring()');
    const riskEngineIdx = SOURCE.indexOf("risk_metrics_engine.py");
    expect(quantScoringIdx).toBeGreaterThan(-1);
    expect(riskEngineIdx).toBeGreaterThan(-1);
    expect(quantScoringIdx).toBeLessThan(riskEngineIdx);
  });

  it('is inside processQuantScoring, not some other job', () => {
    const fnStart = SOURCE.indexOf('async function processQuantScoring');
    const fnEnd = SOURCE.indexOf('\n}', fnStart);
    const riskEngineIdx = SOURCE.indexOf('risk_metrics_engine.py');
    expect(fnStart).toBeGreaterThan(-1);
    expect(riskEngineIdx).toBeGreaterThan(fnStart);
    expect(riskEngineIdx).toBeLessThan(fnEnd);
  });
});
