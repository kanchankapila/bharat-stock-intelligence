// Task 4.4: measurement baseline over the rebuilt panel. Per the panel
// spec (.claude/rules/measurement.md): per-date then averaged, winsorised,
// liquidity floor, next-session-open entry -- all already enforced inside
// computeIC/computeAnnualizedExcessReturn (Task 4.3). Records every result
// in audit_metric with run_id/data_watermark/params_hash/code_commit, per
// Task 4.4's own verify requirement.
//
// Precondition (Task 4.4 step 1): the harness must have passed all four
// negative controls in Task 4.3 -- `npx vitest run src/stage4/research-harness.test.ts`
// exits 0. This script does not re-run that suite itself (it's a separate,
// already-CI-runnable command); it is a documented precondition, checked
// before this script is ever invoked.
//
// Usage: tsx src/stage4/run-measurement-baseline.ts
import { createHash } from 'node:crypto';
import {
  closeRun, createPool, insertAuditMetric, openRun, queryFeatureSnapshotMetricSeries, queryOpenPriceSeries,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { computeAnnualizedExcessReturn, computeForwardReturns, computeIC } from './research-harness.js';
import { FEATURE_SET_VERSION } from './compute-features.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage4-measurement-baseline';

// All 12 v1 metrics -- forward_only_not_in_v1_history's 4 are excluded from
// feature_set v1 entirely (see record-feature-set.ts), so there is nothing
// to measure for them.
const FACTORS = [
  'momentum_21d', 'momentum_63d', 'delivery_pct', 'delivery_pct_ma20',
  'pe_pct_rank_252d', 'pb_pct_rank_252d', 'eps_ttm', 'eps_growth_yoy',
  'div_yield_ttm', 'fii_net_21d', 'dii_net_21d', 'screener_breadth',
];
const REBALANCE_DAYS = [5, 21];

async function seedRegistry(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage4.measurement_baseline', 'Task 4.4 measurement baseline over the rebuilt feature panel', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );
}

interface FactorResult {
  factor: string;
  rebalanceDays: number;
  meanIC: number | null;
  tStat: number | null;
  nDates: number;
  annualizedExcessReturnPct: number | null;
  nPeriods: number;
}

async function main(): Promise<void> {
  const pool = createPool();
  await seedRegistry(pool);

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage4.measurement_baseline', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  const results: FactorResult[] = [];

  try {
    console.log('[measurement] loading open-price panel...');
    const bars = await queryOpenPriceSeries(pool);
    console.log(`[measurement] ${bars.length} (symbol, session_date) bars`);

    const returnsByRebalance = new Map(REBALANCE_DAYS.map((d) => [d, computeForwardReturns(bars, d)]));

    for (const factor of FACTORS) {
      console.log(`[measurement] loading factor series: ${factor}...`);
      const points = await queryFeatureSnapshotMetricSeries(pool, factor, FEATURE_SET_VERSION);
      const factorPoints = points.map((p) => ({ symbol: p.symbol, sessionDate: p.asOfSession, value: p.value }));
      const nonNull = factorPoints.filter((p) => p.value !== null).length;
      console.log(`[measurement]   ${factorPoints.length} points, ${nonNull} non-null`);

      for (const rebalanceDays of REBALANCE_DAYS) {
        const returns = returnsByRebalance.get(rebalanceDays)!;
        const ic = computeIC(factorPoints, returns);
        const ann = computeAnnualizedExcessReturn(factorPoints, returns, rebalanceDays, 50);
        results.push({
          factor, rebalanceDays,
          meanIC: ic.meanIC, tStat: ic.tStat, nDates: ic.nDates,
          annualizedExcessReturnPct: ann.annualizedExcessReturnPct, nPeriods: ann.nPeriods,
        });
        console.log(
          `[measurement]   rebalance=${rebalanceDays}d: meanIC=${ic.meanIC?.toFixed(4) ?? 'null'} t=${ic.tStat?.toFixed(2) ?? 'null'} ` +
          `(n=${ic.nDates} dates) | annualized excess=${ann.annualizedExcessReturnPct?.toFixed(2) ?? 'null'}% (n=${ann.nPeriods} periods)`,
        );
      }
    }

    const dataWatermark = bars.length > 0 ? bars[bars.length - 1]!.sessionDate : 'unknown';
    const paramsHash = createHash('sha256').update(JSON.stringify({ FACTORS, REBALANCE_DAYS, liquidityFloor: '1cr' })).digest('hex').slice(0, 16);

    const auditClient = await pool.connect();
    try {
      for (const r of results) {
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_ic.${r.factor}`, metricVersion: 'v1',
          dimensions: { rebalanceDays: r.rebalanceDays, factor: r.factor },
          value: r.meanIC, nObservations: r.nDates, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_tstat.${r.factor}`, metricVersion: 'v1',
          dimensions: { rebalanceDays: r.rebalanceDays, factor: r.factor },
          value: r.tStat, nObservations: r.nDates, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_annualized_excess_pct.${r.factor}`, metricVersion: 'v1',
          dimensions: { rebalanceDays: r.rebalanceDays, factor: r.factor },
          value: r.annualizedExcessReturnPct, nObservations: r.nPeriods, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
      }
    } finally {
      auditClient.release();
    }
    console.log(`[measurement] recorded ${results.length * 3} audit_metric rows`);

    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: results.length, rowsAccepted: results.length, rowsRejected: 0, rowsWritten: results.length * 3,
        symbolsCovered: 0, inputWatermark: null, outputWatermark: dataWatermark,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    result = { status: 'failed', error, metrics: { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } };
  }

  const closeClient = await pool.connect();
  try {
    await closeRun(closeClient, runId, result);
  } finally {
    closeClient.release();
  }

  if (result.status === 'failed') {
    console.error('[measurement] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[measurement] FATAL:', err);
  process.exitCode = 1;
});
