// Task 3.5: fundamentals transfer via fresh ET Stats + MarketsMojo fetches.
// Old `fundamentals_history` rows are NOT bulk-copied (prohibition #14 /
// spec Task 3.5) -- their available_at used CURRENT_TIMESTAMP-style proxies
// that would corrupt the point-in-time logic this schema exists to protect.
// One-shot operational script -- same convention as nse/run-full-backfill.ts.
//
// Usage: tsx src/stage3/transfer-fundamentals.ts [--limit N] [--concurrency N]
import {
  createPool, insertRawObject, insertTransferReject, openRun, closeRun,
  seedStage3Registry, upsertFundamentalFact,
} from '@greenfield/db';
import type { JobMetrics, JobResult } from '@greenfield/contracts';
import { fetchWithPolicy } from '@greenfield/provider-sdk';
import { etStatsUrl, parseEtStatsResponse, type EtStatsEvent } from './et-stats.js';
import { MARKETSMOJO_FINANCIALS_URL, MARKETSMOJO_HEADERS, marketsMojoRequestBody, parseMarketsMojoResponse } from './marketsmojo-financials.js';
import { buildSymbolIdMaps, loadStocklist } from './stocklist.js';

try {
  process.loadEnvFile();
} catch {
  // rely on process.env
}

const CODE_COMMIT = process.env.CODE_COMMIT ?? 'stage3-fundamentals';
const LAG_FLOOR_DAYS = 90;
const ET_STATS_HEADERS = { Accept: 'application/json' };
const ET_EVENTS: EtStatsEvent[] = ['Balance', 'CashFlow', 'Quarterly', 'Ratio'];
const MM_MAX_PAGES = 8;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addDaysIso(dateStr: string, days: number): string {
  const d = new Date(`${dateStr}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString();
}

/** periodEnd + 90d is a hard floor, not a default: the platform's own
 * definition is "not yet knowable" before that date, full stop -- so a fact
 * for a period still inside the embargo window must not be written at all,
 * under ANY available_at. Capping available_at at fetch time (a first
 * attempt at this fix) avoided future-dating but then violated the floor
 * itself for every recent quarter -- 104,100 rows, caught live by
 * fundamentals-lag-floor's own negative-control test. The only value
 * consistent with both constraints is to skip the fact until the floor has
 * actually passed; a later, forward-only fetch (Stage 4's live path) picks
 * it up once it has. Returns null when the floor hasn't been reached yet. */
export function availableAtFloor(periodEnd: string, lagDays: number, fetchedAtIso: string): string | null {
  const floor = addDaysIso(periodEnd, lagDays);
  return floor <= fetchedAtIso ? floor : null;
}

interface SymbolTally {
  symbol: string;
  etRowsSeen: number;
  etRowsAccepted: number;
  etRowsWithheld: number;
  mmRowsSeen: number;
  mmRowsAccepted: number;
  mmRowsWithheld: number;
}

async function transferOneSymbol(
  pool: ReturnType<typeof createPool>,
  runId: string,
  symbol: string,
  companyId: string | undefined,
  stockId: string | undefined,
): Promise<SymbolTally> {
  const tally: SymbolTally = { symbol, etRowsSeen: 0, etRowsAccepted: 0, etRowsWithheld: 0, mmRowsSeen: 0, mmRowsAccepted: 0, mmRowsWithheld: 0 };
  const fetchedAt = new Date(Date.now()).toISOString();
  const client = await pool.connect();
  try {
    if (companyId) {
      for (const event of ET_EVENTS) {
        const last = event === 'Quarterly' ? 8 : 5;
        const url = etStatsUrl(companyId, event, last);
        const raw = await fetchWithPolicy({ url, headers: ET_STATS_HEADERS });
        await insertRawObject(client, {
          runId, endpointKey: 'etmarketsapis.stats', contentHash: raw.contentHash,
          httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
          storageUri: `local://raw/${raw.contentHash}`,
        });
        if (raw.httpStatus !== 200) {
          tally.etRowsSeen++;
          await insertTransferReject(client, { sourceTable: 'etmarketsapis.stats', sourcePk: `${symbol}:${event}`, reason: `HTTP ${raw.httpStatus}` });
        } else {
          const parsed = parseEtStatsResponse(raw.body, event);
          if (parsed.rejectReason) {
            tally.etRowsSeen++;
            await insertTransferReject(client, { sourceTable: 'etmarketsapis.stats', sourcePk: `${symbol}:${event}`, reason: parsed.rejectReason });
          }
          tally.etRowsSeen += parsed.accepted.length + parsed.rejectedRows;
          for (const f of parsed.accepted) {
            const availableAt = availableAtFloor(f.periodEnd, LAG_FLOOR_DAYS, fetchedAt);
            if (availableAt === null) {
              tally.etRowsWithheld++;
              continue;
            }
            await upsertFundamentalFact(client, {
              symbol, metric: f.metric, periodEnd: f.periodEnd, periodType: f.periodType, source: 'etmarketsapis',
              value: f.value, unit: null, announcedAt: null, availableAt,
              provenanceQuality: 'inferred', runId,
            });
            tally.etRowsAccepted++;
          }
        }
        await sleep(300);
      }
    } else {
      await insertTransferReject(client, { sourceTable: 'etmarketsapis.stocklist_resolution', sourcePk: symbol, reason: 'no companyid in scripts/stocklist.json' });
    }

    if (stockId) {
      for (let page = 1; page <= MM_MAX_PAGES; page++) {
        const raw = await fetchWithPolicy({
          url: MARKETSMOJO_FINANCIALS_URL, method: 'POST', headers: MARKETSMOJO_HEADERS,
          body: marketsMojoRequestBody(stockId, page),
        });
        await insertRawObject(client, {
          runId, endpointKey: 'marketsmojo.financials', contentHash: raw.contentHash,
          httpStatus: raw.httpStatus, contentType: raw.contentType, byteSize: raw.byteSize,
          storageUri: `local://raw/${raw.contentHash}`,
        });
        await sleep(500);
        if (raw.httpStatus !== 200) break;
        const parsed = parseMarketsMojoResponse(raw.body);
        if (parsed.isEmpty) break;
        tally.mmRowsSeen += parsed.accepted.length;
        for (const f of parsed.accepted) {
          const availableAt = availableAtFloor(f.periodEnd, LAG_FLOOR_DAYS, fetchedAt);
          if (availableAt === null) {
            tally.mmRowsWithheld++;
            continue;
          }
          await upsertFundamentalFact(client, {
            symbol, metric: f.metric, periodEnd: f.periodEnd, periodType: 'Q', source: 'marketsmojo',
            value: f.value, unit: null, announcedAt: null, availableAt,
            provenanceQuality: 'inferred', runId,
          });
          tally.mmRowsAccepted++;
        }
      }
    } else {
      await insertTransferReject(client, { sourceTable: 'marketsmojo.stocklist_resolution', sourcePk: symbol, reason: 'no stockid in scripts/stocklist.json' });
    }
  } finally {
    client.release();
  }
  return tally;
}

async function runWithConcurrency<T, R>(items: T[], concurrency: number, fn: (item: T, index: number) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  async function worker(): Promise<void> {
    for (;;) {
      const i = next++;
      if (i >= items.length) return;
      results[i] = await fn(items[i]!, i);
    }
  }
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  return results;
}

function emptyMetrics(): JobMetrics {
  return { rowsSeen: 0, rowsAccepted: 0, rowsRejected: 0, rowsWritten: 0, symbolsCovered: 0, inputWatermark: null, outputWatermark: null };
}

async function main(): Promise<void> {
  const limitArgIndex = process.argv.indexOf('--limit');
  const concurrencyArgIndex = process.argv.indexOf('--concurrency');
  const limit = limitArgIndex >= 0 ? Number(process.argv[limitArgIndex + 1]) : Infinity;
  const concurrency = concurrencyArgIndex >= 0 ? Number(process.argv[concurrencyArgIndex + 1]) : 4;

  const pool = createPool();
  await seedStage3Registry(pool);

  const { rows: listedRows } = await pool.query<{ symbol: string }>(`SELECT symbol FROM security WHERE status = 'listed' ORDER BY symbol`);
  const listedSymbols = listedRows.map((r) => r.symbol).slice(0, Number.isFinite(limit) ? limit : undefined);
  const { companyIdBySymbol, stockIdBySymbol } = buildSymbolIdMaps(loadStocklist());

  const client = await pool.connect();
  const runId = await openRun(client, { jobId: 'stage3.fundamentals', codeCommit: CODE_COMMIT });
  client.release();

  let result: JobResult;
  try {
    const startedAt = Date.now();
    let done = 0;
    const tallies = await runWithConcurrency(listedSymbols, concurrency, async (symbol) => {
      const t = await transferOneSymbol(pool, runId, symbol, companyIdBySymbol.get(symbol), stockIdBySymbol.get(symbol));
      done++;
      if (done % 50 === 0 || done === listedSymbols.length) {
        const elapsedMin = ((Date.now() - startedAt) / 60_000).toFixed(1);
        console.log(`[fundamentals] ${done}/${listedSymbols.length} symbols (${elapsedMin} min elapsed)`);
      }
      return t;
    });

    const totals = tallies.reduce(
      (acc, t) => ({
        etSeen: acc.etSeen + t.etRowsSeen, etAccepted: acc.etAccepted + t.etRowsAccepted, etWithheld: acc.etWithheld + t.etRowsWithheld,
        mmSeen: acc.mmSeen + t.mmRowsSeen, mmAccepted: acc.mmAccepted + t.mmRowsAccepted, mmWithheld: acc.mmWithheld + t.mmRowsWithheld,
      }),
      { etSeen: 0, etAccepted: 0, etWithheld: 0, mmSeen: 0, mmAccepted: 0, mmWithheld: 0 },
    );
    const symbolsWithAnyFact = tallies.filter((t) => t.etRowsAccepted + t.mmRowsAccepted > 0).length;
    console.log(`[fundamentals] ET Stats: seen=${totals.etSeen} accepted=${totals.etAccepted} withheld(inside 90d lag floor)=${totals.etWithheld}`);
    console.log(`[fundamentals] MarketsMojo: seen=${totals.mmSeen} accepted=${totals.mmAccepted} withheld(inside 90d lag floor)=${totals.mmWithheld}`);
    console.log(`[fundamentals] symbols with >=1 fact: ${symbolsWithAnyFact}/${listedSymbols.length}`);

    const rowsSeen = totals.etSeen + totals.mmSeen;
    const rowsAccepted = totals.etAccepted + totals.mmAccepted;
    result = {
      status: 'succeeded',
      metrics: { rowsSeen, rowsAccepted, rowsRejected: rowsSeen - rowsAccepted, rowsWritten: rowsAccepted, symbolsCovered: symbolsWithAnyFact, inputWatermark: null, outputWatermark: null },
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
    console.error('[fundamentals] FAILED:', result.error.message);
    process.exitCode = 1;
  }

  await pool.end();
}

main().catch((err) => {
  console.error('[fundamentals] FATAL:', err);
  process.exitCode = 1;
});
