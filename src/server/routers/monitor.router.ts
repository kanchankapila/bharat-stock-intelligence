import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import { dbGet, dbAll, dbRun } from "../dbAsync";
import { router, publicProcedure } from "../trpc";
import { runPython } from '../pythonRunner';
import { fetchIndexAdvanceDecline, fetchIndiaVix, fetchLiveMarketScreener, fetchEODMarketScreener } from '../marketIntelService';
import * as queueModule from '../queues';

export const MONITOR_SCRIPTS = [
  {
    id: 'technical-scan',
    label: 'Technical Signal Scan',
    category: 'Signals',
    critical: true,
    description: 'Scans 2000+ stocks for EMA, RSI, BB, divergence patterns',
    schedule: 'Every 30 min',
    pyScript: null,          // queue-based
    queueName: 'technical-signals',
    staleLimitHours: 1,
  },
  {
    id: 'outcome-resolver-5d',
    label: 'Outcome Resolver (5D)',
    category: 'ML',
    critical: true,
    description: 'Labels signal WIN/LOSS against OHLCV — 5-day horizon',
    schedule: 'Daily 9:30 AM',
    pyScript: 'outcome_resolver.py --horizon 5',
    queueName: 'outcome-resolver',
    staleLimitHours: 26,
  },
  {
    id: 'outcome-resolver-15d',
    label: 'Outcome Resolver (15D)',
    category: 'ML',
    critical: false,
    description: 'Labels signal WIN/LOSS against OHLCV — 15-day horizon',
    schedule: 'Daily 9:30 AM',
    pyScript: 'outcome_resolver.py --horizon 15',
    queueName: 'outcome-resolver',
    staleLimitHours: 26,
  },
  {
    id: 'performance-tracker',
    label: 'Performance Tracker',
    category: 'ML',
    critical: true,
    description: 'Computes win rate, alpha vs Nifty, Sharpe — segmented by signal type / regime / sector',
    schedule: 'Daily 9:30 AM',
    pyScript: 'performance_tracker.py --horizon 5',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'fii-dii-fetcher',
    label: 'FII/DII Fetcher',
    category: 'Data',
    critical: true,
    description: 'Fetches institutional flow data from NSE API',
    schedule: 'Daily 5 PM',
    pyScript: 'fii_dii_fetcher.py',
    queueName: null,
    staleLimitHours: 30,
  },
  {
    id: 'finbert-scorer',
    label: 'FinBERT Sentiment',
    category: 'Data',
    critical: false,
    description: 'Scores news sentiment onto technical_signals rows',
    schedule: 'Daily 5 PM',
    pyScript: 'finbert_scorer.py --days 1',
    queueName: null,
    staleLimitHours: 30,
  },
  {
    id: 'ml-ensemble-score',
    label: 'ML Ensemble Score',
    category: 'ML',
    critical: true,
    description: 'Scores pending signals with stacking ensemble win probability',
    schedule: 'Daily 5 PM',
    pyScript: 'ml_ensemble.py --score',
    queueName: 'ml-daily-ops',
    staleLimitHours: 26,
  },
  {
    id: 'ml-ensemble-train',
    label: 'ML Ensemble Train',
    category: 'ML',
    critical: false,
    description: 'Retrains GB+RF+ET+LR stacking ensemble on accumulated outcomes',
    schedule: 'Weekly Sunday',
    pyScript: 'ml_ensemble.py --train --score',
    queueName: 'ml-weekly-retrain',
    staleLimitHours: 200,
  },
  {
    id: 'strategy-optimizer',
    label: 'Strategy Optimizer',
    category: 'ML',
    critical: false,
    description: 'Optimizes category/source weights via differential evolution',
    schedule: 'Weekly Sunday',
    pyScript: 'strategy_optimizer.py',
    queueName: 'ml-weekly-retrain',
    staleLimitHours: 200,
  },
  {
    id: 'ohlcv-backfill',
    label: 'OHLCV Gap Fill',
    category: 'Data',
    critical: true,
    description: 'Backfills missing daily OHLCV from Yahoo Finance (30-day lookback)',
    schedule: 'Weekly Saturday',
    pyScript: 'backfill_ohlcv.py --mode gap-fill --lookback 30',
    queueName: 'ohlcv-backfill',
    staleLimitHours: 200,
  },
  {
    id: 'regime-detector',
    label: 'Market Regime Detector',
    category: 'ML',
    critical: true,
    description: '5-state HMM classifier: BULL / SIDEWAYS / HIGH_VOL / BEAR / CRASH. Writes daily regime to market_regimes.',
    schedule: 'Daily 5 PM',
    pyScript: 'regime_detector.py --mode update',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'feature-engineering',
    label: 'Feature Engineering',
    category: 'Data',
    critical: true,
    description: 'Computes 84 ML-ready features per symbol (OHLCV, macro, FII, fundamentals) into feature_store.',
    schedule: 'Daily 5 PM',
    pyScript: 'feature_engineering.py --date today',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'reward-engine',
    label: 'Reward Engine',
    category: 'ML',
    critical: false,
    description: 'EMA-smoothed reward propagation — updates signal_type_weights from resolved outcomes.',
    schedule: 'Daily 5 PM',
    pyScript: 'reward_engine.py',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'rl-agent-update',
    label: 'RL Agent Update',
    category: 'ML',
    critical: false,
    description: 'Q-learning meta-controller update — writes Q-values to rl_q_table from recent episodes.',
    schedule: 'Daily 5 PM',
    pyScript: 'rl_agent.py --update',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'dl-engine-infer',
    label: 'DL Engine Inference',
    category: 'ML',
    critical: false,
    description: 'Deep learning model inference — writes win probabilities to deep_learning_predictions.',
    schedule: 'Daily 5 PM',
    pyScript: 'dl_engine.py --mode infer',
    queueName: null,
    staleLimitHours: 26,
  },
  {
    id: 'dl-trainer',
    label: 'DL Model Trainer',
    category: 'ML',
    critical: false,
    description: 'Trains / retrains deep learning model on feature_store. Writes metrics to dl_model_performance.',
    schedule: 'Weekly Sunday',
    pyScript: 'dl_trainer.py --trigger scheduled',
    queueName: null,
    staleLimitHours: 200,
  },
  {
    id: 'signal-type-stats',
    label: 'Signal Type Stats',
    category: 'Signals',
    critical: false,
    description: 'Computes win rate / avg return per signal type × regime from resolved signal outcomes.',
    schedule: 'Daily 5 PM',
    pyScript: null,
    queueName: null,
    tsFunction: 'computeSignalTypeStats',
    staleLimitHours: 26,
  },
  {
    id: 'screener-performance',
    label: 'Screener Performance Engine',
    category: 'ML',
    critical: false,
    description: 'Fills screener_appearances returns, computes Bayesian tiers (A/B/C/D), classifies new screeners via Ollama',
    schedule: 'Daily 6 PM',
    pyScript: 'screener_performance.py',
    queueName: 'screener-performance',
    staleLimitHours: 26,
  },
  {
    id: 'company-profiles-sync',
    label: 'Company Profile & AI Sync',
    category: 'Data',
    critical: false,
    description: 'Fetches Trendlyne company descriptions and scores high-growth potential via Ollama AI.',
    schedule: 'Weekly Sunday',
    pyScript: null,
    queueName: 'company-profiles-sync',
    staleLimitHours: 200,
  },
] as const;

type ScriptId = typeof MONITOR_SCRIPTS[number]['id'];

async function getLastRunAt(scriptId: ScriptId): Promise<string | null> {
  try {
    let row: any;
    switch (scriptId) {
      case 'technical-scan':
        row = await dbGet("SELECT MAX(computed_at) as t FROM technical_signals");
        break;
      case 'outcome-resolver-5d':
        row = await dbGet("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=5 AND outcome!='PENDING'");
        break;
      case 'outcome-resolver-15d':
        row = await dbGet("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=15 AND outcome!='PENDING'");
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
        const t2 = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals")) as any)?.n ?? 1;
        const s2 = ((await dbGet("SELECT COUNT(*) as n FROM technical_signals WHERE win_probability IS NOT NULL")) as any)?.n ?? 0;
        return { coverage: Math.round(s2 / t2 * 100) + '%' };
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
      default:
        return {};
    }
  } catch (err: unknown) {
    console.warn('[MONITOR] getScriptStats failed:', (err as Error).message);
    return {};
  }
}

export async function getSystemStatus() {
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

    if (rawState === 'running') {
      runState = 'running';
    } else if (lastRunAt) {
      const ageHours = (Date.now() - new Date(lastRunAt).getTime()) / 3600000;
      runState = ageHours > s.staleLimitHours ? 'stale' : (rawState === 'failed' ? 'failed' : 'success');
    } else {
      runState = rawState === 'failed' ? 'failed' : 'never';
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
});
