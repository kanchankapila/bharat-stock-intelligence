import { z } from "zod";
import * as fs from "fs";
import * as path from "path";
import db from "../db";
import { router, publicProcedure } from "../trpc";
import { runPython } from '../pythonRunner';
import { fetchIndexAdvanceDecline, fetchIndiaVix, fetchLiveMarketScreener, fetchEODMarketScreener } from '../marketIntelService';

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

function getLastRunAt(scriptId: ScriptId): string | null {
  try {
    let row: any;
    switch (scriptId) {
      case 'technical-scan':
        row = db.prepare("SELECT MAX(computed_at) as t FROM technical_signals").get();
        break;
      case 'outcome-resolver-5d':
        row = db.prepare("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=5 AND outcome!='PENDING'").get();
        break;
      case 'outcome-resolver-15d':
        row = db.prepare("SELECT MAX(computed_at) as t FROM signal_outcomes WHERE horizon_days=15 AND outcome!='PENDING'").get();
        break;
      case 'performance-tracker':
        row = db.prepare("SELECT MAX(last_computed) as t FROM strategy_performance").get();
        break;
      case 'fii-dii-fetcher':
        row = db.prepare("SELECT MAX(fetched_at) as t FROM fii_dii_flow").get();
        break;
      case 'finbert-scorer':
        row = db.prepare("SELECT MAX(computed_at) as t FROM technical_signals WHERE news_sentiment_score IS NOT NULL").get();
        break;
      case 'ml-ensemble-score':
        row = db.prepare("SELECT MAX(computed_at) as t FROM technical_signals WHERE win_probability IS NOT NULL").get();
        break;
      case 'ml-ensemble-train':
        row = db.prepare("SELECT MAX(trained_at) as t FROM model_registry WHERE model_name='ensemble'").get();
        break;
      case 'strategy-optimizer':
        row = db.prepare("SELECT MAX(snapshot_at) as t FROM screener_weight_history").get();
        break;
      case 'ohlcv-backfill':
        row = db.prepare("SELECT MAX(date) as t FROM stock_ohlcv").get();
        break;
      case 'regime-detector':
        row = db.prepare("SELECT MAX(computed_at) as t FROM market_regimes").get();
        break;
      case 'feature-engineering':
        row = db.prepare("SELECT MAX(computed_at) as t FROM feature_store").get();
        break;
      case 'reward-engine':
        row = db.prepare("SELECT MAX(last_updated) as t FROM signal_type_weights").get();
        break;
      case 'rl-agent-update':
        row = db.prepare("SELECT MAX(last_updated) as t FROM rl_q_table").get();
        break;
      case 'dl-engine-infer':
        row = db.prepare("SELECT MAX(created_at) as t FROM deep_learning_predictions").get();
        break;
      case 'dl-trainer':
        row = db.prepare("SELECT MAX(trained_at) as t FROM model_registry WHERE model_name='BiLSTM'").get();
        break;
      case 'signal-type-stats':
        row = db.prepare("SELECT MAX(last_computed) as t FROM signal_type_stats").get();
        break;
      case 'screener-performance':
        row = db.prepare("SELECT MAX(last_computed) as t FROM screener_performance_v2").get();
        break;
      case 'company-profiles-sync':
        row = db.prepare("SELECT MAX(last_updated) as t FROM company_profiles").get();
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

function getScriptStats(scriptId: ScriptId): Record<string, number | string | null> {
  try {
    switch (scriptId) {
      case 'technical-scan':
        return { total: (db.prepare("SELECT COUNT(*) as n FROM technical_signals").get() as any)?.n ?? 0 };
      case 'outcome-resolver-5d':
        return { resolved: (db.prepare("SELECT COUNT(*) as n FROM signal_outcomes WHERE horizon_days=5 AND outcome!='PENDING'").get() as any)?.n ?? 0 };
      case 'outcome-resolver-15d':
        return { resolved: (db.prepare("SELECT COUNT(*) as n FROM signal_outcomes WHERE horizon_days=15 AND outcome!='PENDING'").get() as any)?.n ?? 0 };
      case 'performance-tracker':
        return {
          strategies: (db.prepare("SELECT COUNT(*) as n FROM strategy_performance").get() as any)?.n ?? 0,
          withAlpha: (db.prepare("SELECT COUNT(*) as n FROM strategy_performance WHERE alpha_vs_nifty IS NOT NULL").get() as any)?.n ?? 0,
        };
      case 'fii-dii-fetcher':
        return { rows: (db.prepare("SELECT COUNT(*) as n FROM fii_dii_flow WHERE fii_net IS NOT NULL").get() as any)?.n ?? 0 };
      case 'finbert-scorer':
        const total = (db.prepare("SELECT COUNT(*) as n FROM technical_signals").get() as any)?.n ?? 1;
        const scored = (db.prepare("SELECT COUNT(*) as n FROM technical_signals WHERE news_sentiment_score IS NOT NULL").get() as any)?.n ?? 0;
        return { coverage: Math.round(scored / total * 100) + '%' };
      case 'ml-ensemble-score':
        const t2 = (db.prepare("SELECT COUNT(*) as n FROM technical_signals").get() as any)?.n ?? 1;
        const s2 = (db.prepare("SELECT COUNT(*) as n FROM technical_signals WHERE win_probability IS NOT NULL").get() as any)?.n ?? 0;
        return { coverage: Math.round(s2 / t2 * 100) + '%' };
      case 'ml-ensemble-train': {
        const m = db.prepare("SELECT cv_roc_auc, training_samples FROM model_registry WHERE model_name='ensemble' ORDER BY trained_at DESC LIMIT 1").get() as any;
        return m ? { auc: m.cv_roc_auc?.toFixed(4) ?? 'N/A', samples: m.training_samples } : {};
      }
      case 'strategy-optimizer': {
        const w = db.prepare("SELECT optimized_win_rate, improvement_pct FROM screener_weight_history ORDER BY snapshot_at DESC LIMIT 1").get() as any;
        return w ? { winRate: (w.optimized_win_rate * 100).toFixed(1) + '%', improvement: w.improvement_pct?.toFixed(2) + '%' } : {};
      }
      case 'ohlcv-backfill':
        return {
          symbols: (db.prepare("SELECT COUNT(DISTINCT symbol) as n FROM stock_ohlcv").get() as any)?.n ?? 0,
          rows: (db.prepare("SELECT COUNT(*) as n FROM stock_ohlcv").get() as any)?.n ?? 0,
        };
      case 'regime-detector': {
        const r = db.prepare("SELECT regime, COUNT(*) as n FROM market_regimes GROUP BY regime ORDER BY n DESC LIMIT 1").get() as any;
        const total = (db.prepare("SELECT COUNT(*) as n FROM market_regimes").get() as any)?.n ?? 0;
        return r ? { days: total, latest: r.regime } : { days: 0 };
      }
      case 'feature-engineering': {
        const sRow = db.prepare("SELECT COUNT(DISTINCT symbol) as n FROM feature_store").get() as any;
        const rRow = db.prepare("SELECT COUNT(*) as n FROM feature_store").get() as any;
        return {
          symbols: sRow?.n ?? 0,
          rows: rRow?.n ?? 0,
        };
      }
      case 'reward-engine':
        return { types: (db.prepare("SELECT COUNT(*) as n FROM signal_type_weights").get() as any)?.n ?? 0 };
      case 'rl-agent-update':
        return {
          states: (db.prepare("SELECT COUNT(DISTINCT state_key) as n FROM rl_q_table").get() as any)?.n ?? 0,
          entries: (db.prepare("SELECT COUNT(*) as n FROM rl_q_table").get() as any)?.n ?? 0,
        };
      case 'dl-engine-infer':
        return {
          symbols: (db.prepare("SELECT COUNT(DISTINCT symbol) as n FROM deep_learning_predictions").get() as any)?.n ?? 0,
          today: (db.prepare("SELECT COUNT(*) as n FROM deep_learning_predictions WHERE date(created_at)=date('now')").get() as any)?.n ?? 0,
        };
      case 'dl-trainer': {
        const m = db.prepare("SELECT cv_roc_auc, is_active FROM model_registry WHERE model_name='BiLSTM' ORDER BY trained_at DESC LIMIT 1").get() as any;
        return m ? { auc: m.cv_roc_auc?.toFixed(4) ?? 'N/A', active: m.is_active ? 'yes' : 'no' } : {};
      }
      case 'signal-type-stats':
        return {
          types: (db.prepare("SELECT COUNT(DISTINCT signal_type) as n FROM signal_type_stats").get() as any)?.n ?? 0,
          rows: (db.prepare("SELECT COUNT(*) as n FROM signal_type_stats").get() as any)?.n ?? 0,
        };
      case 'screener-performance': {
        const total = (db.prepare("SELECT COUNT(*) as n FROM screener_performance_v2").get() as any)?.n ?? 0;
        const tiers = db.prepare("SELECT tier, COUNT(*) as n FROM screener_performance_v2 GROUP BY tier ORDER BY tier").all() as any[];
        const tierStr = tiers.map((t: any) => `${t.tier}:${t.n}`).join(', ');
        return { screeners: total, tiers: tierStr };
      }
      case 'company-profiles-sync':
        return {
          profiles: (db.prepare("SELECT COUNT(*) as n FROM company_profiles").get() as any)?.n ?? 0,
          aiAnalyzed: (db.prepare("SELECT COUNT(*) as n FROM company_profiles WHERE ai_analysis IS NOT NULL AND ai_analysis != ''").get() as any)?.n ?? 0,
        };
      default:
        return {};
    }
  } catch (err: unknown) {
    console.warn('[MONITOR] getScriptStats failed:', (err as Error).message);
    return {};
  }
}

export const monitorRouter = router({
  getSystemStatus: publicProcedure.query(() => {
    const runStates: Record<string, string> = {};
    try {
      const rows = db.prepare("SELECT key, value FROM app_settings WHERE key LIKE 'monitor_%'").all() as any[];
      for (const r of rows) runStates[r.key] = r.value;
    } catch (err: unknown) {
      console.warn('[MONITOR] getSystemStatus failed:', (err as Error).message);
    }

    return MONITOR_SCRIPTS.map(s => {
      const dbLastRunAt = getLastRunAt(s.id as ScriptId);
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
        stats: getScriptStats(s.id as ScriptId),
        error: runStates[`monitor_${s.id}_error`] ?? null,
      };
    });
  }),

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
      const upsertState = (val: string) => {
        try {
          db.prepare("INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(stateKey, val);
          if (val === 'success') {
            db.prepare("INSERT INTO app_settings(key, value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
              .run(`${stateKey}_ran_at`, new Date().toISOString());
          }
        } catch (err: unknown) {
          console.warn('[MONITOR] upsertState failed:', (err as Error).message);
        }
      };

      upsertState('running');

      if (!script.pyScript) {
        // TypeScript function trigger (no Python, no queue)
        if ((script as any).tsFunction === 'computeSignalTypeStats') {
          try {
            const { computeSignalTypeStats } = await import('../technicalSignalsService');
            const result = computeSignalTypeStats();
            upsertState('success');
            return { queued: false, message: `Signal type stats computed: ${result.updated} rows updated` };
          } catch (e: any) {
            upsertState('failed');
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
        upsertState('success');
        return { queued: false, message: 'Queue unavailable — script is queue-only' };
      }

      void (async () => {
        const [pyFile, ...pyArgs] = script.pyScript!.split(' ');
        try {
          const { stdout } = await runPython(pyFile, pyArgs, 30 * 60_000);
          upsertState('success');
          db.prepare("DELETE FROM app_settings WHERE key=?").run(`${stateKey}_error`);
          if (stdout) console.log(`[MONITOR] ${script.id} stdout:`, stdout.slice(0, 300));
          console.log(`[MONITOR] ${script.id} done`);
        } catch (err: unknown) {
          const msg = (err as Error).message;
          upsertState('failed');
          db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value")
            .run(`${stateKey}_error`, msg.slice(0, 500));
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
    const upsert = (key: string, val: string) => {
      try {
        db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(key, val);
        if (val === 'success') {
          db.prepare("INSERT INTO app_settings(key,value) VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value").run(`${key}_ran_at`, new Date().toISOString());
        }
      } catch (err: unknown) {
        console.warn('[MONITOR] upsert failed:', (err as Error).message);
      }
    };

    for (const id of dailyScripts) {
      const s = MONITOR_SCRIPTS.find(x => x.id === id)!;
      if ((s as any).tsFunction === 'computeSignalTypeStats') {
        upsert(`monitor_${id}`, 'running');
        try {
          const { computeSignalTypeStats } = await import('../technicalSignalsService');
          computeSignalTypeStats();
          upsert(`monitor_${id}`, 'success');
        } catch { upsert(`monitor_${id}`, 'failed'); }
        continue;
      }
      if (!s.pyScript) continue;
      upsert(`monitor_${id}`, 'running');
      const [pyFile, ...pyArgs] = s.pyScript.split(' ');
      runPython(pyFile, pyArgs, 20 * 60_000)
        .then(() => upsert(`monitor_${id}`, 'success'))
        .catch(() => upsert(`monitor_${id}`, 'failed'));
    }
    return { started: dailyScripts.length };
  }),
});
