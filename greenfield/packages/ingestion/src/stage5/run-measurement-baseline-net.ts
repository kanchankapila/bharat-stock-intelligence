// Task 5.0.3: net-of-cost re-measurement over the same rebuilt panel Stage
// 4 used. Records factor_net_* audit_metric rows -- distinct metric names
// from Stage 4's factor_* rows, never overwriting the gross numbers, both
// are evidence. Precondition (same as Task 4.4): the harness's negative
// controls (including the three cost/turnover ones added for Task 5.0.1)
// must be green -- `npx vitest run src/stage4/research-harness.test.ts`.
//
// Usage: tsx src/stage4/run-measurement-baseline-net.ts
import { createHash } from 'node:crypto';
import {
  closeRun, createPool, insertAuditMetric, openRun, queryFeatureSnapshotMetricSeries, queryOpenPriceSeries,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { computeForwardReturns, computeNetAnnualizedExcessReturn } from '../stage4/research-harness.js';
import { FEATURE_SET_VERSION } from '../stage4/compute-features.js';
import { bonferroniCriticalT } from './stats.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage5-net-measurement';
const COST_BPS = 25;

const FACTORS = [
  'momentum_21d', 'momentum_63d', 'delivery_pct', 'delivery_pct_ma20',
  'pe_pct_rank_252d', 'pb_pct_rank_252d', 'eps_ttm', 'eps_growth_yoy',
  'div_yield_ttm', 'fii_net_21d', 'dii_net_21d', 'screener_breadth',
];
const REBALANCE_DAYS = [5, 21];
const N_COMPARISONS = FACTORS.length * REBALANCE_DAYS.length; // 24

async function seedRegistry(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage5.net_measurement', 'Task 5.0 net-of-cost, Bonferroni-corrected re-measurement', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );
}

interface NetFactorResult {
  factor: string;
  rebalanceDays: number;
  meanTurnover: number | null;
  netExcessPerPeriodPct: number | null;
  annualizedNetExcessPct: number | null;
  netTStat: number | null;
  nPeriods: number;
  survives: boolean;
}

async function main(): Promise<void> {
  const pool = createPool();
  await seedRegistry(pool);

  const critical = bonferroniCriticalT(N_COMPARISONS);
  console.log(`[net-measurement] Bonferroni-corrected critical |t| for ${N_COMPARISONS} comparisons: ${critical.toFixed(4)}`);

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage5.net_measurement', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  const results: NetFactorResult[] = [];

  try {
    console.log('[net-measurement] loading open-price panel...');
    const bars = await queryOpenPriceSeries(pool);
    const returnsByRebalance = new Map(REBALANCE_DAYS.map((d) => [d, computeForwardReturns(bars, d)]));

    for (const factor of FACTORS) {
      const points = await queryFeatureSnapshotMetricSeries(pool, factor, FEATURE_SET_VERSION);
      const factorPoints = points.map((p) => ({ symbol: p.symbol, sessionDate: p.asOfSession, value: p.value }));

      for (const rebalanceDays of REBALANCE_DAYS) {
        const returns = returnsByRebalance.get(rebalanceDays)!;
        const net = computeNetAnnualizedExcessReturn(factorPoints, returns, rebalanceDays, 50, COST_BPS);
        const survives = net.netTStat !== null && Math.abs(net.netTStat) >= critical;
        results.push({
          factor, rebalanceDays,
          meanTurnover: net.meanTurnover,
          netExcessPerPeriodPct: net.meanNetExcessReturnPerPeriod !== null ? net.meanNetExcessReturnPerPeriod * 100 : null,
          annualizedNetExcessPct: net.annualizedNetExcessReturnPct,
          netTStat: net.netTStat, nPeriods: net.nPeriods, survives,
        });
        console.log(
          `[net-measurement] ${factor} @${rebalanceDays}d: turnover=${net.meanTurnover?.toFixed(3) ?? 'null'} ` +
          `net/period=${net.meanNetExcessReturnPerPeriod !== null ? (net.meanNetExcessReturnPerPeriod * 100).toFixed(3) : 'null'}% ` +
          `annualizedNet=${net.annualizedNetExcessReturnPct?.toFixed(2) ?? 'null'}% t=${net.netTStat?.toFixed(2) ?? 'null'} ` +
          `(n=${net.nPeriods}) ${survives ? '*** SURVIVES BONFERRONI ***' : ''}`,
        );
      }
    }

    const dataWatermark = bars.length > 0 ? bars[bars.length - 1]!.sessionDate : 'unknown';
    const paramsHash = createHash('sha256')
      .update(JSON.stringify({ FACTORS, REBALANCE_DAYS, costBps: COST_BPS, nComparisons: N_COMPARISONS, criticalT: critical }))
      .digest('hex').slice(0, 16);

    const auditClient = await pool.connect();
    try {
      for (const r of results) {
        const dims = { rebalanceDays: r.rebalanceDays, factor: r.factor, costBps: COST_BPS };
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_net_tstat.${r.factor}`, metricVersion: 'v1', dimensions: dims,
          value: r.netTStat, nObservations: r.nPeriods, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_net_annualized_excess_pct.${r.factor}`, metricVersion: 'v1', dimensions: dims,
          value: r.annualizedNetExcessPct, nObservations: r.nPeriods, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
        await insertAuditMetric(auditClient, {
          runId, metricName: `factor_net_turnover.${r.factor}`, metricVersion: 'v1', dimensions: dims,
          value: r.meanTurnover, nObservations: r.nPeriods, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
        });
      }
      await insertAuditMetric(auditClient, {
        runId, metricName: 'bonferroni_critical_t', metricVersion: 'v1', dimensions: { nComparisons: N_COMPARISONS },
        value: critical, nObservations: N_COMPARISONS, dataWatermark, paramsHash, codeCommit: CODE_COMMIT,
      });
    } finally {
      auditClient.release();
    }

    const survivors = results.filter((r) => r.survives);
    console.log('');
    console.log(`[net-measurement] recorded ${results.length * 3 + 1} audit_metric rows`);
    console.log(`[net-measurement] SURVIVORS (|t| >= ${critical.toFixed(2)} net of ${COST_BPS}bps costs): ${survivors.length === 0 ? 'NONE' : survivors.map((s) => `${s.factor}@${s.rebalanceDays}d`).join(', ')}`);

    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: results.length, rowsAccepted: results.length, rowsRejected: 0, rowsWritten: results.length * 3 + 1,
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
    console.error('[net-measurement] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[net-measurement] FATAL:', err);
  process.exitCode = 1;
});
