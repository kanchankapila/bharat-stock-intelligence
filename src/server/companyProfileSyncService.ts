import { dbAll, dbRun } from './dbAsync';
import { runPython } from './pythonRunner';
import { analyzeCompanyProfile } from '../services/aiService';

// Company profile/fundamentals data is near-static, so trendlyne_overview_fetcher.py now
// scrapes each NSE stock ONCE, ever (skips any symbol that already has a trendlyne_stock_profile
// row) — this is not a periodic refresh. The only reason SHARD_COUNT still exists: the *initial*
// backfill covers the full nse_stocks.tlid universe (NSE master list only — no more
// trendlyne_screener_stocks fallback, which used to pull in ~7,000+ non-NSE-master junk
// symbols), which used to take ~3.6h sequentially while runPython below is capped at 70 min
// (a single-shot run could never finish it — job_heartbeat showed 7/7 failures, last_success
// always null). Splitting that one-time backfill across SHARD_COUNT daily runs (~1/SHARD_COUNT
// of the still-unsynced stocks per day) lets each run fit its budget; once the backlog clears,
// daily runs only pick up new listings (a handful), so sharding becomes a no-op in steady state.
// Pass --resync-all to trendlyne_overview_fetcher.py directly if a genuine full refresh is ever
// needed.
const SHARD_COUNT = 7;

function configuredPositiveInt(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

/**
 * Job verdict for a profile-sync run.
 *
 * This used to be a hardcoded `success: true`, so the job reported success no matter what --
 * live on 2026-09-05 it logged "Success: 0, Failed: 2" and still recorded 'success' in
 * job_run_history, because GEMINI_API_KEY is present in .env but EMPTY, so no symbol's analysis
 * can succeed. That is the "success heartbeat on a step that wrote nothing" class.
 *
 * "Nothing was due" and "everything attempted failed" both write zero rows, and only the second
 * is a fault. A partial failure stays a success: the successes are real work that landed, and
 * per-symbol upstream errors are routine across a multi-hundred-symbol universe.
 */
export function profileSyncVerdict(
  successCount: number,
  failCount: number,
): { success: boolean; processed: number; failed: number } {
  const attempted = successCount + failCount;
  return {
    success: attempted === 0 ? true : successCount > 0,
    processed: successCount,
    failed: failCount,
  };
}

export async function syncAndAnalyzeCompanyProfiles() {
  console.log('[PROFILE SYNC] Fetching Trendlyne overview + company descriptions (also feeds the ML overview features)...');

  // Stable per-day shard so the same day-of-year always covers the same slice — no state to
  // track between runs, and restarts/catch-up re-running the same day just re-covers that shard.
  const dayOfYear = Math.floor(
    (Date.now() - new Date(new Date().getFullYear(), 0, 0).getTime()) / 86_400_000,
  );
  const shardIndex = dayOfYear % SHARD_COUNT;

  // trendlyne_overview_fetcher.py fetches overview-second-part once per stock and writes
  // both the ML-facing financial/shareholding/analyst fields AND the company description
  // into trendlyne_stock_profile — this used to be duplicated by a second, independent
  // Trendlyne call from this file (fetchCompanyOverview), 8.5 hours apart, same endpoint,
  // same ~3,022-stock universe. Reading from the DB instead removes that duplicate call.
  await runPython(
    'trendlyne_overview_fetcher.py',
    ['--shard-index', String(shardIndex), '--shard-count', String(SHARD_COUNT)],
    70 * 60_000,
  );

  // Descriptions change slowly. This default needs about 13 calls/day for a 2,350-name
  // universe, fitting the observed 20-call/day free quota while leaving retry headroom.
  const reanalysisDays = configuredPositiveInt('COMPANY_PROFILE_REANALYSIS_DAYS', 180);
  const dailyLimit = configuredPositiveInt('COMPANY_PROFILE_AI_DAILY_LIMIT', 15);
  const reanalysisCutoff = new Date(Date.now() - reanalysisDays * 24 * 60 * 60 * 1000).toISOString();
  // AF-20260920-01: this used to read tsp.company_description off the row at MAX(date), which
  // is wrong whenever the most recent scrape failed to extract the description (a transient
  // vendor-page miss, not a sync failure) -- company_description is near-static, so a symbol
  // that had a good description on an earlier date should not be treated as never-analyzable
  // just because the LATEST date's row happens to be null. Live case: AXISBANK's 2026-07-05
  // description went null on 2026-07-06 and was never re-picked up (the "already synced" gate
  // meant it wasn't re-scraped), permanently failing company-profiles-sync every time it came
  // due for re-analysis. Sourcing the description from the latest NON-NULL row instead keeps
  // the "due" gate (still keyed on the latest row's date/cp.last_updated) but stops a single
  // bad scrape day from erasing previously-captured, still-valid data.
  const stocks = await dbAll<{ symbol: string; name: string; company_description: string | null }>(`
    SELECT tsp.symbol, ns.name,
      (SELECT tsp2.company_description FROM trendlyne_stock_profile tsp2
       WHERE tsp2.symbol = tsp.symbol AND tsp2.company_description IS NOT NULL
       ORDER BY tsp2.date DESC LIMIT 1) AS company_description
    FROM trendlyne_stock_profile tsp
    JOIN nse_stocks ns ON ns.symbol = tsp.symbol
    LEFT JOIN company_profiles cp ON cp.symbol = tsp.symbol
    WHERE tsp.date = (SELECT MAX(date) FROM trendlyne_stock_profile tsp2 WHERE tsp2.symbol = tsp.symbol)
      AND (cp.last_updated IS NULL OR cp.last_updated < ?)
      AND EXISTS (
        SELECT 1 FROM trendlyne_stock_profile tsp3
        WHERE tsp3.symbol = tsp.symbol AND tsp3.company_description IS NOT NULL
      )
    ORDER BY CASE WHEN cp.last_updated IS NULL THEN 0 ELSE 1 END,
             cp.last_updated ASC, tsp.symbol ASC
    LIMIT ?
  `, [reanalysisCutoff, dailyLimit]);

  console.log(`[PROFILE SYNC] Shard ${shardIndex}/${SHARD_COUNT}. Found ${stocks.length} stocks due for (re-)analysis.`);

  let successCount = 0;
  let failCount = 0;

  for (let i = 0; i < stocks.length; i++) {
    const stock = stocks[i];

    if (!stock.company_description) {
      console.warn(`[PROFILE SYNC] No source description for ${stock.symbol}; leaving it pending.`);
      continue;
    }

    try {
      console.log(`[PROFILE SYNC] (${i + 1}/${stocks.length}) Analyzing ${stock.symbol}...`);
      const analysis = await analyzeCompanyProfile(stock.symbol, stock.company_description);

      if (analysis.error) {
        // Never turn provider failure into a factual zero-growth classification or advance
        // last_updated. That made quota outages look like successful fresh analysis and kept the
        // affected stock out of later retries for seven days.
        console.warn(`[PROFILE SYNC] AI analysis unavailable for ${stock.symbol}; preserving prior profile.`);
        failCount++;
        // A per-day quota reset applies to every remaining symbol, so fail the job honestly
        // after the first response instead of spending minutes issuing hundreds of doomed calls.
        if (analysis.error === 'QUOTA_EXCEEDED' || analysis.error === 'PROVIDER_UNAVAILABLE') break;
        continue;
      }

      await dbRun(`
        INSERT INTO company_profiles (
          symbol, company_name, description, high_growth_scope,
          in_news_for_growth, growth_score, ai_analysis, last_updated
        ) VALUES (
          ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP
        )
        ON CONFLICT(symbol) DO UPDATE SET
          company_name = excluded.company_name,
          description = excluded.description,
          high_growth_scope = excluded.high_growth_scope,
          in_news_for_growth = excluded.in_news_for_growth,
          growth_score = excluded.growth_score,
          ai_analysis = excluded.ai_analysis,
          last_updated = CURRENT_TIMESTAMP
      `, [
        stock.symbol,
        stock.name,
        stock.company_description,
        analysis.high_growth_scope ? 1 : 0,
        analysis.in_news_for_growth ? 1 : 0,
        analysis.growth_score || 0,
        analysis.reasoning || ''
      ]);

      successCount++;
    } catch (err: any) {
      console.error(`[PROFILE SYNC] Error processing ${stock.symbol}:`, err.message);
      failCount++;
    }
  }

  console.log(`[PROFILE SYNC] Completed. Success: ${successCount}, Failed: ${failCount}`);
  return profileSyncVerdict(successCount, failCount);
}
