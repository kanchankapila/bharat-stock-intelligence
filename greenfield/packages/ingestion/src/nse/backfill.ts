// BUILD_STAGE_0_2_SPEC.md Task 2.2. Oldest-first, checkpointed in Postgres
// (derived from ingestion_run history -- no separate checkpoint table),
// idempotent via ON CONFLICT DO NOTHING + an early "already completed" skip,
// 404 = non-trading day (never 'failed'), one ingestion_run per date.
//
// "Only db issues SQL. No SQL string in api or ingestion." (GREENFIELD_
// BUILD_SPEC.md A2) -- every write below goes through a named function in
// @greenfield/db (packages/db/src/nse-bhavcopy-repo.ts), never a raw
// client.query() with SQL written in this package.
import type pg from 'pg';
import { fetchWithPolicy } from '@greenfield/provider-sdk';
import {
  closeRun, openRun,
  bulkSeedSecurityFirstSighting, bulkUpsertDeliveryStat, bulkUpsertMarketBar,
  insertRawObject, isRunAlreadyCompleted, markRawObjectParsed,
  setRunErrorSummary, upsertTradingSession,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';
import { categorizeRejectReason, parseBhavcopy } from './bhavcopy.js';

export const NSE_BHAVCOPY_JOB_ID = 'nse.bhavcopy';
export const NSE_BHAVCOPY_ENDPOINT_KEY = 'nse.bhavcopy';

const NSE_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
  Referer: 'https://www.nseindia.com/',
  Accept: 'text/csv,*/*',
};

/** Plain calendar-date iteration -- NOT a trading-date computation (that's
 * market-calendar's job, and it can't help here: this IS the code that
 * populates trading_session in the first place, so nothing exists yet to
 * query). Every candidate date gets probed; NSE's 200/404 answer is what
 * actually builds the calendar (§2.4). `new Date(iso)` with an explicit
 * argument is plain deterministic arithmetic, not the "guess today" pattern
 * the market-calendar-only rule targets. */
export function nextCalendarDate(iso: string): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}

function toDDMMYYYY(iso: string): string {
  const [y, m, d] = iso.split('-');
  return `${d}${m}${y}`;
}

function emptyMetrics(): JobMetrics {
  return {
    rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0,
    symbolsCovered: 0, inputWatermark: null, outputWatermark: null,
  };
}

export interface DateOutcome {
  date: string;
  status: 'succeeded' | 'skipped' | 'failed';
  rowsAccepted: number;
  rowsRejected: number;
  reason?: string;
}

function realNseUrl(date: string): string {
  return `https://archives.nseindia.com/products/content/sec_bhavdata_full_${toDDMMYYYY(date)}.csv`;
}

export interface BackfillDateOptions {
  dryRun?: boolean;
  codeCommit: string;
  /** Defaults to the real NSE archive host. Overridable so contract tests
   * point at a local fixture server instead of live internet -- same
   * discipline as provider-sdk's own tests. */
  urlForDate?: (date: string) => string;
  /** Defaults to NSE_BHAVCOPY_JOB_ID/NSE_BHAVCOPY_ENDPOINT_KEY. Overridable
   * so tests never have to write ingestion_run/raw_object rows under the
   * SAME identifier a real production backfill uses. Sharing that identifier
   * is exactly what let a test's cleanup delete the real 2021-present
   * backfill's data on 2026-08-13 (found via a live incident, not a review)
   * -- this override exists so no test needs to make that mistake again. */
  jobId?: string;
  endpointKey?: string;
}

export async function runBackfillForDate(
  pool: pg.Pool,
  date: string,
  options: BackfillDateOptions,
): Promise<DateOutcome> {
  const jobId = options.jobId ?? NSE_BHAVCOPY_JOB_ID;
  const endpointKey = options.endpointKey ?? NSE_BHAVCOPY_ENDPOINT_KEY;

  // Idempotent: a date already closed succeeded/skipped is a no-op. Dry-run
  // deliberately bypasses this -- it's a preview, not a checkpointed attempt.
  if (!options.dryRun && (await isRunAlreadyCompleted(pool, jobId, date))) {
    return { date, status: 'skipped', rowsAccepted: 0, rowsRejected: 0, reason: 'already completed (idempotent no-op)' };
  }

  const url = (options.urlForDate ?? realNseUrl)(date);

  if (options.dryRun) {
    const raw = await fetchWithPolicy({ url, headers: NSE_HEADERS });
    if (raw.httpStatus === 404) {
      return { date, status: 'skipped', rowsAccepted: 0, rowsRejected: 0, reason: 'non-trading day (404) -- dry-run, no DB write' };
    }
    const parsed = parseBhavcopy(raw.body);
    return {
      date, status: 'succeeded',
      rowsAccepted: parsed.accepted.length, rowsRejected: parsed.rejected.length,
      reason: `dry-run: would write ${parsed.accepted.length} market_bar + delivery_stat rows`,
    };
  }

  const client = await pool.connect();
  try {
    const runId = await openRun(client, {
      jobId,
      endpointKey,
      codeCommit: options.codeCommit,
      inputWatermark: date,
    });

    let raw;
    try {
      raw = await fetchWithPolicy({ url, headers: NSE_HEADERS });
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const result: JobResult = { status: 'failed', error, metrics: emptyMetrics() };
      await closeRun(client, runId, result);
      return { date, status: 'failed', rowsAccepted: 0, rowsRejected: 0, reason: error.message };
    }

    // "A 404 from the bhavcopy URL is the expected, correct response for a
    // weekend or holiday... do not retry it, do not log it as an error, and
    // do not mark the run failed." (§2.4)
    if (raw.httpStatus === 404) {
      const result: JobResult = {
        status: 'skipped',
        reason: 'non-trading day (404)',
        metrics: { ...emptyMetrics(), outputWatermark: date },
      };
      await closeRun(client, runId, result);
      return { date, status: 'skipped', rowsAccepted: 0, rowsRejected: 0, reason: 'non-trading day (404)' };
    }

    // Raw capture BEFORE parse -- a parser bug stays replayable.
    await insertRawObject(client, {
      runId, endpointKey, contentHash: raw.contentHash,
      httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
      storageUri: `local://raw/${raw.contentHash}`,
    });

    const parsed = parseBhavcopy(raw.body);

    // "HTTP 200 is not success" (§B3), and this is why: NSE's archive server
    // returns HTTP 200 with the PREVIOUS FRIDAY's file content verbatim when
    // queried for a Sunday's date (Saturday correctly 404s). Live-verified
    // 2026-08-13: requesting 10-Jan-2021 (a Sunday) returns a byte-identical
    // response to 08-Jan-2021 (Friday), DATE1 column and all. The file's own
    // parsed date is authoritative, never the requested URL date -- if they
    // disagree, there is no genuine new data for this date, and treating it
    // as a real session would silently fabricate a trading day that never
    // happened (this exact bug wrote 51 phantom "Sunday sessions" into 2021
    // alone before this check existed).
    const fileDate = parsed.accepted[0]?.marketBar.sessionDate;
    if (fileDate && fileDate !== date) {
      const reason = `stale content: requested ${date} but file's own DATE1 says ${fileDate} (NSE served rolled-over data, not a real file for this date)`;
      await closeRun(client, runId, {
        status: 'skipped', reason,
        metrics: { ...emptyMetrics(), outputWatermark: date },
      });
      return { date, status: 'skipped', rowsAccepted: 0, rowsRejected: 0, reason };
    }

    const metrics: JobMetrics = {
      rowsSeen: parsed.accepted.length + parsed.rejected.length,
      rowsAccepted: parsed.accepted.length,
      rowsRejected: parsed.rejected.length,
      rowsWritten: 0,
      symbolsCovered: 0,
      inputWatermark: date,
      outputWatermark: date,
    };

    if (parsed.accepted.length > 0) {
      // Publication-lag stand-in: session close (15:30 IST) same day. The
      // real calendar-driven publicationCutoff() lands with market-calendar's
      // Stage-1 stub being filled in -- out of scope for this adapter.
      const availableAt = `${date}T10:00:00Z`; // 15:30 IST

      // First-sighting seed only -- listed_to/status is derived over the
      // WHOLE backfilled range in one pass (Task 2.3), not incrementally
      // here, so a symbol's final status doesn't depend on processing order.
      // Bulk (one round trip per table, not 3 per row -- see
      // bulkUpsertMarketBar's own comment for why this matters at ~1,900
      // rows/day x ~1,435 real trading days).
      await bulkSeedSecurityFirstSighting(client, parsed.accepted.map((r) => r.marketBar.symbol), date);
      await bulkUpsertMarketBar(
        client,
        parsed.accepted.map((r) => ({ ...r.marketBar, sessionDate: date, availableAt, runId })),
        date, availableAt, runId,
      );
      await bulkUpsertDeliveryStat(
        client,
        parsed.accepted.map((r) => ({ ...r.delivery, sessionDate: date, availableAt, runId })),
        date, availableAt, runId,
      );
      metrics.rowsWritten = parsed.accepted.length;
      metrics.symbolsCovered = parsed.accepted.length;

      // Trading-session derivation, exactly as §2.4 specifies: a date
      // returning >=1 accepted equity row IS a trading session.
      await upsertTradingSession(client, 'NSE', date, `${date}T03:45:00Z`, `${date}T10:00:00Z`); // 09:15 / 15:30 IST in UTC
    }

    await markRawObjectParsed(client, runId);
    await closeRun(client, runId, { status: 'succeeded', metrics });

    // Reject-reason tally, for Task 2.5's coverage report -- reuses
    // ingestion_run.error_summary (a free-text column, no schema change)
    // rather than storing every raw rejected row. closeRun only ever writes
    // this column from a JobResult's own error message, so this is a
    // deliberate second write specific to the NSE adapter's own needs, not a
    // general run-ledger concept.
    if (parsed.rejected.length > 0) {
      const tally: Record<string, number> = {};
      for (const r of parsed.rejected) {
        const category = categorizeRejectReason(r.reason);
        tally[category] = (tally[category] ?? 0) + 1;
      }
      await setRunErrorSummary(client, runId, JSON.stringify({ rejectReasons: tally }));
    }

    return { date, status: 'succeeded', rowsAccepted: parsed.accepted.length, rowsRejected: parsed.rejected.length };
  } finally {
    client.release();
  }
}

export interface BackfillOptions extends BackfillDateOptions {
  from: string;
  to: string;
  /** Pause between dates -- "this is a public archive and you are fetching
   * ~1,400 files" (§2.2.6, "respect it strictly"). Applied even on a
   * 404/non-trading day, not just accepted fetches, so the request RATE
   * stays bounded regardless of how many of those ~2,000 calendar days turn
   * out to be real trading sessions. */
  delayMsBetweenRequests?: number;
  onProgress?: (outcome: DateOutcome, index: number) => void;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runBackfill(pool: pg.Pool, options: BackfillOptions): Promise<DateOutcome[]> {
  const results: DateOutcome[] = [];
  let index = 0;
  for (let cur = options.from; cur <= options.to; cur = nextCalendarDate(cur)) {
    const outcome = await runBackfillForDate(pool, cur, options);
    results.push(outcome);
    options.onProgress?.(outcome, index);
    index += 1;
    if (options.delayMsBetweenRequests && cur < options.to) {
      await sleep(options.delayMsBetweenRequests);
    }
  }
  return results;
}
