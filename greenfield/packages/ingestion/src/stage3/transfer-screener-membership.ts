// Task 3.3: Trendlyne screener membership transfer. Two sources:
// (1) a fresh kayal fetch against all 1,052 known PKs -- this is the ONLY
// reliable source, because (2) the old DB's `screener_appearances` table
// stores Trendlyne's `screener_id` as a human-readable slug
// (`'1h-adx-bearish-divergence'`), never the numeric `screenpk` this
// schema's identity model requires, and there is no slug-to-screenpk
// mapping anywhere in the old system to recover it from. One-shot
// operational script -- same convention as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/transfer-screener-membership.ts [--limit N]
import { createHash } from 'node:crypto';
import {
  bulkUpsertScreenerMembership, createPool, insertRawObject, insertTransferReject, loadKnownSymbols,
  openRun, closeRun, queryLegacyTrendlyneScreenerIdSummary, seedStage3Registry, upsertScreenerDefinition,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';
import { logicalSession } from '@greenfield/market-calendar';
import { fetchWithPolicy } from '@greenfield/provider-sdk';
import { KAYAL_HEADERS, KNOWN_PKS, kayalUrl, parseKayalResponse } from './kayal.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-screener-membership';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';

const limitArgIndex = process.argv.indexOf('--limit');
const PK_LIMIT = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) : KNOWN_PKS.length;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface FreshTally {
  screenersAttempted: number;
  screenersOk: number;
  screenersFailed: number;
  membershipRowsSeen: number;
  membershipRowsAccepted: number;
  membershipRowsRejected: number;
}

async function transferFreshKayal(pool: Awaited<ReturnType<typeof createPool>>, runId: string, knownSymbols: Set<string>): Promise<FreshTally> {
  const observedAt = new Date(Date.now()).toISOString();
  const pks = KNOWN_PKS.slice(0, PK_LIMIT);
  const tally: FreshTally = {
    screenersAttempted: 0, screenersOk: 0, screenersFailed: 0,
    membershipRowsSeen: 0, membershipRowsAccepted: 0, membershipRowsRejected: 0,
  };

  // §2.2: "0.4s between requests, batch size 15 with 0.5s gap."
  const BATCH_SIZE = 15;
  const WITHIN_BATCH_DELAY_MS = 400;
  const BETWEEN_BATCH_GAP_MS = 500;

  for (let batchStart = 0; batchStart < pks.length; batchStart += BATCH_SIZE) {
    const batch = pks.slice(batchStart, batchStart + BATCH_SIZE);
    const batchResults = await Promise.all(
      batch.map(async (pk, i) => {
        await sleep(i * WITHIN_BATCH_DELAY_MS);
        const url = kayalUrl(pk);
        try {
          const raw = await fetchWithPolicy({ url, headers: KAYAL_HEADERS });
          return { pk, raw };
        } catch (err) {
          return { pk, error: err instanceof Error ? err : new Error(String(err)) };
        }
      }),
    );

    const client = await pool.connect();
    try {
      for (const r of batchResults) {
        tally.screenersAttempted++;
        if ('error' in r) {
          tally.screenersFailed++;
          await insertTransferReject(client, { sourceTable: 'trendlyne.kayal', sourcePk: String(r.pk), reason: `fetch failed: ${r.error.message}` });
          continue;
        }
        await insertRawObject(client, {
          runId, endpointKey: 'trendlyne.kayal_screener', contentHash: r.raw.contentHash,
          httpStatus: r.raw.httpStatus, contentType: r.raw.contentType, byteSize: r.raw.byteSize,
          storageUri: `local://raw/${r.raw.contentHash}`,
        });
        if (r.raw.httpStatus !== 200) {
          tally.screenersFailed++;
          await insertTransferReject(client, { sourceTable: 'trendlyne.kayal', sourcePk: String(r.pk), reason: `HTTP ${r.raw.httpStatus}` });
          continue;
        }

        const parsed = parseKayalResponse(r.raw.body);
        if (parsed.rejectReason) {
          tally.screenersFailed++;
          await insertTransferReject(client, { sourceTable: 'trendlyne.kayal', sourcePk: String(r.pk), reason: parsed.rejectReason });
          continue;
        }

        const providerId = String(parsed.screenId ?? r.pk);
        const requestHash = createHash('sha256').update(kayalUrl(r.pk)).digest('hex').slice(0, 16);
        await upsertScreenerDefinition(client, {
          provider: 'trendlyne', providerId, version: 1,
          name: parsed.title ?? `screenpk ${r.pk}`, requestHash, requestBody: null, category: null,
          // A live shape test just ran (this very fetch) and succeeded -- unlike
          // Task 3.6's legacy MC/ETNow catalog rows, which carry no such proof.
          enabled: true,
        });

        const validMembers = [];
        for (const m of parsed.members) {
          tally.membershipRowsSeen++;
          if (!knownSymbols.has(m.symbol)) {
            tally.membershipRowsRejected++;
            await insertTransferReject(client, {
              sourceTable: 'trendlyne.kayal.members', sourcePk: `${r.pk}:${m.symbol}`,
              reason: `symbol '${m.symbol}' not found in security table`,
            });
            continue;
          }
          validMembers.push(m);
        }
        tally.membershipRowsSeen += parsed.rejectedRows; // rows the parser itself couldn't extract a symbol from (e.g. BSE-only)
        tally.membershipRowsRejected += parsed.rejectedRows;

        const written = await bulkUpsertScreenerMembership(client, 'trendlyne', providerId, 1, validMembers, observedAt, runId);
        tally.membershipRowsAccepted += validMembers.length;
        tally.screenersOk++;
        void written; // rows actually inserted (vs idempotent dup) -- not needed for the accept/reject accounting
      }
    } finally {
      client.release();
    }

    if (batchStart + BATCH_SIZE < pks.length) await sleep(BETWEEN_BATCH_GAP_MS);
  }

  return tally;
}

interface LegacyTally {
  rowsSeen: number;
  rowsAccepted: number;
  rowsRejected: number;
}

async function transferLegacySummary(pool: Awaited<ReturnType<typeof createPool>>): Promise<LegacyTally> {
  const summary = await queryLegacyTrendlyneScreenerIdSummary(OLD_DATABASE_URL);
  const client = await pool.connect();
  try {
    let rowsSeen = 0;
    for (const s of summary) {
      rowsSeen += s.row_count;
      await insertTransferReject(client, {
        sourceTable: 'legacy.screener_appearances.trendlyne',
        sourcePk: s.screener_id,
        reason: `screener_id is a Trendlyne slug ('${s.screener_id}'), not a resolvable screenpk integer -- no slug-to-screenpk mapping exists in the old system`,
        rawSnippet: { rowCount: s.row_count, sampleSymbol: s.sample_symbol },
      });
    }
    return { rowsSeen, rowsAccepted: 0, rowsRejected: rowsSeen };
  } finally {
    client.release();
  }
}

function emptyMetrics(): JobMetrics {
  return { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

async function main(): Promise<void> {
  const pool = createPool();
  await seedStage3Registry(pool);
  const knownSymbols = await loadKnownSymbols(pool);

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage3.screener_membership', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  try {
    const startedAt = Date.now();
    const fresh = await transferFreshKayal(pool, runId, knownSymbols);
    const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
    console.log(`[screener-membership] fresh kayal: ${fresh.screenersOk}/${fresh.screenersAttempted} screeners OK, ${fresh.screenersFailed} failed, ` +
      `membership rows seen=${fresh.membershipRowsSeen} accepted=${fresh.membershipRowsAccepted} rejected=${fresh.membershipRowsRejected} (${elapsedMin} min)`);

    const legacy = await transferLegacySummary(pool);
    console.log(`[screener-membership] legacy (old DB screener_appearances, trendlyne): seen=${legacy.rowsSeen} accepted=${legacy.rowsAccepted} rejected=${legacy.rowsRejected}`);

    const totals = {
      rowsSeen: fresh.membershipRowsSeen + legacy.rowsSeen,
      rowsAccepted: fresh.membershipRowsAccepted + legacy.rowsAccepted,
      rowsRejected: fresh.membershipRowsRejected + legacy.rowsRejected,
    };
    const metrics: JobMetrics = { ...totals, rowsWritten: totals.rowsAccepted, symbolsCovered: 0, inputWatermark: null, outputWatermark: logicalSession(new Date(Date.now())) };
    result = fresh.screenersOk > 0
      ? { status: 'succeeded', metrics }
      : { status: 'failed', error: new Error('zero screeners fetched successfully'), metrics };
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
    console.error('[screener-membership] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[screener-membership] FATAL:', err);
  process.exitCode = 1;
});
