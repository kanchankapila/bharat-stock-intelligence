// Task 3.2: corporate actions / events transfer. Two sources, both into
// event_fact: (1) a fresh InvestSights fetch (picks up anything declared
// after the old DB's last run), (2) a read-only copy of the old DB's
// `corporate_actions` table. One-shot operational script -- same convention
// as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/transfer-corporate-actions.ts
import type pg from 'pg';
import {
  createPool, insertRawObject, insertTransferReject, loadKnownSymbols,
  openRun, closeRun, queryLegacyCorporateActions, seedStage3Registry, upsertEventFact,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';
import { fetchWithPolicy } from '@greenfield/provider-sdk';
import { deriveEventKind, investSightsUrl, INVESTSIGHTS_HEADERS, parseInvestSightsResponse } from './investsights.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-corporate-actions';
// Read-only, single-query access to the existing live DB -- never written to.
// Matches CLAUDE.md's documented local POSTGRES_URL; override via env if needed.
const OLD_DATABASE_URL = process.env.OLD_DATABASE_URL ?? 'postgresql://bharat:bharat@127.0.0.1:5433/bharat_intel';

interface TransferTally {
  rowsSeen: number;
  rowsAccepted: number;
  rowsRejected: number;
}

function addDays(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

async function transferFreshInvestSights(client: pg.ClientBase, runId: string, knownSymbols: Set<string>): Promise<TransferTally> {
  const url = investSightsUrl(1825, 180);
  const raw = await fetchWithPolicy({ url, headers: INVESTSIGHTS_HEADERS });
  await insertRawObject(client, {
    runId, endpointKey: 'investsights.corporate_actions', contentHash: raw.contentHash,
    httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
    storageUri: `local://raw/${raw.contentHash}`,
  });
  if (raw.httpStatus !== 200) {
    throw new Error(`InvestSights returned HTTP ${raw.httpStatus}`);
  }

  const parsed = parseInvestSightsResponse(raw.body);
  let accepted = 0;
  let rejected = 0;

  for (const r of parsed.rejected) {
    await insertTransferReject(client, { sourceTable: 'investsights.actions', sourcePk: 'unknown', reason: r.reason, rawSnippet: r.raw });
    rejected++;
  }

  for (const a of parsed.accepted) {
    if (!knownSymbols.has(a.symbol)) {
      await insertTransferReject(client, { sourceTable: 'investsights.actions', sourcePk: a.sourceUrl, reason: `symbol '${a.symbol}' not found in security table`, rawSnippet: a });
      rejected++;
      continue;
    }
    if (!a.filingDate) {
      await insertTransferReject(client, { sourceTable: 'investsights.actions', sourcePk: a.sourceUrl, reason: 'missing filing_date -- cannot compute available_at', rawSnippet: a });
      rejected++;
      continue;
    }
    const effectiveDate = a.exDate ?? a.recordDate;
    // ON CONFLICT DO NOTHING on a dup source_url is still a validated,
    // accepted row (idempotent re-run) -- accepted/rejected tracks
    // validation outcome, not whether this run actually wrote a new row.
    await upsertEventFact(client, {
      source: 'investsights',
      sourceEventId: a.sourceUrl,
      symbol: a.symbol,
      kind: deriveEventKind(a.category),
      effectiveAt: effectiveDate ? `${effectiveDate}T00:00:00Z` : null,
      // earliest a filed PDF is publicly viewable -- a conservative proxy (§2.1 step 4).
      availableAt: `${addDays(a.filingDate, 1)}T00:00:00Z`,
      headline: a.headline,
      payload: {
        category: a.category, dividendPerShare: a.dividendPerShare, recordDate: a.recordDate,
        exDate: a.exDate, filingDate: a.filingDate, companyName: a.companyName, upcoming: a.upcoming,
      },
      provenanceQuality: 'inferred',
      runId,
    });
    accepted++;
  }

  return { rowsSeen: parsed.accepted.length + parsed.rejected.length, rowsAccepted: accepted, rowsRejected: rejected };
}

function deriveKindFromLegacyActionType(actionType: string | null): string {
  const lower = (actionType ?? '').toLowerCase();
  return lower.includes('result') ? 'earnings' : 'announcement';
}

async function transferLegacyCorporateActions(client: pg.ClientBase, runId: string, knownSymbols: Set<string>): Promise<TransferTally> {
  const rows = await queryLegacyCorporateActions(OLD_DATABASE_URL);

  let accepted = 0;
  let rejected = 0;

  for (const r of rows) {
    const symbol = (r.symbol ?? '').trim().toUpperCase();
    const sourcePk = `${r.source}:${symbol}:${r.ex_date}:${r.action_type}`;
    if (!symbol || !knownSymbols.has(symbol)) {
      await insertTransferReject(client, { sourceTable: 'legacy.corporate_actions', sourcePk, reason: `symbol '${symbol}' not found in security table`, rawSnippet: r });
      rejected++;
      continue;
    }
    const ingestedAt = r.ingested_at ? new Date(r.ingested_at) : null;
    if (!ingestedAt || Number.isNaN(ingestedAt.getTime())) {
      await insertTransferReject(client, { sourceTable: 'legacy.corporate_actions', sourcePk, reason: 'unparseable ingested_at -- no available_at proxy', rawSnippet: r });
      rejected++;
      continue;
    }
    await upsertEventFact(client, {
      source: 'legacy_corporate_actions',
      sourceEventId: `legacy:${sourcePk}`,
      symbol,
      kind: deriveKindFromLegacyActionType(r.action_type),
      effectiveAt: r.ex_date ? `${r.ex_date}T00:00:00Z` : null,
      availableAt: ingestedAt.toISOString(),
      headline: null,
      payload: { legacySource: r.source, actionType: r.action_type, ratio: r.ratio, amount: r.amount, exDate: r.ex_date },
      provenanceQuality: 'inferred',
      runId,
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
  const knownSymbols = await loadKnownSymbols(pool);

  const client = await pool.connect();
  try {
    const runId = await openRun(client, { jobId: 'stage3.corporate_actions', codeCommit: CODE_COMMIT });
    let result: JobResult;
    try {
      const fresh = await transferFreshInvestSights(client, runId, knownSymbols);
      console.log(`[corporate-actions] fresh (InvestSights): seen=${fresh.rowsSeen} accepted=${fresh.rowsAccepted} rejected=${fresh.rowsRejected}`);
      const legacy = await transferLegacyCorporateActions(client, runId, knownSymbols);
      console.log(`[corporate-actions] legacy (old DB corporate_actions): seen=${legacy.rowsSeen} accepted=${legacy.rowsAccepted} rejected=${legacy.rowsRejected}`);
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
      console.error('[corporate-actions] FAILED:', result.error.message);
      process.exitCode = 1;
    }
  } finally {
    client.release();
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[corporate-actions] FATAL:', err);
  process.exitCode = 1;
});
