import { dbRun, dbTransaction } from './dbAsync';
import { fetchLiveMarketScreener } from './marketIntelService';
import { telegramService } from './telegramService';

export const LIVE_SCREENER_FILTERS = [
  "todayNR7",
  "yesterdayNR7",
  "todayGapUP",
  "todayGapDown",
  "yesterdayGapUP",
  "yesterdayGapDown",
  "todayStockOpenHigh",
  "todayStockOpenLow",
  "weeklyStockOpenHigh",
  "weeklyStockOpenLow",
  "orb5minHigh",
  "orb5minLow",
  "range52WeekHigh",
  "range52WeekLow",
  "higherHighHigherLow",
  "lowerHighLowerLow",
  "insideDay",
  "outsideDay",
  "todayAbove20SMA",
  "todayBelow20SMA",
  "todayAbove50SMA",
  "todayBelow50SMA",
  "todayAbove200SMA",
  "todayBelow200SMA",
  "stockPEBelow5",
  "stockPE10To20",
  "stockPE50To100",
  "stockPE5To10",
  "stockPE20To50",
  "stockPEAbove100",
  "dividendYield0To1",
  "dividendYield2To5",
  "dividendYield1To2",
  "dividendYieldAbove5",
  "roceBelow5",
  "roce10To20",
  "roce50To70",
  "roce5To10",
  "roce20To50",
  "roce70To100",
  "roeBelow0",
  "roe10To20",
  "roeAbove50",
  "roe0To10",
  "roe20To50"
];

export async function runLiveScreenerCollection() {
  const timestamp = new Date().toISOString();
  console.log(`[LIVE-SCREENER-COLLECTOR] Starting run at ${timestamp}`);

  let runResult;
  try {
    runResult = await dbRun(
      `INSERT INTO live_screener_runs (timestamp, filters_completed, total_filters, status, error_log)
       VALUES (?, ?, ?, ?, ?) RETURNING id`,
      [timestamp, 0, LIVE_SCREENER_FILTERS.length, 'RUNNING', '']
    );
  } catch (err: any) {
    console.error('[LIVE-SCREENER-COLLECTOR] Failed to insert run record:', err.message);
    return;
  }

  const runId = runResult.lastInsertRowid;
  let completed = 0;
  const errors: string[] = [];

  for (const filter of LIVE_SCREENER_FILTERS) {
    try {
      // 2000ms delay to be polite to NiftyTrader Cloudflare API limits
      await new Promise((resolve) => setTimeout(resolve, 2000));

      const payload = { [filter]: true };
      const res = await fetchLiveMarketScreener(payload);

      if (res.result !== 1) {
        throw new Error(res.resultMessage || 'API returned result code != 1');
      }

      const records = res.resultData || [];
      if (records.length > 0) {
        await dbTransaction(async (tx) => {
          for (const item of records) {
            const symbol = item.symbol_name;
            const price = item.last_trade_price || 0;
            const changePer = item.change_per || 0;
            const volume = item.volume || 0;

            if (symbol) {
              await tx.run(
                `INSERT INTO live_screener_appearances (run_id, symbol, filter_key, price, change_per, volume)
                 VALUES (?, ?, ?, ?, ?, ?)`,
                [runId, symbol, filter, price, changePer, volume]
              );
            }
          }
        });
      }

      completed++;
      console.log(`[LIVE-SCREENER-COLLECTOR] Filter ${filter} completed: ${records.length} stocks matched`);
    } catch (err: any) {
      const errMsg = `Filter ${filter} failed: ${err.message}`;
      console.error(`[LIVE-SCREENER-COLLECTOR] ${errMsg}`);
      errors.push(errMsg);

      if (err.message.includes('401') || err.message.includes('Unauthorized')) {
        const teleMsg = `⚠️ *CRITICAL: Live Screener Collection Halted*\n\nNiftyTrader auth token is expired or unauthorized (401). Please update the token in settings.`;
        await telegramService.sendMarkdownMessage(teleMsg);
        break;
      }
    }
  }

  const status = completed === LIVE_SCREENER_FILTERS.length ? 'SUCCESS' : (completed > 0 ? 'PARTIAL' : 'FAILED');
  const errorLog = errors.join('\n');

  try {
    await dbRun(
      `UPDATE live_screener_runs
       SET filters_completed = ?, status = ?, error_log = ?
       WHERE id = ?`,
      [completed, status, errorLog, runId]
    );
    console.log(`[LIVE-SCREENER-COLLECTOR] Run ${runId} completed with status: ${status} (${completed}/${LIVE_SCREENER_FILTERS.length} completed)`);
  } catch (err: any) {
    console.error(`[LIVE-SCREENER-COLLECTOR] Failed to update run status for id ${runId}:`, err.message);
  }

  // Every filter failing is not a "completed" run — throw so the BullMQ worker/setInterval
  // fallback mark this job FAILED and the job_heartbeat dashboard reflects reality instead of
  // silently reporting 'success' while the collector produced zero data (see live_screener_runs
  // status history: this went undetected for 4 days behind a green heartbeat, 2026-07-21).
  if (status === 'FAILED') {
    throw new Error(`Live screener collection produced 0/${LIVE_SCREENER_FILTERS.length} filters. Last error: ${errors[errors.length - 1] || 'unknown'}`);
  }
}
