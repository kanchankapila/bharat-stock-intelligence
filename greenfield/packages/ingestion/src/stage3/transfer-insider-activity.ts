// Phase 2: insider_trades → event_fact.
// Reads legacy moneycontrol_fetcher-written insider trades and writes them to
// the greenfield event_fact table as kind='insider_trade'.
//
// The legacy table has no stable provider-issued event ID; `mc:{id}` is
// constructed from the autoincrement PK — this is safe for deduplication
// because the PK is stable and the legacy table is never re-seeded.
//
// Only rows with a valid date_iso are transferred (the 2026-07-30 data-
// integrity fix backfilled most; ~small residual without a parseable date is
// excluded rather than guessed from the raw `date` text).
//
// Usage: tsx src/stage3/transfer-insider-activity.ts

import {
  createPool, insertTransferReject, loadKnownSymbols,
  openRun, closeRun, queryLegacyInsiderTrades,
  seedStage3Registry, upsertEventFact,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { isWithinScheduleWindow } from '@greenfield/market-calendar';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'phase2-insider-activity';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';
const JOB_ID = 'phase2.insider_activity';
// ecosystem.config.cjs: cron_restart '0 12 * * 6' (12:00 IST Saturday).
const SCHEDULE = { hour: 12, minute: 0, daysOfWeek: [6] } as const;

/** Maps typeOfTransaction text to a short normalised label stored in
 * payload.direction. Trades without a clear buy/sell direction still land in
 * event_fact — the full typeOfTransaction is preserved in the payload. */
function transactionDirection(typeOfTransaction: string): 'buy' | 'sell' | 'pledge' | 'other' {
  const t = typeOfTransaction.trim().toLowerCase();
  if (t.includes('buy') || t.includes('acquisition') || t.includes('market purchase')) return 'buy';
  if (t.includes('sell') || t.includes('disposal') || t.includes('market sale')) return 'sell';
  if (t.includes('pledge') && !t.includes('revok') && !t.includes('release')) return 'pledge';
  return 'other';
}

async function main(): Promise<void> {
  // pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
  // field -- see nse/run-daily-bhavcopy.ts's guard for the live 2026-09-03 incident this
  // fixes. --force bypasses this for a deliberate manual run.
  if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), SCHEDULE)) {
    console.log('[insider-activity] off-schedule invocation (expected ~12:00 IST Saturday) — likely a pm2 registration/restart launch, not the real cron fire. Skipping (pass --force to run manually).');
    return;
  }

  const pool = createPool();
  await seedStage3Registry(pool);

  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'Phase 2: insider trades transfer', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
    [JOB_ID],
  );

  const [knownSymbols, trades] = await Promise.all([
    loadKnownSymbols(pool),
    queryLegacyInsiderTrades(OLD_DATABASE_URL),
  ]);
  console.log(`[insider-activity] legacy rows: ${trades.length}`);

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
    for (const t of trades) {
      if (!knownSymbols.has(t.symbol)) {
        await insertTransferReject(client, {
          sourceTable: 'insider_trades', sourcePk: String(t.id),
          reason: `symbol '${t.symbol}' not in security table`,
        });
        rejected++;
        continue;
      }

      // date_iso is already validated as ^\d{4}-\d{2}-\d{2} by the query WHERE clause.
      const effectiveAt = `${t.date_iso}T00:00:00Z`;
      // Use the trade date as available_at too — insider filings become public
      // on their trade date in India (SEBI requires disclosure within 2 trading
      // days, but the legacy system fetched them at close-of-day, so using the
      // trade date itself is conservative and won't front-run). 12:30 UTC =
      // 18:00 IST, after NSE close, same proxy used in analyst estimates.
      const availableAt = `${t.date_iso}T12:30:00Z`;

      const direction = transactionDirection(t.type_of_transaction);
      const ok = await upsertEventFact(client, {
        source: 'moneycontrol',
        sourceEventId: `mc:${t.id}`,
        symbol: t.symbol,
        kind: 'insider_trade',
        effectiveAt,
        availableAt,
        headline: `${t.acquirer_name} — ${t.type_of_transaction}`,
        payload: {
          acquirerName: t.acquirer_name,
          category: t.category,
          typeOfTransaction: t.type_of_transaction,
          direction,
          quantity: t.quantity,
          valueInr: t.value_inr,
        },
        provenanceQuality: 'inferred',
        runId,
      });
      if (ok) accepted++;
    }
  } finally {
    client.release();
  }

  console.log(`[insider-activity] accepted=${accepted} rejected=${rejected}`);

  const result: JobResult = accepted > 0
    ? {
        status: 'succeeded',
        metrics: {
          rowsSeen: trades.length, rowsAccepted: accepted, rowsRejected: rejected,
          rowsWritten: accepted, symbolsCovered: 0,
          inputWatermark: null, outputWatermark: null,
        },
      }
    : {
        status: 'failed',
        error: new Error('zero insider trade rows written to greenfield'),
        metrics: {
          rowsSeen: trades.length, rowsAccepted: 0, rowsRejected: rejected,
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
  console.error('[insider-activity] FATAL:', err);
  process.exitCode = 1;
});
