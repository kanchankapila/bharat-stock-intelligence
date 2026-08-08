/**
 * Miscellaneous sync jobs (screener-performance, company-profiles-sync, tickertape-scorecard,
 * nse-sync), migrated out of queues.ts's initQueues() across the fourth and fifth slices of the
 * queues.ts decomposition (see CLAUDE.md architecture review, Phase 3 — earlier slices:
 * screeners.jobs.ts, agents.jobs.ts, operations.jobs.ts).
 *
 * screener-performance/company-profiles-sync/tickertape-scorecard use updateMonitorState()
 * (monitoringService.ts, MONITOR_SCRIPTS-driven DB-freshness checks) rather than
 * recordHeartbeat() (jobHeartbeat.ts, JOB_REGISTRY-driven lateness checks) — a genuinely
 * different mechanism, which is what motivated adding registerRepeatableJob()'s configurable
 * monitorFn rather than hardcoding recordHeartbeat. nse-sync uses the default recordHeartbeat.
 *
 * Queue/worker instances are still exported from queues.ts under their original names
 * (screenerPerfQueue, companyProfilesSyncQueue, tickertapeScorecardQueue,
 * nseScreenerSyncQueue) — this module only owns the registration logic.
 */
import { Job } from 'bullmq';
import { runPython } from '../pythonRunner';
import { updateMonitorState } from '../monitoringService';
import { registerRepeatableJob } from './registerJob';
import { shouldSkipOnTradingHoliday } from '../marketStatusService';

export const QUEUE_SCREENER_PERFORMANCE = 'screener-performance';
export const QUEUE_COMPANY_PROFILES_SYNC = 'company-profiles-sync';
export const QUEUE_TICKERTAPE_SCORECARD = 'tickertape-scorecard';
export const QUEUE_NSE_SYNC = 'nse-sync';

async function processScreenerPerf(job: Job): Promise<void> {
  // 2026-08-07: skip entirely on a trading holiday -- every phase here (discovery/enrichment,
  // Bayesian tier scoring, PIT snapshot, live-screener train/backtest) re-derives from
  // screener_appearances/signal_outcomes/stock_ohlcv, none of which gained a new row on a day
  // the exchange never opened. Same reasoning as processStockScoring/processQuantScoring.
  if (await shouldSkipOnTradingHoliday(job)) {
    console.log('[QUEUE] screener-performance skipped — trading holiday, nothing new to re-derive');
    return;
  }
  // 1. Sync newly discovered Trendlyne screener PKs. "known" mode only re-fetches PKs
  // missing from the DB, but with ~612 known PKs and a 0.4s rate limit that can still
  // run 20+ minutes in practice — the old 10-min timeout routinely SIGTERM'd it mid-run
  // (execFile kills before any stderr flushes, logged as an opaque "Command failed").
  await runPython('trendlyne_screener_discovery.py', [], 30 * 60_000)
    .catch(e => console.warn('[QUEUE] trendlyne_screener_discovery failed:', (e as Error).message));

  // 2. Bulk-enrich signal_keywords + screener_url; INSERT 858 missing catalog entries; fix sector_theme bias
  await runPython('screener_catalog_enricher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_catalog_enricher failed:', (e as Error).message));

  // 2b. Backfill OHLCV for any symbols that appeared in screeners but are missing from stock_ohlcv
  await runPython('screener_ohlcv_backfill.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_ohlcv_backfill failed:', (e as Error).message));

  // 3. Compute performance metrics for all screeners (K_PRIOR adaptive; phase_e updates confidence)
  // 45 min: the run includes per-screener Ollama classification calls and routinely
  // outlives the old 15-min budget now that screener_appearances has months of history
  // (12 of its last 14 runs were timeout-killed with an empty "Command failed").
  await runPython('screener_performance.py', [], 45 * 60_000);

  // 4. Stamp per-stock screener ML features into technical_signals
  await runPython('screener_features_fetcher.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_features_fetcher failed:', (e as Error).message));

  // 5. Aggregate sector screener rotation signals
  await runPython('screener_sector_rotation.py', [], 2 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_sector_rotation failed:', (e as Error).message));

  // 6. Generate screener surfacing alerts → unified_signals
  await runPython('screener_signal_generator.py', [], 3 * 60_000)
    .catch(e => console.warn('[QUEUE] screener_signal_generator failed:', (e as Error).message));

  // 7. Resolve live screener outcomes (needs ohlcv data to be fresh first)
  await runPython('live_screener_resolver.py', [], 20 * 60_000)
    .catch(e => console.warn('[QUEUE] live_screener_resolver failed:', (e as Error).message));

  // 8. Recompute optimal filter combinations using the latest resolved outcomes. Trains both
  // the swing-horizon model and an isolated same-day intraday model in one run (see
  // live_screener_optimizer.py's optimize_combinations()).
  await runPython('live_screener_optimizer.py', [], 5 * 60_000)
    .catch(e => console.warn('[QUEUE] live_screener_optimizer failed:', (e as Error).message));

  // 8b. Retrain the ML win-probability classifier on the same freshly-resolved outcomes.
  // Gated behind a held-out-AUC promotion check inside the script itself, so a worse
  // retrain never silently replaces a better live model.
  await runPython('live_screener_ml_ranker.py', ['--train'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] live_screener_ml_ranker --train failed:', (e as Error).message));

  // 9. Auto-backtest top combinations so frontend cockpit always has fresh performance data
  await runPython('backtest_live_screener.py', ['--auto-backtest-top', '5'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] backtest_live_screener auto-backtest failed:', (e as Error).message));
  await runPython('backtest_live_screener.py', ['--auto-backtest-top', '5', '--intraday'], 10 * 60_000)
    .catch(e => console.warn('[QUEUE] backtest_live_screener intraday auto-backtest failed:', (e as Error).message));

  try {
    const { classifyAllScreeners } = await import('../screenerClassifier');
    await classifyAllScreeners();
  } catch (e: unknown) {
    console.error('[QUEUE] screener classification failed:', (e as Error).message);
  }
}

async function processCompanyProfilesSync(_job: Job): Promise<void> {
  const { syncAndAnalyzeCompanyProfiles } = await import('../companyProfileSyncService');
  await syncAndAnalyzeCompanyProfiles();
}

async function processTickertapeScorecard(_job: Job): Promise<{ success: boolean }> {
  await runPython('tickertape_scorecard_fetcher.py', [], 60 * 60_000)
    .catch(e => console.warn('[QUEUE] tickertape_scorecard_fetcher failed:', (e as Error).message));
  return { success: true };
}

async function processNSESync(_job: Job): Promise<{ success: boolean; stockCount: number }> {
  console.log('[QUEUE] Starting NSE master data sync...');
  try {
    const { syncNSEStocksToDatabase } = await import('../nseService');
    const result = await syncNSEStocksToDatabase();
    const stockCount = (result?.inserted || 0) + (result?.updated || 0);
    console.log(`[QUEUE] NSE sync completed, ${stockCount} stocks updated`);
    // Real sector/industry source (2026-08-05): backfill_sectors.py alone was a structural
    // no-op for ~95% of the universe -- its only source, confluence_signals.sector, is itself
    // populated from nse_stocks.sector (see confluenceEngine.ts's nseMap), so it can never
    // create a classification that didn't already exist in nse_stocks. Live production showed
    // 2,216/2,366 ACTIVE symbols stuck at sector='Unknown' despite this step running weekly for
    // as long as nse-sync-weekly has existed. backfill_sector_mc.py hits MoneyControl's
    // pricefeed (an independent, non-circular source, ~98% coverage) and is the one that
    // actually creates new classifications; measured ~9-10 min live against the full universe
    // (2328 mcsymbol-bearing stocks @ ~0.25s/req), hence the generous 900s budget below and the
    // lockDuration bump on this job. Runs BEFORE backfill_sectors.py so that step's propagation
    // into recommendation_log/unified_signals/signals picks up the freshest sector data, not a
    // stale/absent one. --enumerate re-fetches every mcsymbol-bearing stock each run (no
    // incremental mode in the script) -- acceptable at this job's weekly cadence, since sector
    // classification changes rarely and a full weekly refresh also self-heals any transient
    // per-symbol MC miss from the prior run.
    await runPython('backfill_sector_mc.py', ['--enumerate', '--write', '--report-unmapped'], 900_000)
      .catch(err => console.warn('[QUEUE] MC sector backfill failed (non-blocking):', (err as Error).message));
    // Backfill canonical nse_stocks.sector from already-resolved confluence data, then
    // propagate to historical signal tables. Keeps sector segmentation healthy over time.
    await runPython('backfill_sectors.py', [], 120_000)
      .catch(err => console.warn('[QUEUE] sector backfill failed (non-blocking):', (err as Error).message));
    // Provider-mapping backfill (2026-08-05): mcsymbol/tlid resolution -- npm run sync:mappings
    // was manual-only (a package.json script, never scheduled), so newly-added nse_stocks rows
    // (this same job's syncNSEStocksToDatabase() call, above, can insert brand-new symbols)
    // silently accumulated with no provider mapping forever. Live production had 544/2366
    // ACTIVE symbols missing mcsymbol or tlid before this was first run by hand. Imported
    // rather than shelled out to, matching how syncNSEStocksToDatabase itself is called above.
    try {
      const { syncMappings } = await import('../../../scripts/syncAllStockMappings');
      const mapResult = await syncMappings();
      console.log(`[QUEUE] stock-mapping sync completed (updated ${mapResult.updatedCount}, `
        + `skipped ${mapResult.skippedCount}, failed ${mapResult.failedCount})`);
    } catch (err) {
      console.warn('[QUEUE] stock-mapping sync failed (non-blocking):', (err as Error).message);
    }
    // Index membership flags (Nifty50/100/200/Midcap150/Smallcap250) — passive ETF flow signal.
    await runPython('index_membership_fetcher.py', [], 60_000)
      .catch(err => console.warn('[QUEUE] index_membership_fetcher failed (non-blocking):', (err as Error).message));
    // nse_stocks.market_cap/pe_ratio/dividend_yield fallback backfill (2026-08-07, dead-column
    // sweep) — see backfillNseStocksFundamentalsFallback()'s own doc comment in nseService.ts.
    // Pure DB-to-DB copy, no external call, so it costs nothing to run every week alongside the
    // sector backfills above.
    try {
      const { backfillNseStocksFundamentalsFallback } = await import('../nseService');
      const { updated } = await backfillNseStocksFundamentalsFallback();
      console.log(`[QUEUE] nse_stocks fundamentals-fallback backfill: ${updated} rows updated`);
    } catch (err: any) {
      console.warn('[QUEUE] nse_stocks fundamentals-fallback backfill failed (non-blocking):', err.message);
    }
    return { success: true, stockCount };
  } catch (err: any) {
    console.error('[QUEUE] NSE sync failed:', err.message);
    throw err;
  }
}

export async function registerSyncJobs(connection: any) {
  const screenerPerf = await registerRepeatableJob({
    connection,
    queueName: QUEUE_SCREENER_PERFORMANCE,
    jobName: 'screener-performance-daily',
    // 2:00 AM IST (20:30 UTC), Tue-Sat -- i.e. after each weekday's ml-daily-ops chain
    // finishes (~12:00 AM) and well before unified-ranker (7:30 AM), in an otherwise
    // empty window. This job runs 10 sequential Python steps (~145 min of budget), so it
    // needs one; at its old slot it collided with the EOD cluster.
    //
    // Was `every: 24h`, which is NOT a wall-clock schedule -- it fires 24h after the last
    // run, so the time DRIFTS on every restart. Deliberately NOT moved ahead of
    // ml-daily-ops: it writes screener_performance_history, which
    // screener_features_fetcher.py reads AS-OF -- a lagged snapshot is the correct
    // point-in-time input there, and making it same-day would reintroduce look-ahead.
    //
    // 21:00 UTC (not 20:30) so it clears ohlcv-gap-fill-weekly, which fires Fri 20:30 UTC
    // = Sat 2:00 AM IST -- the one day-of-week where these two would otherwise collide.
    repeat: { pattern: '0 21 * * 1-5' },
    jobId: 'screener-performance-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processScreenerPerf,
    monitorName: 'screener-performance',
    concurrency: 1,
    // processScreenerPerf runs 10 sequential runPython steps (30+5+20+45+5+2+3+20+5+10 =
    // 145 min of individual timeouts) plus an in-process classifyAllScreeners() -- the
    // previous 20-min lockDuration was only enough for step 1 alone, so BullMQ correctly
    // considered the worker dead partway through step 3-4 on every run, moving the job
    // back to "wait" and eventually failing it with "stalled more than allowable limit"
    // regardless of whether the Python side would have actually succeeded.
    lockDuration: 180 * 60_000,
    lockRenewTime: 20 * 60_000,
    monitorFn: updateMonitorState,
    suppressLockErrors: true,
  });

  const companyProfilesSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_COMPANY_PROFILES_SYNC,
    jobName: 'sync-company-profiles',
    // Was weekly (single run covering the full NSE-master-list universe) -- but the underlying
    // scrape takes ~3.6h while runPython caps it at 70 min, so the weekly run NEVER completed
    // (7/7 failures, last_success_at always null). syncAndAnalyzeCompanyProfiles() now shards
    // the universe into 1/7ths internally and picks a shard by day-of-year, so daily runs each
    // cover a fast (~30 min) slice and full coverage completes every 7 days -- same cadence as
    // before, but each individual run actually fits its budget and can succeed.
    //
    // Kept running all 7 days (not Mon-Fri) deliberately -- the day-of-year sharding needs one
    // run per CALENDAR day to complete full coverage every 7 days; restricting to weekdays would
    // stretch that to ~9-10 calendar days. Moved from 4:00 UTC (9:30 IST, mid-market-hours -- the
    // one daily sync in this file that wasn't off-hours) to 15:30 UTC (21:00 IST, well after the
    // 15:30 IST close and clear of the 22:00-23:35 IST EOD job cluster) -- found in the 2026-07-30
    // fifth full-stack-audit pass.
    repeat: { pattern: '30 15 * * *' }, // Daily (all 7 days), 15:30 UTC = 21:00 IST
    jobId: 'company-profiles-sync-daily',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processCompanyProfilesSync,
    monitorName: 'company-profiles-sync',
    concurrency: 1,
    // Each shard's runPython call is bounded at 70 min (comfortably covers a ~30-min
    // 1/7-universe slice); lockDuration keeps headroom above that single call.
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 15 * 60 * 1000,
    stalledInterval: 15 * 60 * 1000,
    maxStalledCount: 3,
    monitorFn: updateMonitorState,
  });

  const tickertapeScorecard = await registerRepeatableJob({
    connection,
    queueName: QUEUE_TICKERTAPE_SCORECARD,
    jobName: 'tickertape-scorecard-weekly',
    repeat: { pattern: '0 13 * * 6' }, // Saturday 1:00 PM UTC
    jobId: 'tickertape-scorecard-weekly',
    removeOnComplete: 3,
    removeOnFail: 3,
    processor: processTickertapeScorecard,
    monitorName: 'tickertape-scorecard',
    concurrency: 1,
    lockDuration: 90 * 60 * 1000,
    lockRenewTime: 10 * 60 * 1000,
    monitorFn: updateMonitorState,
  });

  const nseSync = await registerRepeatableJob({
    connection,
    queueName: QUEUE_NSE_SYNC,
    jobName: 'nse-sync-weekly',
    // Weekly on Sunday at 2 AM UTC (7:30 AM IST) for low load time.
    repeat: { pattern: '0 2 * * 0' },
    jobId: 'nse-sync-weekly-repeatable',
    removeOnComplete: { age: 86400 },   // Keep for 1 day
    removeOnFail: { age: 604800 },      // Keep failures for 7 days
    attempts: 2,
    backoff: { type: 'exponential', delay: 5000 },
    processor: processNSESync,
    monitorName: 'nse-sync',
    concurrency: 1,
    // Was 180000 (3 min, NSE API calls only) -- bumped 2026-08-05 to cover the new
    // backfill_sector_mc.py step (measured ~9-10 min live enumerate against the full
    // mcsymbol-bearing universe) plus backfill_sectors.py (120s) and
    // index_membership_fetcher.py (60s), with real margin above the sum.
    lockDuration: 20 * 60_000,
    lockRenewTime: 5 * 60_000,
    // Preserves the original handler's extra `(${stockCount} stocks)` detail in the completed
    // log line (the standard helper logs a plain '... completed' line above it).
    onCompleted: (result: any) => console.log(`[QUEUE] nse-sync completed (${result?.stockCount || 0} stocks)`),
  });

  return { screenerPerf, companyProfilesSync, tickertapeScorecard, nseSync };
}
