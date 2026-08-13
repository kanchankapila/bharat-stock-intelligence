// Task 4.2: feature_snapshot computation. Reads exclusively through
// @greenfield/db's PIT API (pit-repo.ts) -- no raw SQL here. All 12 v1
// metrics computed with point-in-time correctness: a fundamental fact is
// only used once its own available_at has passed facts_cutoff.
import {
  bulkInsertFeatureSnapshot, closeRun, createPool, openRun,
  queryFundamentalAsOfSeries, queryMarketBarFeaturePanel, queryMarketFlowSeries,
  queryScreenerBreadthSeries,
  type FeatureSnapshotInput, type FundamentalAsOfPoint, type MarketBarFeatureRow,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

export const FEATURE_SET_VERSION = 'v1';
export const LIQUIDITY_FLOOR_ADT = 1_00_00_000; // Rs 1 crore, per Task 4.2 mandatory rule 4.

/** Market close in India is 15:30 IST = 10:00 UTC. Used uniformly as
 * facts_cutoff -- a safe (never-too-early) upper bound for every metric
 * computed below, since every fundamental lookup is itself constrained to
 * available_at <= this same cutoff. Verify's "facts_cutoff <= session_close"
 * check is then true by construction. */
export function sessionCloseUtc(sessionDate: string): string {
  return `${sessionDate}T10:00:00.000Z`;
}

interface FundPoint {
  availableAt: string;
  periodEnd: string;
  value: number;
}

export function buildAsOfIndex(series: FundamentalAsOfPoint[]): Map<string, FundPoint[]> {
  const bySymbol = new Map<string, FundPoint[]>();
  for (const p of series) {
    const arr = bySymbol.get(p.symbol);
    const point = { availableAt: p.availableAt, periodEnd: p.periodEnd, value: p.value };
    if (arr) arr.push(point);
    else bySymbol.set(p.symbol, [point]);
  }
  return bySymbol;
}

/** Last point with availableAt <= cutoff. Points must already be sorted by
 * availableAt ascending (queryFundamentalAsOfSeries guarantees this). */
export function latestAsOf(points: FundPoint[] | undefined, cutoff: string): FundPoint | null {
  if (!points || points.length === 0) return null;
  let lo = 0;
  let hi = points.length - 1;
  let result = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (points[mid]!.availableAt <= cutoff) {
      result = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return result >= 0 ? points[result]! : null;
}

/** Sum of the last 4 distinct fiscal quarters known as of cutoff. Restated
 * quarters (multiple facts for the same period_end) resolve to the latest
 * available_at for that period_end -- correct because `eligible` is already
 * availableAt-ordered, so a later write for the same period simply
 * overwrites the map entry. Returns null with fewer than 4 known quarters
 * (a partial-TTM sum would be a fabricated number, not a real one). */
export function ttmEpsAsOf(points: FundPoint[] | undefined, cutoff: string): number | null {
  if (!points) return null;
  const byPeriod = new Map<string, number>();
  for (const p of points) {
    if (p.availableAt > cutoff) break; // ordered by availableAt -- safe to stop early
    byPeriod.set(p.periodEnd, p.value);
  }
  const periods = Array.from(byPeriod.keys()).sort().slice(-4);
  if (periods.length < 4) return null;
  return periods.reduce((sum, pe) => sum + byPeriod.get(pe)!, 0);
}

function addDaysIso(dateIso: string, days: number): string {
  const d = new Date(dateIso);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

export interface ComputedRow {
  symbol: string;
  sessionDate: string;
  factsCutoff: string;
  values: Record<string, number | null>;
  coverage: number;
}

export function computeFeaturePanel(
  marketBarPanel: MarketBarFeatureRow[],
  peSeries: FundamentalAsOfPoint[],
  pbSeries: FundamentalAsOfPoint[],
  quarterlyEpsSeries: FundamentalAsOfPoint[],
  dividendSeries: FundamentalAsOfPoint[],
  marketFlowDays: Array<{ flowDate: string; fiiNet: number | null; diiNet: number | null }>,
  screenerBreadthPoints: Array<{ symbol: string; observedAt: string; breadth: number }>,
): ComputedRow[] {
  const peIndex = buildAsOfIndex(peSeries);
  const pbIndex = buildAsOfIndex(pbSeries);
  const epsIndex = buildAsOfIndex(quarterlyEpsSeries);
  const divIndex = buildAsOfIndex(dividendSeries);
  const breadthIndex = buildAsOfIndex(screenerBreadthPoints.map((p) => ({ symbol: p.symbol, availableAt: p.observedAt, periodEnd: p.observedAt, value: p.breadth })));

  // Rolling 21-session sum of market-wide FII/DII net, keyed by date.
  const flowByDate = new Map(marketFlowDays.map((d) => [d.flowDate, d]));
  const sortedFlowDates = marketFlowDays.map((d) => d.flowDate).sort();
  const flow21dByDate = new Map<string, { fiiNet21d: number | null; diiNet21d: number | null }>();
  for (let i = 0; i < sortedFlowDates.length; i++) {
    const window = sortedFlowDates.slice(Math.max(0, i - 20), i + 1);
    let fiiSum = 0;
    let diiSum = 0;
    let fiiCount = 0;
    let diiCount = 0;
    for (const d of window) {
      const day = flowByDate.get(d)!;
      if (day.fiiNet !== null) { fiiSum += day.fiiNet; fiiCount++; }
      if (day.diiNet !== null) { diiSum += day.diiNet; diiCount++; }
    }
    flow21dByDate.set(sortedFlowDates[i]!, {
      fiiNet21d: fiiCount > 0 ? fiiSum : null,
      diiNet21d: diiCount > 0 ? diiSum : null,
    });
  }
  function flow21dAsOf(sessionDate: string): { fiiNet21d: number | null; diiNet21d: number | null } {
    // last known flow date <= sessionDate
    let lo = 0, hi = sortedFlowDates.length - 1, result = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (sortedFlowDates[mid]! <= sessionDate) { result = mid; lo = mid + 1; } else { hi = mid - 1; }
    }
    return result >= 0 ? flow21dByDate.get(sortedFlowDates[result]!)! : { fiiNet21d: null, diiNet21d: null };
  }

  // Cross-sectional PE/PB percentile rank among liquid (ADT_252d >= floor) peers, per session date.
  const bySessionDate = new Map<string, MarketBarFeatureRow[]>();
  for (const row of marketBarPanel) {
    const arr = bySessionDate.get(row.sessionDate);
    if (arr) arr.push(row);
    else bySessionDate.set(row.sessionDate, [row]);
  }

  const results: ComputedRow[] = [];

  for (const [sessionDate, rowsForDate] of bySessionDate) {
    const cutoff = sessionCloseUtc(sessionDate);
    const cutoffMinus1y = addDaysIso(cutoff, -365);

    // Liquid peer PE/PB distributions for this date.
    const liquidPe: number[] = [];
    const liquidPb: number[] = [];
    const peAsOfBySymbol = new Map<string, number | null>();
    const pbAsOfBySymbol = new Map<string, number | null>();
    for (const row of rowsForDate) {
      const pe = latestAsOf(peIndex.get(row.symbol), cutoff)?.value ?? null;
      const pb = latestAsOf(pbIndex.get(row.symbol), cutoff)?.value ?? null;
      peAsOfBySymbol.set(row.symbol, pe);
      pbAsOfBySymbol.set(row.symbol, pb);
      const isLiquid = row.adt252d !== null && row.adt252d >= LIQUIDITY_FLOOR_ADT;
      if (isLiquid && pe !== null) liquidPe.push(pe);
      if (isLiquid && pb !== null) liquidPb.push(pb);
    }
    liquidPe.sort((a, b) => a - b);
    liquidPb.sort((a, b) => a - b);
    function percentileRank(sorted: number[], value: number | null): number | null {
      if (value === null || sorted.length === 0) return null;
      let lo = 0, hi = sorted.length;
      while (lo < hi) { const mid = (lo + hi) >> 1; if (sorted[mid]! < value) lo = mid + 1; else hi = mid; }
      return lo / sorted.length;
    }

    for (const row of rowsForDate) {
      const epsTtmNow = ttmEpsAsOf(epsIndex.get(row.symbol), cutoff);
      const epsTtm1yAgo = ttmEpsAsOf(epsIndex.get(row.symbol), cutoffMinus1y);
      const epsGrowthYoy = epsTtmNow !== null && epsTtm1yAgo !== null && epsTtm1yAgo !== 0
        ? (epsTtmNow - epsTtm1yAgo) / Math.abs(epsTtm1yAgo)
        : null;
      const latestDividend = latestAsOf(divIndex.get(row.symbol), cutoff)?.value ?? null;
      const divYieldTtm = latestDividend !== null && row.close > 0 ? latestDividend / row.close : null;
      const breadth = latestAsOf(breadthIndex.get(row.symbol), cutoff)?.value ?? null;
      const flow = flow21dAsOf(sessionDate);

      const values: Record<string, number | null> = {
        momentum_21d: row.momentum21d,
        momentum_63d: row.momentum63d,
        delivery_pct: row.deliveryPct,
        delivery_pct_ma20: row.deliveryPctMa20,
        pe_pct_rank_252d: percentileRank(liquidPe, peAsOfBySymbol.get(row.symbol) ?? null),
        pb_pct_rank_252d: percentileRank(liquidPb, pbAsOfBySymbol.get(row.symbol) ?? null),
        eps_ttm: epsTtmNow,
        eps_growth_yoy: epsGrowthYoy,
        div_yield_ttm: divYieldTtm,
        fii_net_21d: flow.fiiNet21d,
        dii_net_21d: flow.diiNet21d,
        screener_breadth: breadth,
      };
      const nonNull = Object.values(values).filter((v) => v !== null).length;
      results.push({
        symbol: row.symbol,
        sessionDate,
        factsCutoff: cutoff,
        values,
        coverage: nonNull / Object.keys(values).length,
      });
    }
  }

  return results;
}

async function seedStage4Registry(pool: ReturnType<typeof createPool>): Promise<void> {
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ('stage4.feature_snapshot', 'Stage 4 feature_snapshot computation (internal, no external fetch)', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
  );
}

function emptyMetrics(): JobMetrics {
  return { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

export async function main(): Promise<void> {
  const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage4-feature-snapshot';
  const pool = createPool();
  await seedStage4Registry(pool);

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage4.feature_snapshot', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  try {
    console.log('[features] loading market_bar/delivery_stat panel...');
    const panel = await queryMarketBarFeaturePanel(pool);
    console.log(`[features] panel: ${panel.length} (symbol, session_date) rows`);

    console.log('[features] loading fundamental series...');
    const [pe, pb, eps, div] = await Promise.all([
      queryFundamentalAsOfSeries(pool, 'et_ratio_standalone_priceToEarnings', 'etmarketsapis'),
      queryFundamentalAsOfSeries(pool, 'et_ratio_standalone_priceToBV', 'etmarketsapis'),
      queryFundamentalAsOfSeries(pool, 'et_quarterly_standalone_basicEPS', 'etmarketsapis'),
      queryFundamentalAsOfSeries(pool, 'et_ratio_standalone_dividendPerShare', 'etmarketsapis'),
    ]);
    console.log(`[features] fundamentals: pe=${pe.length} pb=${pb.length} eps=${eps.length} div=${div.length}`);

    const flow = await queryMarketFlowSeries(pool);
    const breadth = await queryScreenerBreadthSeries(pool);
    console.log(`[features] flow=${flow.length} days, breadth=${breadth.length} snapshot points`);

    console.log('[features] computing...');
    const computed = computeFeaturePanel(panel, pe, pb, eps, div, flow, breadth);
    console.log(`[features] computed ${computed.length} feature_snapshot rows`);

    const insertRows: FeatureSnapshotInput[] = computed.map((c) => ({
      symbol: c.symbol, asOfSession: c.sessionDate, featureSetVersion: FEATURE_SET_VERSION,
      factsCutoff: c.factsCutoff, values: c.values, coverage: c.coverage, runId,
    }));

    console.log('[features] bulk inserting...');
    const BATCH = 20_000;
    let written = 0;
    const insertClient = await pool.connect();
    try {
      for (let i = 0; i < insertRows.length; i += BATCH) {
        const batch = insertRows.slice(i, i + BATCH);
        written += await bulkInsertFeatureSnapshot(insertClient, batch);
        if (i % (BATCH * 10) === 0) console.log(`[features] inserted ${i + batch.length}/${insertRows.length}`);
      }
    } finally {
      insertClient.release();
    }
    console.log(`[features] DONE. ${written} rows written.`);

    const symbolsCovered = new Set(computed.map((c) => c.symbol)).size;
    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: computed.length, rowsAccepted: written, rowsRejected: computed.length - written,
        rowsWritten: written, symbolsCovered, inputWatermark: null, outputWatermark: null,
      },
    };
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    result = { status: 'failed', error, metrics: emptyMetrics() };
  }

  const closeClient = await pool.connect();
  try {
    await closeRun(closeClient, runId, result);
  } finally {
    closeClient.release();
  }

  if (result.status === 'failed') {
    console.error('[features] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}
