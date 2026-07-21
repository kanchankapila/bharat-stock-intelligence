import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { router, publicProcedure } from "../trpc";
import { runPython } from '../pythonRunner';
import { fetchIndexAdvanceDecline, fetchIndiaVix, fetchLiveMarketScreener, fetchEODMarketScreener } from '../marketIntelService';
import * as queueModule from '../queues';
import { MONITOR_SCRIPTS } from '../monitorScripts';
import { computeCronLateness } from '../jobHeartbeat';

export { MONITOR_SCRIPTS };

type ScriptId = typeof MONITOR_SCRIPTS[number]['id'];

async function getLastRunAt(scriptId: ScriptId): Promise<string | null> {
  try {
    let row: any;
    switch (scriptId) {
      case 'technical-scan':
        row = await dbGet("SELECT MAX(computed_at) as t FROM technical_signals");
        break;
      case 'outcome-resolver-5d':
        // computed_at is stamped on every upsert regardless of outcome (see outcome_resolver.py's
        // ON CONFLICT ... computed_at=excluded.computed_at), so filtering out PENDING rows here
        // under-counted freshness: on a day where every eligible signal at this horizon is still
        // within its holding period, the resolver runs fine but touches only PENDING rows, and
        // this query kept reporting the last *resolved* outcome (which can be days older) as "last
        // run" — false-flagging the job stale even though it executed on schedule.
        row = await dbGet("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=5");
        break;
      case 'outcome-resolver-15d':
        row = await dbGet("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=15");
        break;
      case 'performance-tracker':
        row = await dbGet("SELECT MAX(last_computed) as t FROM strategy_performance");
        break;
      case 'fii-dii-fetcher':
        row = await dbGet("SELECT MAX(fetched_at) as t FROM fii_dii_flow");
        break;
      case 'finbert-scorer':
        row = await dbGet("SELECT MAX(computed_at) as t FROM technical_signals WHERE news_sentiment_score IS NOT NULL");
        break;
      case 'ml-ensemble-score':
        row = await dbGet("SELECT MAX(computed_at) as t FROM technical_signals WHERE win_probability IS NOT NULL");
        break;
      case 'ml-ensemble-train':
        row = await dbGet("SELECT MAX(trained_at) as t FROM model_registry WHERE model_name='ensemble'");
        break;
      case 'strategy-optimizer':
        row = await dbGet("SELECT MAX(snapshot_at) as t FROM screener_weight_history");
        break;
      case 'ohlcv-backfill':
        row = await dbGet("SELECT MAX(date) as t FROM stock_ohlcv");
        break;
      case 'regime-detector':
        row = await dbGet("SELECT MAX(computed_at) as t FROM market_regimes");
        break;
      case 'feature-engineering':
        row = await dbGet("SELECT MAX(computed_at) as t FROM feature_store");
        break;
      case 'reward-engine':
        row = await dbGet("SELECT MAX(last_updated) as t FROM signal_type_weights");
        break;
      case 'rl-agent-update':
        row = await dbGet("SELECT MAX(last_updated) as t FROM rl_q_table");
        break;
      case 'dl-engine-infer':
        row = await dbGet("SELECT MAX(created_at) as t FROM deep_learning_predictions");
        break;
      case 'dl-trainer':
        row = await dbGet("SELECT MAX(trained_at) as t FROM model_registry WHERE model_name='BiLSTM'");
        break;
      case 'signal-type-stats':
        row = await dbGet("SELECT MAX(last_computed) as t FROM signal_type_stats");
        break;
      case 'screener-performance':
        row = await dbGet("SELECT MAX(last_computed) as t FROM screener_performance_v2");
        break;
      case 'company-profiles-sync':
        row = await dbGet("SELECT MAX(last_updated) as t FROM company_profiles");
        break;
      case 'trendlyne-fundamentals':
        row = await dbGet("SELECT MAX(date) as t FROM trendlyne_dvm_scores");
        break;
      case 'trendlyne-midweek':
        row = await dbGet(`
          SELECT MIN(t) as t FROM (
            SELECT MAX(date) as t FROM trendlyne_adv_tech_daily
            UNION ALL
            SELECT MAX(date) as t FROM trendlyne_price_analysis
          ) combined
        `);
        break;
      case 'financial-ratios':
        row = await dbGet("SELECT MAX(as_of_date) as t FROM tl_financial_quality");
        break;
      case 'working-capital':
        row = await dbGet("SELECT MAX(fetched_at) as t FROM working_capital_history");
        break;
      case 'tickertape-scorecard':
        row = await dbGet("SELECT MAX(date) as t FROM proprietary_scores_history WHERE source = 'tickertape'");
        break;
      case 'intraday-breadth-capture':
        row = await dbGet("SELECT MAX(snapshot_at) as t FROM intraday_breadth_snapshots");
        break;
      default:
        return null;
    }
    return (row as any)?.t ?? null;
  } catch (err: unknown) {
    console.warn('[MONITOR] getLastRunAt failed:', (err as Error).message);
    return null;
  }
}

async function getScriptStats(scriptId: ScriptId): Promise<Record<string, number | string | null>> {
  try {
    switch (scriptId) {
      case 'technical-scan':
        return { total: ((await dbGet("SELECT COUNT(*) as n FROM technical_signals")) as any)?.n ?? 0 };
      case 'outcome-resolver-5d':
        return { resolved: ((await dbGet("SELECT COUNT(*) as n FROM signal_outcomes WHERE horizon_days=5 AND outcome!='PENDING'")) as any)?.n ?? 0 };
      case 'outcome-resolver-15d':
        return { resolved: ((await dbGet("SELECT COUNT(*) as n FROM signal_outcomes WHERE horizon_days=15 AND outcome!='PENDING'")) as any)?.n ?? 0 };
      case 'performance-tracker':
        return {
          strategies: ((await dbGet("SELECT COUNT(*) as n FROM strategy_performance")) as any)?.n ?? 0,
          withAlpha: ((await dbGet("SELECT COUNT(*) as n FROM strategy_performance WHERE alpha_vs_nifty IS NOT NULL")) as any)?.n ?? 0,
        };
      case 'fii-dii-fetcher':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM fii_dii_flow WHERE fii_net IS NOT NULL")) as any)?.n ?? 0 };
      case 'finbert-scorer': {
        const total = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals")) as any)?.n ?? 1;
        const scored = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals WHERE news_sentiment_score IS NOT NULL")) as any)?.n ?? 0;
        return { coverage: Math.round(scored / total * 100) + '%' };
      }
      case 'ml-ensemble-score': {
        // Was an all-time coverage ratio over the whole table -- diluted a severe recent
        // regression into a decent-looking historical average (a 3-week collapse to ~1-3%/day
        // coverage, caused by score-pending's now-fixed signals_json filter silently excluding
        // full-universe grid rows, still read as ~85%+ "coverage" here because most of the
        // table predates the regression). Window to the last 7 days so a live collapse is
        // immediately visible instead of averaged away. Found + fixed 2026-07-18.
        const cutoff = new Date(Date.now() - 7 * 864e5).toISOString().slice(0, 10);
        const t2 = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals WHERE date >= ?", [cutoff])) as any)?.n ?? 1;
        const s2 = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals WHERE win_probability IS NOT NULL AND date >= ?", [cutoff])) as any)?.n ?? 0;
        return { coverage: Math.round(s2 / (t2 || 1) * 100) + '%' };
      }
      case 'ml-ensemble-train': {
        const m = await dbGet("SELECT cv_roc_auc, training_samples FROM model_registry WHERE model_name='ensemble' ORDER BY trained_at DESC LIMIT 1") as any;
        return m ? { auc: m.cv_roc_auc?.toFixed(4) ?? 'N/A', samples: m.training_samples } : {};
      }
      case 'strategy-optimizer': {
        const w = await dbGet("SELECT optimized_win_rate, improvement_pct FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT 1") as any;
        return w ? { winRate: (w.optimized_win_rate * 100).toFixed(1) + '%', improvement: w.improvement_pct?.toFixed(2) + '%' } : {};
      }
      case 'ohlcv-backfill':
        return {
          symbols: ((await dbGet("SELECT COUNT(DISTINCT symbol) as n FROM stock_ohlcv")) as any)?.n ?? 0,
          rows: ((await dbGet("SELECT COUNT(*) as n FROM stock_ohlcv")) as any)?.n ?? 0,
        };
      case 'regime-detector': {
        const r = await dbGet("SELECT regime, COUNT(*) as n FROM market_regimes GROUP BY regime ORDER BY n DESC LIMIT 1") as any;
        const total = ((await dbGet("SELECT COUNT(*) as n FROM market_regimes")) as any)?.n ?? 0;
        return r ? { days: total, latest: r.regime } : { days: 0 };
      }
      case 'feature-engineering': {
        const sRow = await dbGet("SELECT COUNT(DISTINCT symbol) as n FROM feature_store") as any;
        const rRow = await dbGet("SELECT COUNT(*) as n FROM feature_store") as any;
        return {
          symbols: sRow?.n ?? 0,
          rows: rRow?.n ?? 0,
        };
      }
      case 'reward-engine':
        return { types: ((await dbGet("SELECT COUNT(*) as n FROM signal_type_weights")) as any)?.n ?? 0 };
      case 'rl-agent-update':
        return {
          states: ((await dbGet("SELECT COUNT(DISTINCT state_key) as n FROM rl_q_table")) as any)?.n ?? 0,
          entries: ((await dbGet("SELECT COUNT(*) as n FROM rl_q_table")) as any)?.n ?? 0,
        };
      case 'dl-engine-infer':
        return {
          symbols: ((await dbGet("SELECT COUNT(DISTINCT symbol) as n FROM deep_learning_predictions")) as any)?.n ?? 0,
          today: ((await dbGet("SELECT COUNT(*) as n FROM deep_learning_predictions WHERE date(created_at)=date('now')")) as any)?.n ?? 0,
        };
      case 'dl-trainer': {
        const m = await dbGet("SELECT cv_roc_auc, is_active FROM model_registry WHERE model_name='BiLSTM' ORDER BY trained_at DESC LIMIT 1") as any;
        return m ? { auc: m.cv_roc_auc?.toFixed(4) ?? 'N/A', active: m.is_active ? 'yes' : 'no' } : {};
      }
      case 'signal-type-stats':
        return {
          types: ((await dbGet("SELECT COUNT(DISTINCT signal_type) as n FROM signal_type_stats")) as any)?.n ?? 0,
          rows: ((await dbGet("SELECT COUNT(*) as n FROM signal_type_stats")) as any)?.n ?? 0,
        };
      case 'screener-performance': {
        const total = ((await dbGet("SELECT COUNT(*) as n FROM screener_performance_v2")) as any)?.n ?? 0;
        const tiers = await dbAll("SELECT tier, COUNT(*) as n FROM screener_performance_v2 GROUP BY tier ORDER BY tier") as any[];
        const tierStr = tiers.map((t: any) => `${t.tier}:${t.n}`).join(', ');
        return { screeners: total, tiers: tierStr };
      }
      case 'company-profiles-sync':
        return {
          profiles: ((await dbGet("SELECT COUNT(*) as n FROM company_profiles")) as any)?.n ?? 0,
          aiAnalyzed: ((await dbGet("SELECT COUNT(*) as n FROM company_profiles WHERE ai_analysis IS NOT NULL AND ai_analysis != ''")) as any)?.n ?? 0,
        };
      case 'trendlyne-fundamentals':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM trendlyne_dvm_scores WHERE date = (SELECT MAX(date) FROM trendlyne_dvm_scores)")) as any)?.n ?? 0 };
      case 'trendlyne-midweek':
        return {
          advTechRows: ((await dbGet("SELECT COUNT(*) as n FROM trendlyne_adv_tech_daily WHERE date = (SELECT MAX(date) FROM trendlyne_adv_tech_daily)")) as any)?.n ?? 0,
          priceAnalysisRows: ((await dbGet("SELECT COUNT(*) as n FROM trendlyne_price_analysis WHERE date = (SELECT MAX(date) FROM trendlyne_price_analysis)")) as any)?.n ?? 0,
        };
      case 'financial-ratios':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM tl_financial_quality WHERE as_of_date = (SELECT MAX(as_of_date) FROM tl_financial_quality)")) as any)?.n ?? 0 };
      case 'working-capital':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM working_capital_history WHERE fiscal_year = (SELECT MAX(fiscal_year) FROM working_capital_history)")) as any)?.n ?? 0 };
      case 'tickertape-scorecard':
        return { rows: ((await dbGet("SELECT COUNT(*) as n FROM proprietary_scores_history WHERE source = 'tickertape' AND date = (SELECT MAX(date) FROM proprietary_scores_history WHERE source = 'tickertape')")) as any)?.n ?? 0 };
      case 'intraday-breadth-capture':
        return { snapshotsToday: ((await dbGet("SELECT COUNT(*) as n FROM intraday_breadth_snapshots WHERE date = CURRENT_DATE::text")) as any)?.n ?? 0 };
      default:
        return {};
    }
  } catch (err: unknown) {
    console.warn('[MONITOR] getScriptStats failed:', (err as Error).message);
    return {};
  }
}

export async function getSystemStatus(now: Date = new Date()) {
  const runStates: Record<string, string> = {};
  try {
    const rows = await dbAll<any>("SELECT key, value FROM app_settings WHERE key LIKE 'monitor_%'");
    for (const r of rows) runStates[r.key] = r.value;
  } catch (err: unknown) {
    console.warn('[MONITOR] getSystemStatus failed:', (err as Error).message);
  }

  return Promise.all(MONITOR_SCRIPTS.map(async s => {
    const dbLastRunAt = await getLastRunAt(s.id as ScriptId);
    // Fall back to stored timestamp for scripts that ran but produced no DB rows
    const storedRanAt = runStates[`monitor_${s.id}_ran_at`] ?? null;
    const lastRunAt = dbLastRunAt ?? storedRanAt;
    const stateKey = `monitor_${s.id}`;
    const rawState = runStates[stateKey];
    let runState: 'never' | 'running' | 'success' | 'failed' | 'stale' = 'never';

    // Fresh DB-freshness evidence (dbLastRunAt/storedRanAt) wins over the app_settings
    // 'running' flag: scripts driven by a BullMQ worker (e.g. technical-scan) never flip
    // that flag back via triggerScript's upsertState, so a single stray 'running' write
    // (manual trigger, crash mid-run) stuck it forever — masking weeks of otherwise-healthy
    // runs behind a permanent "⏳ running" even though fresh output kept landing.
    if (lastRunAt) {
      const cronPatterns = (s as any).cronPatterns as string[] | undefined;
      let isLate: boolean;
      if (cronPatterns?.length) {
        // Cron-aware: not late until THIS entry's own next expected fire time (plus grace)
        // has actually passed, instead of a flat hours-since-success threshold that trips
        // every time it's checked before a Mon-Fri/weekly job has had its daily/weekly chance
        // to run (e.g. Monday morning off Friday's success, or mid-day before tonight's batch).
        isLate = computeCronLateness(
          cronPatterns,
          (s as any).graceMinutes ?? 60,
          new Date(lastRunAt).getTime(),
          now,
        ).late;
      } else {
        const ageHours = (now.getTime() - new Date(lastRunAt).getTime()) / 3600000;
        isLate = ageHours > s.staleLimitHours;
      }
      runState = !isLate ? 'success' : (rawState === 'running' ? 'running' : (rawState === 'failed' ? 'failed' : 'stale'));
    } else {
      runState = rawState === 'running' ? 'running' : (rawState === 'failed' ? 'failed' : 'never');
    }

    return {
      ...s,
      lastRunAt,
      runState,
      stats: await getScriptStats(s.id as ScriptId),
      error: runStates[`monitor_${s.id}_error`] ?? null,
    };
  }));
}

export const monitorRouter = router({
  getSystemStatus: publicProcedure.query(() => getSystemStatus()),

  getIndexAdvanceDecline: publicProcedure
    .query(async () => {
      return fetchIndexAdvanceDecline();
    }),


  getIndiaVix: publicProcedure
    .query(async () => {
      return fetchIndiaVix();
    }),

  getLiveMarketScreener: publicProcedure
    .input(z.record(z.string(), z.boolean()).optional())
    .query(async ({ input }) => {
      return fetchLiveMarketScreener((input as Record<string, boolean>) || {});
    }),

  getEODMarketScreener: publicProcedure
    .input(z.record(z.string(), z.boolean()).optional())
    .query(async ({ input }) => {
      return fetchEODMarketScreener((input as Record<string, boolean>) || {});
    }),

  triggerScript: publicProcedure
    .input(z.object({ scriptId: z.string() }))
    .mutation(async ({ input }) => {
      const script = MONITOR_SCRIPTS.find(s => s.id === input.scriptId);
      if (!script) throw new Error(`Unknown script: ${input.scriptId}`);

      const stateKey = `monitor_${script.id}`;
      const upsertState = async (val: string) => {
        try {
          await dbRun("INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [stateKey, val]);
          if (val === 'success') {
            await dbRun("INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
              [`${stateKey}_ran_at`, new Date().toISOString()]);
          }
        } catch (err: unknown) {
          console.warn('[MONITOR] upsertState failed:', (err as Error).message);
        }
      };

      await upsertState('running');

      if (!script.pyScript) {
        // TypeScript function trigger (no Python, no queue)
        if ((script as any).tsFunction === 'computeSignalTypeStats') {
          try {
            const { computeSignalTypeStats } = await import('../technicalSignalsService');
            const result = await computeSignalTypeStats();
            await upsertState('success');
            return { queued: false, message: `Signal type stats computed: ${result.updated} rows updated` };
          } catch (e: any) {
            await upsertState('failed');
            return { queued: false, message: `Failed: ${e.message}` };
          }
        }

        // Queue-based trigger
        try {
          const queueModule = await import('../queues');
          const queueMap: Record<string, any> = {
            'technical-signals': queueModule.technicalSignalsQueue,
            'outcome-resolver':  queueModule.outcomeResolverQueue,
            'ml-daily-ops':      queueModule.mlDailyOpsQueue,
            'ml-weekly-retrain': queueModule.mlWeeklyRetrainQueue,
            'ohlcv-backfill':    queueModule.ohlcvBackfillQueue,
            'company-profiles-sync': queueModule.companyProfilesSyncQueue,
          };
          const q = queueMap[script.queueName!];
          if (q) {
            await q.add(`manual-${script.id}`, {}, { removeOnComplete: 3 });
            return { queued: true, message: `Queued ${script.label}` };
          }
        } catch (err: unknown) {
          console.warn('[MONITOR] queue trigger failed:', (err as Error).message);
        }
        await upsertState('success');
        return { queued: false, message: 'Queue unavailable — script is queue-only' };
      }

      void (async () => {
        const [pyFile, ...pyArgs] = script.pyScript!.split(' ');
        try {
          const { stdout } = await runPython(pyFile, pyArgs, 30 * 60_000);
          await upsertState('success');
          await dbRun("DELETE FROM app_settings WHERE key=?", [`${stateKey}_error`]);
          if (stdout) console.log(`[MONITOR] ${script.id} stdout:`, stdout.slice(0, 300));
          console.log(`[MONITOR] ${script.id} done`);
        } catch (err: unknown) {
          const msg = (err as Error).message;
          await upsertState('failed');
          await dbRun("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            [`${stateKey}_error`, msg.slice(0, 500)]);
          console.error(`[MONITOR] ${script.id} failed:`, msg);
          if (script.critical) {
            try {
              const { TelegramNotificationService } = await import('../telegramService');
              await new TelegramNotificationService().sendMarkdownMessage(
                `🚨 *Critical script failed*: \`${script.label}\`\nError: ${msg.slice(0, 300)}`
              );
            } catch { /* telegram optional */ }
          }
        }
      })();

      return { queued: false, running: true, message: `Started ${script.label}` };
    }),

  triggerAllDaily: publicProcedure.mutation(async () => {
    const dailyScripts = ['fii-dii-fetcher', 'regime-detector', 'feature-engineering', 'outcome-resolver-5d', 'outcome-resolver-15d', 'performance-tracker', 'reward-engine', 'rl-agent-update', 'ml-ensemble-score', 'dl-engine-infer', 'signal-type-stats'];
    const upsert = async (key: string, val: string, errorMsg?: string) => {
      try {
        await dbRun("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [key, val]);
        if (val === 'success') {
          await dbRun("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`${key}_ran_at`, new Date().toISOString()]);
          await dbRun("DELETE FROM app_settings WHERE key=?", [`${key}_error`]);
        } else if (val === 'failed' && errorMsg) {
          await dbRun("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value", [`${key}_error`, errorMsg.slice(0, 500)]);
        }
      } catch (err: unknown) {
        console.warn('[MONITOR] upsert failed:', (err as Error).message);
      }
    };

    for (const id of dailyScripts) {
      const s = MONITOR_SCRIPTS.find(x => x.id === id)!;
      if ((s as any).tsFunction === 'computeSignalTypeStats') {
        await upsert(`monitor_${id}`, 'running');
        try {
          const { computeSignalTypeStats } = await import('../technicalSignalsService');
          await computeSignalTypeStats();
          await upsert(`monitor_${id}`, 'success');
        } catch (e: any) { await upsert(`monitor_${id}`, 'failed', e.message); }
        continue;
      }
      if (!s.pyScript) continue;
      await upsert(`monitor_${id}`, 'running');
      const [pyFile, ...pyArgs] = s.pyScript.split(' ');
      runPython(pyFile, pyArgs, 20 * 60_000)
        .then(() => upsert(`monitor_${id}`, 'success'))
        .catch((e: any) => upsert(`monitor_${id}`, 'failed', e.message));
    }
    return { started: dailyScripts.length };
  }),

  getBullMQJobsStatus: publicProcedure.query(async () => {
    const queueList = [
      { id: 'stock-refresh', q: queueModule.stockRefreshQueue, label: 'Stock Price Refresh', desc: 'Refreshes live NSE stock quotes (5-min intervals during market hours)', category: 'data-sync' },
      { id: 'ai-signals', q: queueModule.aiSignalsQueue, label: 'AI Signal Analyzer', desc: 'Runs LLM stock scans and actionability gates', category: 'machine-learning' },
      { id: 'stock-scoring', q: queueModule.stockScoringQueue, label: 'Stock Scoring Sync', desc: 'Aggregates screeners, technicals, and calculates composite scores', category: 'machine-learning' },
      { id: 'mc-screener-sync', q: queueModule.mcScreenerSyncQueue, label: 'MoneyControl Sync', desc: 'Pulls positive and negative stock scans from MoneyControl', category: 'data-sync' },
      { id: 'etnow-screener-sync', q: queueModule.etnowScreenerSyncQueue, label: 'ETNow Sync', desc: 'Synchronizes ETNow screener lists and breakouts', category: 'data-sync' },
      { id: 'nse-sync', q: queueModule.nseScreenerSyncQueue, label: 'NSE Master Sync', desc: 'Weekly synchronization of the NSE master stock list', category: 'data-sync' },
      { id: 'fundamentals-sync', q: queueModule.fundamentalsSyncQueue, label: 'Fundamentals Sync', desc: 'Fetches company financials and ratios', category: 'data-sync' },
      { id: 'quant-scoring', q: queueModule.quantScoringQueue, label: 'Quant Score Engine', desc: 'Calculates momentum and volatility ranks', category: 'machine-learning' },
      { id: 'technical-signals', q: queueModule.technicalSignalsQueue, label: 'Technical Signal Scan', desc: 'Scans technical indicators (EMA, RSI, MACD, BB)', category: 'signals-analysis' },
      { id: 'signal-outcomes', q: queueModule.signalOutcomesQueue, label: 'Signal Outcome Tracker', desc: 'Resolves outcome targets (WIN/LOSS) over time horizons', category: 'signals-analysis' },
      { id: 'news-sentiment', q: queueModule.newsSentimentQueue, label: 'FinBERT News Scorer', desc: 'Scores news headlines using deep learning NLP', category: 'machine-learning' },
      { id: 'trendlyne-intraday', q: queueModule.trendlyneIntradayQueue, label: 'Trendlyne Intraday Scan', desc: 'Scans Trendlyne screener breakouts (15-min intervals)', category: 'signals-analysis' },
      { id: 'outcome-resolver', q: queueModule.outcomeResolverQueue, label: 'Outcome Resolver', desc: 'Validates target payouts and exits', category: 'signals-analysis' },
      { id: 'ml-daily-ops', q: queueModule.mlDailyOpsQueue, label: 'ML Inference Ops', desc: 'Scores pending signals with the stacking ensemble', category: 'machine-learning' },
      { id: 'ml-weekly-retrain', q: queueModule.mlWeeklyRetrainQueue, label: 'ML Retraining Ops', desc: 'Retrains stacking classifier and runs strategy optimizer', category: 'machine-learning' },
      { id: 'intraday-fetcher', q: queueModule.intradayFetcherQueue, label: 'Intraday Bar Fetcher', desc: 'Fetches 15-min OHLCV bars during market hours', category: 'data-sync' },
      { id: 'live-screener-collect', q: queueModule.liveScreenerCollectQueue, label: 'Live Screener Poller', desc: 'Polls active screeners during market hours', category: 'data-sync' },
      { id: 'research-premarket', q: queueModule.researchPremarketQueue, label: 'Premarket Intelligence', desc: 'Aggregates preopen indicators and macro reports', category: 'system-research' },
      { id: 'research-postclose', q: queueModule.researchPostcloseQueue, label: 'Postclose Aggregator', desc: 'Compiles close-of-day analytics', category: 'system-research' },
      { id: 'dl-macro-fetch', q: queueModule.dlMacroFetchQueue, label: 'DL Macro Fetcher', desc: 'Synchronizes macro indicators (US yields, Crude, Gold)', category: 'data-sync' },
      { id: 'dl-feature-refresh', q: queueModule.dlFeatureRefreshQueue, label: 'DL Feature Refresh', desc: 'Calculates deep learning feature store rows', category: 'machine-learning' },
      { id: 'dl-inference', q: queueModule.dlInferenceQueue, label: 'DL Model Inference', desc: 'Generates deep learning predictions (LSTM model)', category: 'machine-learning' },
      { id: 'dl-regime-update', q: queueModule.dlRegimeUpdateQueue, label: 'HMM Regime Update', desc: 'Updates market regime HMM classifier states', category: 'machine-learning' },
      { id: 'dl-retrain-weekly', q: queueModule.dlRetrainWeeklyQueue, label: 'DL Weekly Retrainer', desc: 'Retrains deep learning LSTM models', category: 'machine-learning' },
      { id: 'ohlcv-backfill', q: queueModule.ohlcvBackfillQueue, label: 'OHLCV Gap Filler', desc: 'Fills historical data gaps from Yahoo Finance', category: 'data-sync' },
      { id: 'confluence-compute', q: queueModule.confluenceComputeQueue, label: 'Confluence Engine', desc: 'Computes multi-indicator confluence scores', category: 'signals-analysis' },
      { id: 'confluence-outcomes', q: queueModule.confluenceOutcomesQueue, label: 'Confluence Outcomes', desc: 'Tracks confluence signal outcomes', category: 'signals-analysis' },
      { id: 'screener-performance', q: queueModule.screenerPerfQueue, label: 'Screener Perf Optimizer', desc: 'Runs Bayesian analysis on screener performance', category: 'machine-learning' },
      { id: 'agent-data-scientist', q: queueModule.agentDataScientistQueue, label: 'Agent: Data Scientist', desc: 'Autonomous data inspection and reporting agent', category: 'agents' },
      { id: 'agent-strategist', q: queueModule.agentStrategistQueue, label: 'Agent: Strategist', desc: 'Optimizes strategy allocation weights', category: 'agents' },
      { id: 'agent-auditor', q: queueModule.agentAuditorQueue, label: 'Agent: Auditor', desc: 'Validates data integrity and logs anomalies', category: 'agents' },
      { id: 'agent-optimizer', q: queueModule.agentOptimizerQueue, label: 'Agent: Optimizer', desc: 'Model tuning optimizer', category: 'agents' },
      { id: 'unified-ranker', q: queueModule.unifiedRankerQueue, label: 'Unified Daily Ranker', desc: 'Generates daily top EOD picks', category: 'agents' },
    ];

    const results = await Promise.all(
      queueList.map(async (item) => {
        const q = item.q;
        if (!q) {
          return {
            id: item.id,
            label: item.label,
            desc: item.desc,
            category: item.category,
            connected: false,
            activeCount: 0,
            waitingCount: 0,
            completedCount: 0,
            failedCount: 0,
            delayedCount: 0,
            repeatable: [] as any[],
            recentJobs: [] as any[],
          };
        }

        try {
          const [active, waiting, completed, failed, delayed, repeatableJobs] = await Promise.all([
            q.getActiveCount(),
            q.getWaitingCount(),
            q.getCompletedCount(),
            q.getFailedCount(),
            q.getDelayedCount(),
            q.getRepeatableJobs(),
          ]);

          // Fetch recent completed/failed/active/waiting jobs
          const [completedJobs, failedJobs, activeJobs, waitingJobs] = await Promise.all([
            q.getJobs(['completed'], 0, 5, true),
            q.getJobs(['failed'], 0, 5, true),
            q.getJobs(['active'], 0, 5, true),
            q.getJobs(['waiting'], 0, 5, true),
          ]);

          const formatJob = (job: any, state: string) => ({
            id: job.id,
            name: job.name,
            progress: typeof job.progress === 'number' ? job.progress : 0,
            failedReason: job.failedReason ?? null,
            processedOn: job.processedOn ?? null,
            finishedOn: job.finishedOn ?? null,
            timestamp: job.timestamp,
            state,
          });

          const jobs = [
            ...activeJobs.map(j => formatJob(j, 'active')),
            ...waitingJobs.map(j => formatJob(j, 'waiting')),
            ...failedJobs.map(j => formatJob(j, 'failed')),
            ...completedJobs.map(j => formatJob(j, 'completed')),
          ].slice(0, 10); // Limit to top 10 overall recent jobs

          return {
            id: item.id,
            label: item.label,
            desc: item.desc,
            category: item.category,
            connected: true,
            activeCount: active,
            waitingCount: waiting,
            completedCount: completed,
            failedCount: failed,
            delayedCount: delayed,
            repeatable: repeatableJobs.map((r: any) => ({
              key: r.key,
              name: r.name,
              cron: r.cron || (r.every ? `Every ${r.every / 1000}s` : 'unknown'),
              next: r.next ? new Date(r.next).toISOString() : null,
            })),
            recentJobs: jobs,
          };
        } catch (err: any) {
          return {
            id: item.id,
            label: item.label,
            desc: item.desc,
            category: item.category,
            connected: false,
            activeCount: 0,
            waitingCount: 0,
            completedCount: 0,
            failedCount: 0,
            delayedCount: 0,
            repeatable: [] as any[],
            recentJobs: [] as any[],
            error: err.message,
          };
        }
      })
    );

    return results;
  }),

  triggerBullMQJob: publicProcedure
    .input(z.object({ queueId: z.string() }))
    .mutation(async ({ input }) => {
      const queueList = [
        { id: 'stock-refresh', q: queueModule.stockRefreshQueue },
        { id: 'ai-signals', q: queueModule.aiSignalsQueue },
        { id: 'stock-scoring', q: queueModule.stockScoringQueue },
        { id: 'mc-screener-sync', q: queueModule.mcScreenerSyncQueue },
        { id: 'etnow-screener-sync', q: queueModule.etnowScreenerSyncQueue },
        { id: 'nse-sync', q: queueModule.nseScreenerSyncQueue },
        { id: 'fundamentals-sync', q: queueModule.fundamentalsSyncQueue },
        { id: 'quant-scoring', q: queueModule.quantScoringQueue },
        { id: 'technical-signals', q: queueModule.technicalSignalsQueue },
        { id: 'signal-outcomes', q: queueModule.signalOutcomesQueue },
        { id: 'news-sentiment', q: queueModule.newsSentimentQueue },
        { id: 'trendlyne-intraday', q: queueModule.trendlyneIntradayQueue },
        { id: 'outcome-resolver', q: queueModule.outcomeResolverQueue },
        { id: 'ml-daily-ops', q: queueModule.mlDailyOpsQueue },
        { id: 'ml-weekly-retrain', q: queueModule.mlWeeklyRetrainQueue },
        { id: 'intraday-fetcher', q: queueModule.intradayFetcherQueue },
        { id: 'live-screener-collect', q: queueModule.liveScreenerCollectQueue },
        { id: 'research-premarket', q: queueModule.researchPremarketQueue },
        { id: 'research-postclose', q: queueModule.researchPostcloseQueue },
        { id: 'dl-macro-fetch', q: queueModule.dlMacroFetchQueue },
        { id: 'dl-feature-refresh', q: queueModule.dlFeatureRefreshQueue },
        { id: 'dl-inference', q: queueModule.dlInferenceQueue },
        { id: 'dl-regime-update', q: queueModule.dlRegimeUpdateQueue },
        { id: 'dl-retrain-weekly', q: queueModule.dlRetrainWeeklyQueue },
        { id: 'ohlcv-backfill', q: queueModule.ohlcvBackfillQueue },
        { id: 'confluence-compute', q: queueModule.confluenceComputeQueue },
        { id: 'confluence-outcomes', q: queueModule.confluenceOutcomesQueue },
        { id: 'screener-performance', q: queueModule.screenerPerfQueue },
        { id: 'agent-data-scientist', q: queueModule.agentDataScientistQueue },
        { id: 'agent-strategist', q: queueModule.agentStrategistQueue },
        { id: 'agent-auditor', q: queueModule.agentAuditorQueue },
        { id: 'agent-optimizer', q: queueModule.agentOptimizerQueue },
        { id: 'unified-ranker', q: queueModule.unifiedRankerQueue },
      ];

      const match = queueList.find(x => x.id === input.queueId);
      if (!match) throw new Error(`Unknown queue: ${input.queueId}`);
      const q = match.q;
      if (!q) throw new Error(`Queue ${input.queueId} is offline/disconnected`);

      const job = await q.add(`manual-${input.queueId}-${Date.now()}`, {}, {
        removeOnComplete: 10,
        removeOnFail: 20,
      });

      return { success: true, jobId: job.id, message: `Successfully queued manual job in ${input.queueId}` };
    }),

  getLiveScreenerOptimalCombinations: publicProcedure
    .query(async () => {
      const row = await dbGet<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = 'live_screener_optimal_combinations'"
      );
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }),

  getLiveScreenerBacktestRuns: publicProcedure
    .query(async () => {
      const runs = await dbAll<any>(
        "SELECT id, run_name, start_date, end_date, total_return_pct, win_rate, sharpe_ratio, alpha_pct, total_trades, strategy_config_json " +
        "FROM backtesting_runs WHERE run_name LIKE 'live_screener_%' ORDER BY run_at DESC LIMIT 50"
      );
      return runs;
    }),

  // Same-day (return_intraday) counterpart to getLiveScreenerOptimalCombinations, trained by
  // live_screener_optimizer.py's second, isolated pass so it never blends with the swing/EOD
  // combos above.
  getLiveScreenerOptimalIntradayCombinations: publicProcedure
    .query(async () => {
      const row = await dbGet<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = 'live_screener_optimal_combinations_intraday'"
      );
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }),

  // Stocks matching NiftyTrader live-screener filters as of the most recent collection cycle
  // (liveScreenerCollector.ts, every 15 min during market hours), ranked by each matched
  // filter's historical same-day (return_intraday) win-rate/avg-return from
  // live_screener_outcomes. Reads the already-collected DB rows rather than re-hitting the
  // NiftyTrader API, so this can refresh on a short frontend poll without adding API load.
  getLiveScreenerIntradaySignals: publicProcedure
    .query(async () => {
      const latestRun = await dbGet<{ id: number }>(
        "SELECT MAX(id) as id FROM live_screener_runs WHERE status IN ('SUCCESS','PARTIAL')"
      );
      if (!latestRun?.id) return { asOf: null, stocks: [] };

      const [appearances, filterStats, mlScores, runRow] = await Promise.all([
        dbAll<{ symbol: string; filter_key: string; price: number; change_per: number; volume: number }>(
          "SELECT symbol, filter_key, price, change_per, volume FROM live_screener_appearances WHERE run_id = ?",
          [latestRun.id]
        ),
        dbAll<{ filter_key: string; sample_count: number; win_rate: number; avg_return: number }>(
          `SELECT filter_key, COUNT(*) as sample_count,
                  AVG(CASE WHEN return_intraday > 0 THEN 1.0 ELSE 0.0 END) as win_rate,
                  AVG(return_intraday) as avg_return
           FROM live_screener_outcomes
           WHERE return_intraday IS NOT NULL
           GROUP BY filter_key
           HAVING COUNT(*) >= 3`
        ),
        // ML win-probability from live_screener_ml_ranker.py, scored for this same run_id
        // right after collection (queues.ts). Absent until the first --train has promoted
        // a model -- callers fall back to the rule-based edge_score below until then.
        dbAll<{ symbol: string; win_probability: number }>(
          "SELECT symbol, win_probability FROM live_screener_ml_scores WHERE run_id = ?",
          [latestRun.id]
        ),
        dbGet<{ created_at: string }>("SELECT created_at FROM live_screener_runs WHERE id = ?", [latestRun.id]),
      ]);

      const statsByFilter = new Map(filterStats.map(f => [f.filter_key, f]));
      const mlBySymbol = new Map(mlScores.map(m => [m.symbol, Number(m.win_probability)]));

      type StockAgg = {
        symbol: string; price: number; change_per: number; volume: number;
        filters: { filter_key: string; win_rate: number | null; avg_return: number | null; sample_count: number }[];
      };
      const bySymbol = new Map<string, StockAgg>();
      for (const a of appearances) {
        if (!bySymbol.has(a.symbol)) {
          bySymbol.set(a.symbol, { symbol: a.symbol, price: a.price, change_per: a.change_per, volume: a.volume, filters: [] });
        }
        const stat = statsByFilter.get(a.filter_key);
        bySymbol.get(a.symbol)!.filters.push({
          filter_key: a.filter_key,
          win_rate: stat ? Number(stat.win_rate) : null,
          avg_return: stat ? Number(stat.avg_return) : null,
          sample_count: stat ? Number(stat.sample_count) : 0,
        });
      }

      const stocks = Array.from(bySymbol.values()).map(s => {
        const tracked = s.filters.filter(f => f.sample_count >= 3 && f.win_rate !== null && f.avg_return !== null);
        // Rank by avg_return (the mean realized same-day return across all resolved samples,
        // wins and losses alike) -- the same metric live_screener_optimizer.py sorts its
        // combinations by. win_rate is exposed for context, not blended in: multiplying the
        // two double-counts the loss side, since avg_return already nets wins against losses.
        const best = [...tracked].sort((a, b) => b.avg_return! - a.avg_return!)[0] ?? null;
        return {
          symbol: s.symbol,
          price: s.price,
          change_per: s.change_per,
          volume: s.volume,
          filters: s.filters,
          best_filter: best?.filter_key ?? null,
          best_win_rate: best?.win_rate ?? null,
          best_avg_return: best?.avg_return ?? null,
          best_sample_count: best?.sample_count ?? 0,
          edge_score: best?.avg_return ?? 0,
          ml_win_probability: mlBySymbol.get(s.symbol) ?? null,
        };
      }).sort((a, b) => {
        // ML-scored stocks first (ranked by the learned model, which weighs all matched
        // filters plus change_per/volume jointly), then whatever's left ranked by the
        // single-best-filter rule above -- keeps the tab useful before the first model trains.
        if (a.ml_win_probability !== null && b.ml_win_probability !== null) return b.ml_win_probability - a.ml_win_probability;
        if (a.ml_win_probability !== null) return -1;
        if (b.ml_win_probability !== null) return 1;
        return b.edge_score - a.edge_score;
      });

      return { asOf: runRow?.created_at ?? null, stocks };
    }),

  // Status of the currently-ACTIVE live_screener_intraday_clf model (written by
  // live_screener_ml_ranker.py --train only when a retrain clears its promotion-margin
  // check against the prior model -- a rejected candidate never touches this key, so it
  // always reflects whichever model is actually scoring stocks right now).
  getLiveScreenerMlModelStatus: publicProcedure
    .query(async () => {
      const row = await dbGet<{ value: string }>(
        "SELECT value FROM app_settings WHERE key = 'live_screener_ml_model_status'"
      );
      if (!row) return null;
      try {
        return JSON.parse(row.value);
      } catch {
        return null;
      }
    }),
});
