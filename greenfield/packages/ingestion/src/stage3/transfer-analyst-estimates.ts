// Phase 2: MC analyst ratings + price forecast → analyst_estimate.
// Reads from mc_analyst_ratings and mc_price_forecast in the legacy bharat_intel
// DB and writes PIT-correct rows to analyst_estimate in greenfield.
// One-shot script; re-runs are safe (ON CONFLICT DO NOTHING).
//
// Available_at is set to `fetched_at` from the legacy table — the actual
// time MoneyControl fetched the data, which is the correct PIT anchor (the
// old system stored this accurately; no 90-day lag floor applies to analyst
// ratings since they represent a current opinion, not a reported quarter).
//
// Two metrics written:
//   'recommendation'           — final_rating mapped to 1-5 scale (1=Strong Buy)
//   'recommendation_count_wtd' — weighted mean from buy/sell/hold counts
//   'target_price'             — mean analyst price target (mc_price_forecast)
//
// Usage: tsx src/stage3/transfer-analyst-estimates.ts

import {
  createPool, insertTransferReject, loadKnownSymbols,
  openRun, closeRun, queryLegacyMcAnalystRatings, queryLegacyMcPriceForecast,
  seedStage3Registry, upsertAnalystEstimate,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { isWithinScheduleWindow } from '@greenfield/market-calendar';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'phase2-analyst-estimates';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';
const JOB_ID = 'phase2.analyst_estimates';
// ecosystem.config.cjs: cron_restart '30 11 * * 6' (11:30 IST Saturday).
const SCHEDULE = { hour: 11, minute: 30, daysOfWeek: [6] } as const;

/** Maps MoneyControl's final_rating text to the standard 1-5 broker-consensus
 * scale used by Bloomberg/FactSet (1=Strong Buy, 5=Strong Sell). Returns null
 * if the text is unrecognised — that row is still written via the
 * count-weighted path if the individual counts are available. */
function ratingToScore(finalRating: string | null): number | null {
  if (!finalRating) return null;
  const r = finalRating.trim().toLowerCase();
  // Order matters: check 'strong buy' before 'buy', 'strong sell' before 'sell'.
  if (r.includes('strong buy'))  return 1.0;
  if (r.includes('buy') || r.includes('overweight') || r.includes('outperform')) return 2.0;
  if (r.includes('hold') || r.includes('neutral') || r.includes('equalweight') || r.includes('equal-weight')) return 3.0;
  if (r.includes('underperform') || r.includes('underweight')) return 4.0;
  if (r.includes('strong sell') || r.includes('sell') || r.includes('reduce')) return 5.0;
  return null;
}

/** Normalises fetched_at to a full ISO 8601 timestamp. The legacy table
 * stores either a date ('2025-01-10') or a datetime string. Analyst calls
 * are typically made at market close; 18:00 IST (12:30 UTC) is used as the
 * proxy when only a date is present — 30 minutes after NSE close. */
function toAvailableAt(fetchedAt: string): string {
  return fetchedAt.includes('T') ? fetchedAt : `${fetchedAt}T12:30:00Z`;
}

async function main(): Promise<void> {
  // pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
  // field -- see nse/run-daily-bhavcopy.ts's guard for the live 2026-09-03 incident this
  // fixes. --force bypasses this for a deliberate manual run.
  if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), SCHEDULE)) {
    console.log('[analyst-estimates] off-schedule invocation (expected ~11:30 IST Saturday) — likely a pm2 registration/restart launch, not the real cron fire. Skipping (pass --force to run manually).');
    return;
  }

  const pool = createPool();
  await seedStage3Registry(pool);

  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'Phase 2: MC analyst ratings + price forecast transfer', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
    [JOB_ID],
  );

  const [knownSymbols, ratings, forecasts] = await Promise.all([
    loadKnownSymbols(pool),
    queryLegacyMcAnalystRatings(OLD_DATABASE_URL),
    queryLegacyMcPriceForecast(OLD_DATABASE_URL),
  ]);
  console.log(`[analyst-estimates] legacy: ratings=${ratings.length} forecasts=${forecasts.length}`);

  const openClient = await pool.connect();
  let runId!: string;
  try {
    runId = await openRun(openClient, { jobId: JOB_ID, codeCommit: CODE_COMMIT });
  } finally {
    openClient.release();
  }

  let accepted = 0, rejected = 0;
  const client = await pool.connect();
  try {
    // --- mc_analyst_ratings → 'recommendation' + 'recommendation_count_wtd' ---
    for (const r of ratings) {
      const periodEnd = r.fetched_at.slice(0, 10);
      const availableAt = toAvailableAt(r.fetched_at);

      if (!knownSymbols.has(r.symbol)) {
        await insertTransferReject(client, {
          sourceTable: 'mc_analyst_ratings', sourcePk: `${r.symbol}:${r.fetched_at}`,
          reason: `symbol '${r.symbol}' not in security table`,
        });
        rejected++;
        continue;
      }

      // Text-based rating (primary consensus metric).
      const consensus = ratingToScore(r.final_rating);
      if (consensus !== null) {
        const ok = await upsertAnalystEstimate(client, {
          symbol: r.symbol, metric: 'recommendation', periodEnd,
          source: 'moneycontrol', consensus, high: null, low: null,
          analysts: r.analyst_count ?? null,
          availableAt, provenanceQuality: 'inferred', runId,
        });
        if (ok) accepted++;
      }

      // Count-weighted consensus (available when individual counts are present).
      const nBuy  = r.buy_count ?? 0;
      const nOut  = r.outperform_count ?? 0;
      const nHold = r.hold_count ?? 0;
      const nUnder = r.underperform_count ?? 0;
      const nSell = r.sell_count ?? 0;
      const total = nBuy + nOut + nHold + nUnder + nSell;
      if (total > 0) {
        const countWtd = (1 * nBuy + 2 * nOut + 3 * nHold + 4 * nUnder + 5 * nSell) / total;
        await upsertAnalystEstimate(client, {
          symbol: r.symbol, metric: 'recommendation_count_wtd', periodEnd,
          source: 'moneycontrol', consensus: countWtd, high: null, low: null,
          analysts: r.analyst_count ?? null,
          availableAt, provenanceQuality: 'inferred', runId,
        });
      }
    }

    // --- mc_price_forecast → 'target_price' ---
    for (const f of forecasts) {
      const periodEnd = f.fetched_at.slice(0, 10);
      const availableAt = toAvailableAt(f.fetched_at);

      if (!knownSymbols.has(f.symbol)) {
        await insertTransferReject(client, {
          sourceTable: 'mc_price_forecast', sourcePk: `${f.symbol}:${f.fetched_at}`,
          reason: `symbol '${f.symbol}' not in security table`,
        });
        rejected++;
        continue;
      }

      if (f.mean !== null) {
        const ok = await upsertAnalystEstimate(client, {
          symbol: f.symbol, metric: 'target_price', periodEnd,
          source: 'moneycontrol', consensus: f.mean, high: f.high ?? null, low: f.low ?? null,
          analysts: null,
          availableAt, provenanceQuality: 'inferred', runId,
        });
        if (ok) accepted++;
      }
    }
  } finally {
    client.release();
  }

  console.log(`[analyst-estimates] accepted=${accepted} rejected=${rejected}`);

  const rowsSeen = ratings.length + forecasts.length;
  const result: JobResult = accepted > 0
    ? {
        status: 'succeeded',
        metrics: {
          rowsSeen, rowsAccepted: accepted, rowsRejected: rejected,
          rowsWritten: accepted, symbolsCovered: 0,
          inputWatermark: null, outputWatermark: null,
        },
      }
    : {
        status: 'failed',
        error: new Error('zero analyst estimate rows written to greenfield'),
        metrics: {
          rowsSeen, rowsAccepted: 0, rowsRejected: rejected,
          rowsWritten: 0, symbolsCovered: 0,
          inputWatermark: null, outputWatermark: null,
        },
      };

  const closeClient = await pool.connect();
  try {
    await closeRun(closeClient, runId, result);
  } finally {
    closeClient.release();
  }
  await pool.end();

  if (result.status === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[analyst-estimates] FATAL:', err);
  process.exitCode = 1;
});
