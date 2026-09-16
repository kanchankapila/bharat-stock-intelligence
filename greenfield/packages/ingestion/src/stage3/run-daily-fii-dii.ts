// Daily forward FII/DII ingestion — fresh NSE fetch only, provenance='recorded'.
// The one-shot transfer-fii-dii.ts reads from the legacy DB for history; this
// script is for ongoing daily forward ingestion only. Logic mirrors
// transferFreshNse() in that file with provenanceQuality changed to 'recorded'
// (live data, not reconstructed from an old DB), and a distinct job_id so the
// run ledger can distinguish historical transfer from daily forward runs.
//
// Usage: tsx src/stage3/run-daily-fii-dii.ts
import {
  createPool, insertRawObject, insertTransferReject,
  openRun, closeRun, seedStage3Registry, upsertMarketFlow,
} from '@greenfield/db';
import type { JobResult } from '@greenfield/contracts';
import { isWithinScheduleWindow } from '@greenfield/market-calendar';
import { fetchWithPolicy, primeSessionCookie } from '@greenfield/provider-sdk';
import {
  NSE_FII_DII_HEADERS, NSE_FII_DII_URL, NSE_SESSION_HEADERS, parseFiiDiiResponse,
} from './fii-dii.js';

try { process.loadEnvFile(); } catch { /* rely on process.env */ }

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'gf-fii-dii-daily';
const JOB_ID = 'nse.fii_dii.daily';
// ecosystem.config.cjs: cron_restart '0 21 * * 1-5' (21:00 IST weekdays).
const SCHEDULE = { hour: 21, minute: 0, daysOfWeek: [1, 2, 3, 4, 5] } as const;

async function main(): Promise<void> {
  // pm2 fires cron_restart apps immediately on registration/restart regardless of the cron
  // field -- see run-daily-bhavcopy.ts's guard for the live 2026-09-03 incident this fixes.
  if (!process.argv.includes('--force') && !isWithinScheduleWindow(new Date(), SCHEDULE)) {
    console.log('[fii-dii-daily] off-schedule invocation (expected ~21:00 IST weekdays) — likely a pm2 registration/restart launch, not the real cron fire. Skipping (pass --force to run manually).');
    return;
  }

  const pool = createPool();

  // seedStage3Registry is idempotent (ON CONFLICT DO NOTHING everywhere) and
  // ensures the nse.fii_dii provider_endpoint row used by insertRawObject exists.
  await seedStage3Registry(pool);
  await pool.query(
    `INSERT INTO job_definition (job_id, description, timezone, catalog_version)
     VALUES ($1, 'NSE FII/DII daily forward ingestion', 'Asia/Kolkata', 'v1')
     ON CONFLICT (job_id) DO NOTHING`,
    [JOB_ID],
  );

  const openClient = await pool.connect();
  let runId: string;
  try {
    runId = await openRun(openClient, { jobId: JOB_ID, codeCommit: CODE_COMMIT });
  } finally {
    openClient.release();
  }

  let result: JobResult;
  const workClient = await pool.connect();
  try {
    const cookie = await primeSessionCookie('https://www.nseindia.com/', NSE_SESSION_HEADERS);
    const headers = cookie ? { ...NSE_FII_DII_HEADERS, Cookie: cookie } : NSE_FII_DII_HEADERS;

    const raw = await fetchWithPolicy({ url: NSE_FII_DII_URL, headers });
    await insertRawObject(workClient, {
      runId, endpointKey: 'nse.fii_dii', contentHash: raw.contentHash,
      httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
      storageUri: `local://raw/${raw.contentHash}`,
    });
    if (raw.httpStatus !== 200) throw new Error(`NSE fiidiiTradeReact returned HTTP ${raw.httpStatus}`);

    const parsed = parseFiiDiiResponse(raw.body);
    let accepted = 0;
    let rejected = 0;

    for (const r of parsed.rejected) {
      await insertTransferReject(workClient, {
        sourceTable: 'nse.fii_dii', sourcePk: 'unknown', reason: r.reason, rawSnippet: r.raw,
      });
      rejected++;
    }

    const availableAt = new Date(Date.now()).toISOString();
    for (const day of parsed.accepted) {
      await upsertMarketFlow(workClient, {
        scope: 'market', segment: 'cash', flowDate: day.flowDate, source: 'nse',
        fiiNet: day.fiiNet, diiNet: day.diiNet, availableAt,
        provenanceQuality: 'recorded',  // live data -- not reconstructed from old DB
        runId,
      });
      accepted++;
    }

    console.log(`[fii-dii-daily] accepted=${accepted} rejected=${rejected}`);
    result = {
      status: 'succeeded',
      metrics: {
        rowsSeen: parsed.accepted.length + parsed.rejected.length,
        rowsAccepted: accepted, rowsRejected: rejected,
        rowsWritten: accepted, symbolsCovered: 0,
        inputWatermark: null, outputWatermark: availableAt,
      },
    };
  } catch (err: unknown) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[fii-dii-daily] ERROR:', error.message);
    result = {
      status: 'failed', error,
      metrics: {
        rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0,
        rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null,
      },
    };
  } finally {
    workClient.release();
  }

  const closeClient = await pool.connect();
  try {
    await closeRun(closeClient, runId!, result);
  } finally {
    closeClient.release();
  }
  await pool.end();

  if (result.status === 'failed') process.exitCode = 1;
}

main().catch((err: unknown) => {
  console.error('[fii-dii-daily] FATAL:', err);
  process.exitCode = 1;
});
