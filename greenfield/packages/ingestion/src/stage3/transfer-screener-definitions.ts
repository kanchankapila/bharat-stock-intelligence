// Task 3.6: MoneyControl + ETnow screener catalog transfer. Pure catalog
// entries from the old DB's `screener_master` -- no live fetch, these
// transfer cleanly. Inserted with enabled=false; promotion to enabled=true
// requires a live shape test, not done during transfer (unlike Task 3.3's
// kayal screeners, which prove liveness by the fetch that populates them).
// One-shot operational script -- same convention as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/transfer-screener-definitions.ts
import { createHash } from 'node:crypto';
import {
  countScreenerDefinitions, createPool, insertTransferReject, openRun, closeRun,
  queryLegacyScreenerMasterMcEtnow, seedStage3Registry, upsertScreenerDefinition,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-screener-definitions';
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';

const SOURCE_TO_PROVIDER: Record<string, string> = {
  MoneyControl: 'moneycontrol',
  ETnow: 'etnow',
};

function emptyMetrics(): JobMetrics {
  return { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

async function main(): Promise<void> {
  const pool = createPool();
  await seedStage3Registry(pool);

  const client = await pool.connect();
  try {
    const runId = await openRun(client, { jobId: 'stage3.screener_definitions', codeCommit: CODE_COMMIT });
    let result: JobResult;
    try {
      const rows = await queryLegacyScreenerMasterMcEtnow(OLD_DATABASE_URL);
      const seen = new Set<string>();
      let accepted = 0;
      let rejected = 0;

      for (const r of rows) {
        const provider = SOURCE_TO_PROVIDER[r.source ?? ''];
        const scanId = (r.scan_id ?? '').trim();
        const name = (r.name ?? '').trim();
        const dedupKey = `${provider}:${scanId}`;

        if (!provider || !scanId || !name) {
          await insertTransferReject(client, { sourceTable: 'legacy.screener_master', sourcePk: `${r.source}:${scanId}`, reason: 'missing provider mapping, scan_id, or name', rawSnippet: r });
          rejected++;
          continue;
        }
        if (seen.has(dedupKey)) {
          await insertTransferReject(client, { sourceTable: 'legacy.screener_master', sourcePk: dedupKey, reason: 'duplicate (provider, scan_id) within old screener_master', rawSnippet: r });
          rejected++;
          continue;
        }
        seen.add(dedupKey);

        const requestHash = createHash('sha256').update(`legacy:${provider}:${scanId}`).digest('hex').slice(0, 16);
        await upsertScreenerDefinition(client, {
          provider, providerId: scanId, version: 1, name, requestHash, requestBody: null, category: null,
          enabled: false,
        });
        accepted++;
      }

      console.log(`[screener-definitions] legacy (old DB screener_master, MC+ETnow): seen=${rows.length} accepted=${accepted} rejected=${rejected}`);
      for (const provider of ['moneycontrol', 'etnow']) {
        const n = await countScreenerDefinitions(pool, provider);
        console.log(`[screener-definitions] screener_definition rows for provider='${provider}': ${n}`);
      }

      result = {
        status: 'succeeded',
        metrics: { rowsSeen: rows.length, rowsAccepted: accepted, rowsRejected: rejected, rowsWritten: accepted, symbolsCovered: 0, inputWatermark: null, outputWatermark: null },
      };
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      result = { status: 'failed', error, metrics: emptyMetrics() };
    }
    await closeRun(client, runId, result);
    if (result.status === 'failed') {
      console.error('[screener-definitions] FAILED:', result.error.message);
      process.exitCode = 1;
    }
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[screener-definitions] FATAL:', err);
  process.exitCode = 1;
});
