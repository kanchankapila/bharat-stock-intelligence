// Task 3.4: FII/DII cash-market flow transfer. Old DB's `fii_dii_flow` is
// the real historical depth (2016-present); the fresh NSE fetch only ever
// returns what NSE currently publishes as "latest" (observed live: a single
// day), so its job is exactly what the spec says -- bridge any gap since
// the old DB's last row, not backfill history the endpoint doesn't offer.
// One-shot operational script -- same convention as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/transfer-fii-dii.ts
import type pg from 'pg';
import {
  createPool, insertRawObject, insertTransferReject, openRun, closeRun,
  queryLegacyFiiDiiFlow, seedStage3Registry, upsertMarketFlow,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';
import { fetchWithPolicy, primeSessionCookie } from '@greenfield/provider-sdk';
import { NSE_FII_DII_HEADERS, NSE_FII_DII_URL, NSE_SESSION_HEADERS, parseFiiDiiResponse } from './fii-dii.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-fii-dii';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';

interface Tally {
  rowsSeen: number;
  rowsAccepted: number;
  rowsRejected: number;
}

async function transferFreshNse(client: pg.ClientBase, runId: string): Promise<Tally> {
  const cookie = await primeSessionCookie('https://www.nseindia.com/', NSE_SESSION_HEADERS);
  const headers = cookie ? { ...NSE_FII_DII_HEADERS, Cookie: cookie } : NSE_FII_DII_HEADERS;

  const raw = await fetchWithPolicy({ url: NSE_FII_DII_URL, headers });
  await insertRawObject(client, {
    runId, endpointKey: 'nse.fii_dii', contentHash: raw.contentHash,
    httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
    storageUri: `local://raw/${raw.contentHash}`,
  });
  if (raw.httpStatus !== 200) {
    throw new Error(`NSE fiidiiTradeReact returned HTTP ${raw.httpStatus}`);
  }

  const parsed = parseFiiDiiResponse(raw.body);
  let accepted = 0;
  let rejected = 0;

  for (const r of parsed.rejected) {
    await insertTransferReject(client, { sourceTable: 'nse.fii_dii', sourcePk: 'unknown', reason: r.reason, rawSnippet: r.raw });
    rejected++;
  }

  const availableAt = new Date(Date.now()).toISOString();
  for (const day of parsed.accepted) {
    await upsertMarketFlow(client, {
      scope: 'market', segment: 'cash', flowDate: day.flowDate, source: 'nse',
      fiiNet: day.fiiNet, diiNet: day.diiNet, availableAt, provenanceQuality: 'inferred', runId,
    });
    accepted++;
  }

  return { rowsSeen: parsed.accepted.length + parsed.rejected.length, rowsAccepted: accepted, rowsRejected: rejected };
}

async function transferLegacy(client: pg.ClientBase, runId: string): Promise<Tally> {
  const rows = await queryLegacyFiiDiiFlow(OLD_DATABASE_URL);
  let accepted = 0;
  let rejected = 0;

  for (const r of rows) {
    const flowDate = typeof r.date === 'string' ? r.date : '';
    const isValidDate = /^\d{4}-\d{2}-\d{2}$/.test(flowDate);
    if (!isValidDate) {
      await insertTransferReject(client, { sourceTable: 'legacy.fii_dii_flow', sourcePk: flowDate || 'unknown', reason: `unparseable date '${flowDate}'`, rawSnippet: r });
      rejected++;
      continue;
    }
    // The old table has no availability timestamp of its own beyond
    // `fetched_at` (not selected here, matching Task 3.5's guidance not to
    // trust an old-DB CURRENT_TIMESTAMP-style proxy) -- for a genuinely
    // historical, already-public daily aggregate like FII/DII flow, using
    // end-of-day on the flow_date itself is the correct point-in-time floor:
    // this figure is published same-day after market close, never before.
    await upsertMarketFlow(client, {
      scope: 'market', segment: 'cash', flowDate, source: 'nse',
      fiiNet: r.fii_net, diiNet: r.dii_net, availableAt: `${flowDate}T23:59:59Z`,
      provenanceQuality: 'inferred', runId,
    });
    accepted++;
  }

  return { rowsSeen: rows.length, rowsAccepted: accepted, rowsRejected: rejected };
}

function emptyMetrics(): JobMetrics {
  return { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

async function main(): Promise<void> {
  const pool = createPool();
  await seedStage3Registry(pool);

  const client = await pool.connect();
  try {
    const runId = await openRun(client, { jobId: 'stage3.fii_dii', codeCommit: CODE_COMMIT });
    let result: JobResult;
    try {
      const fresh = await transferFreshNse(client, runId);
      console.log(`[fii-dii] fresh (NSE): seen=${fresh.rowsSeen} accepted=${fresh.rowsAccepted} rejected=${fresh.rowsRejected}`);
      const legacy = await transferLegacy(client, runId);
      console.log(`[fii-dii] legacy (old DB fii_dii_flow): seen=${legacy.rowsSeen} accepted=${legacy.rowsAccepted} rejected=${legacy.rowsRejected}`);
      const totals = {
        rowsSeen: fresh.rowsSeen + legacy.rowsSeen,
        rowsAccepted: fresh.rowsAccepted + legacy.rowsAccepted,
        rowsRejected: fresh.rowsRejected + legacy.rowsRejected,
      };
      result = { status: 'succeeded', metrics: { ...totals, rowsWritten: totals.rowsAccepted, symbolsCovered: 0, inputWatermark: null, outputWatermark: null } };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result = { status: 'failed', error, metrics: emptyMetrics() };
    }
    await closeRun(client, runId, result);
    if (result.status === 'failed') {
      console.error('[fii-dii] FAILED:', result.error.message);
      process.exitCode = 1;
    }
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[fii-dii] FATAL:', err);
  process.exitCode = 1;
});
