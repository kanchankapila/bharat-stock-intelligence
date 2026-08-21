import { useState } from 'react';
import { trpc } from '../lib/trpc';
import {
  Activity, CheckCircle, AlertCircle, Clock, RefreshCw, Play,
  Zap, Database, Brain, BarChart2, AlertTriangle, XCircle,
} from 'lucide-react';

type RunState = 'never' | 'running' | 'success' | 'failed' | 'stale';

interface ScriptStatus {
  id: string;
  label: string;
  category: string;
  critical: boolean;
  description: string;
  schedule: string;
  lastRunAt: string | null;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
  nextScheduledAt?: string | null;
  runCount?: number;
  failCount?: number;
  runState: RunState;
  stats: Record<string, string | number | null>;
  error: string | null;
}

function relTime(iso: string | null): string {
  if (!iso) return 'Never';
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.floor(hrs / 24);
  return `${days}d ago`;
}

function fmtDateTime(iso: string | null): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      day: '2-digit', month: 'short', year: 'numeric',
      hour: '2-digit', minute: '2-digit', hour12: true,
      timeZoneName: 'short',
    });
  } catch {
    return iso;
  }
}

function fmtIstSchedule(iso: string | null | undefined): string {
  if (!iso) return 'Not scheduled';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      timeZone: 'Asia/Kolkata',
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
      hour12: true,
    }) + ' IST';
  } catch {
    return iso;
  }
}

const STATE_CONFIG: Record<RunState, { label: string; color: string; bg: string; icon: any }> = {
  never:   { label: 'Never Run', color: 'text-slate-400',  bg: 'bg-slate-800',    icon: Clock },
  running: { label: 'Running',   color: 'text-indigo-400',   bg: 'bg-indigo-900/40',  icon: RefreshCw },
  success: { label: 'OK',        color: 'text-emerald-400',bg: 'bg-emerald-900/30',icon: CheckCircle },
  failed:  { label: 'Failed',    color: 'text-rose-400',    bg: 'bg-rose-900/30',   icon: XCircle },
  stale:   { label: 'Stale',     color: 'text-amber-400',  bg: 'bg-amber-900/30', icon: AlertTriangle },
};

const CATEGORY_ICON: Record<string, any> = {
  Signals: Activity,
  ML:      Brain,
  Data:    Database,
};

function ScriptCard({ script, onTrigger, triggering }: {
  script: ScriptStatus;
  onTrigger: (id: string) => void;
  triggering: boolean;
}) {
  const state = STATE_CONFIG[script.runState];
  const StateIcon = state.icon;
  const CatIcon = CATEGORY_ICON[script.category] || Activity;
  const isRunning = script.runState === 'running' || triggering;

  return (
    <div className={`rounded-xl border p-4 flex flex-col gap-3 transition-all
      ${script.critical ? 'border-slate-700' : 'border-slate-800'}
      bg-slate-900/70 hover:bg-slate-900`}>

      {/* Header */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <CatIcon className="w-4 h-4 text-slate-500 shrink-0" />
          <span className="text-sm font-semibold text-white whitespace-normal break-words leading-tight">{script.label}</span>
          {script.critical && (
            <span className="text-[9px] font-bold px-1.5 py-0.5 rounded bg-indigo-900/60 text-indigo-300 font-display uppercase tracking-wider shrink-0">
              Critical
            </span>
          )}
        </div>
        <span className={`flex items-center gap-1 text-[11px] font-bold px-2 py-0.5 rounded-full shrink-0 ${state.bg} ${state.color}`}>
          <StateIcon className={`w-3 h-3 ${script.runState === 'running' ? 'animate-spin' : ''}`} />
          {state.label}
        </span>
      </div>

      {/* Description */}
      <p className="text-xs text-slate-400 leading-snug">{script.description}</p>

      {/* Stats */}
      {Object.keys(script.stats).length > 0 && (
        <div className="flex flex-wrap gap-x-4 gap-y-1">
          {Object.entries(script.stats).map(([k, v]) => (
            <div key={k} className="text-[11px]">
              <span className="text-slate-500 capitalize">{k}: </span>
              <span className="text-slate-200 font-data font-semibold">{String(v ?? '—')}</span>
            </div>
          ))}
        </div>
      )}

      {/* Error */}
      {script.error && (
        <div className="text-[11px] text-rose-400 bg-rose-900/20 rounded px-2 py-1 font-data whitespace-pre-wrap break-words leading-snug">
          {script.error}
        </div>
      )}

      {/* Footer */}
      <div className="flex items-end justify-between mt-auto pt-1 border-t border-slate-800">
        <div className="flex flex-col gap-0.5 text-[10px]">
          <div className="flex items-center gap-1 text-[11px] text-slate-400">
            <Clock className="w-3 h-3" />
            <span className="font-semibold text-slate-200">{relTime(script.lastRunAt)}</span>
            <span className="text-slate-600">·</span>
            <span>{fmtDateTime(script.lastRunAt)}</span>
          </div>
          <div className="text-slate-500">
            Last success (IST): <span className="text-slate-300">{relTime(script.lastSuccessAt ?? null)}</span>
            {' '}· Next run (IST): <span className="text-indigo-300">{relTime(script.nextScheduledAt ?? null)}</span>
          </div>
          <div className="text-slate-600 whitespace-normal break-words">
            Next schedule: <span className="text-slate-400">{fmtIstSchedule(script.nextScheduledAt ?? null)}</span>
          </div>
          <div className="text-slate-600">
            Runs: <span className="text-slate-400 font-data">{script.runCount ?? 0}</span>
            {' '}· Fails: <span className="text-slate-400 font-data">{script.failCount ?? 0}</span>
          </div>
          <div className="text-[10px] text-slate-600 whitespace-normal break-words">{script.schedule}</div>
        </div>

        <button
          onClick={() => onTrigger(script.id)}
          disabled={isRunning}
          className={`flex items-center gap-1.5 text-[11px] font-semibold px-3 py-1.5 rounded-lg transition-all
            ${isRunning
              ? 'bg-slate-800 text-slate-600 cursor-not-allowed'
              : 'bg-indigo-600 hover:bg-indigo-500 text-white active:scale-95'
            }`}
        >
          {isRunning
            ? <RefreshCw className="w-3 h-3 animate-spin" />
            : <Play className="w-3 h-3" />
          }
          {isRunning ? 'Running...' : 'Run Now'}
        </button>
      </div>
    </div>
  );
}

export default function SystemMonitorPage() {
  const [triggeringIds, setTriggeringIds] = useState<Set<string>>(new Set());
  const [triggerAllLoading, setTriggerAllLoading] = useState(false);

  const { data: scripts, isLoading, refetch, dataUpdatedAt } = trpc.getSystemStatus.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const triggerMutation  = trpc.triggerScript.useMutation();
  const triggerAllMutation = trpc.triggerAllDaily.useMutation();

  const handleTrigger = async (scriptId: string) => {
    setTriggeringIds(prev => new Set([...prev, scriptId]));
    try {
      await triggerMutation.mutateAsync({ scriptId });
      setTimeout(() => refetch(), 1500);
    } finally {
      setTimeout(() => {
        setTriggeringIds(prev => { const s = new Set(prev); s.delete(scriptId); return s; });
      }, 3000);
    }
  };

  const handleTriggerAll = async () => {
    setTriggerAllLoading(true);
    try {
      await triggerAllMutation.mutateAsync();
      setTimeout(() => refetch(), 2000);
    } finally {
      setTimeout(() => setTriggerAllLoading(false), 5000);
    }
  };

  const categories = ['Signals', 'ML', 'Data'];
  const grouped = categories.reduce((acc, cat) => {
    acc[cat] = (scripts || []).filter(s => s.category === cat);
    return acc;
  }, {} as Record<string, ScriptStatus[]>);

  const summary = {
    ok:      (scripts || []).filter(s => s.runState === 'success').length,
    stale:   (scripts || []).filter(s => s.runState === 'stale').length,
    failed:  (scripts || []).filter(s => s.runState === 'failed').length,
    running: (scripts || []).filter(s => s.runState === 'running').length,
    never:   (scripts || []).filter(s => s.runState === 'never').length,
  };

  return (
    <div className="min-h-screen p-4 md:p-6 space-y-6">

      {/* Page header */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-900/40 rounded-lg">
            <Zap className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h1 className="text-lg font-bold text-white">System Monitor</h1>
            <p className="text-xs text-slate-400">Signal generation pipeline — script status & manual controls</p>
          </div>
        </div>

        <div className="flex items-center gap-2">
          <span className="text-[10px] text-slate-600">
            Updated {dataUpdatedAt ? relTime(new Date(dataUpdatedAt).toISOString()) : '—'}
          </span>
          <button
            onClick={() => refetch()}
            className="p-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 hover:text-white transition-colors"
            title="Refresh"
          >
            <RefreshCw className="w-4 h-4" />
          </button>
          <button
            onClick={handleTriggerAll}
            disabled={triggerAllLoading}
            className={`flex items-center gap-2 text-xs font-bold px-4 py-2 rounded-lg transition-all
              ${triggerAllLoading
                ? 'bg-slate-700 text-slate-500 cursor-not-allowed'
                : 'bg-emerald-600 hover:bg-emerald-500 text-white active:scale-95'}`}
          >
            {triggerAllLoading ? <RefreshCw className="w-3.5 h-3.5 animate-spin" /> : <Play className="w-3.5 h-3.5" />}
            Run Daily Pipeline
          </button>
        </div>
      </div>

      {/* Summary bar */}
      <div className="grid grid-cols-5 gap-3">
        {[
          { label: 'OK',      val: summary.ok,      color: 'text-emerald-400', bg: 'bg-emerald-900/20', icon: CheckCircle },
          { label: 'Running', val: summary.running,  color: 'text-indigo-400',   bg: 'bg-indigo-900/20',    icon: RefreshCw },
          { label: 'Stale',   val: summary.stale,    color: 'text-amber-400',  bg: 'bg-amber-900/20',   icon: AlertTriangle },
          { label: 'Failed',  val: summary.failed,   color: 'text-rose-400',    bg: 'bg-rose-900/20',     icon: XCircle },
          { label: 'Never',   val: summary.never,    color: 'text-slate-400',  bg: 'bg-slate-800',      icon: Clock },
        ].map(({ label, val, color, bg, icon: Icon }) => (
          <div key={label} className={`rounded-xl p-3 flex items-center gap-2 ${bg}`}>
            <Icon className={`w-4 h-4 ${color} shrink-0 ${label === 'Running' && val > 0 ? 'animate-spin' : ''}`} />
            <div>
              <div className={`text-xl font-black ${color}`}>{val}</div>
              <div className="text-[10px] text-slate-500 uppercase font-bold tracking-wide">{label}</div>
            </div>
          </div>
        ))}
      </div>

      {/* Schedule + status matrix (IST) */}
      {(scripts || []).length > 0 && (
        <div className="v1-card p-4">
          <h3 className="text-xs font-bold text-slate-400 font-display uppercase tracking-widest mb-3 flex items-center gap-2">
            <Clock className="w-3.5 h-3.5" /> Job Schedule Matrix (IST)
          </h3>
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] text-slate-500 font-display uppercase tracking-wider">
                  <th className="py-2 pr-3">Job</th>
                  <th className="py-2 pr-3">Category</th>
                  <th className="py-2 pr-3">Configured Schedule</th>
                  <th className="py-2 pr-3">Next Run (IST)</th>
                  <th className="py-2 pr-3">Current Status</th>
                </tr>
              </thead>
              <tbody>
                {(scripts || []).map((s) => {
                  const state = STATE_CONFIG[s.runState];
                  const MatrixStateIcon = state.icon;
                  return (
                    <tr key={`matrix-${s.id}`} className="border-b border-slate-900/60 text-[11px] text-slate-300">
                      <td className="py-2 pr-3 font-semibold text-white whitespace-normal break-words">{s.label}</td>
                      <td className="py-2 pr-3 text-slate-400">{s.category}</td>
                      <td className="py-2 pr-3 text-slate-400 whitespace-normal break-words">{s.schedule}</td>
                      <td className="py-2 pr-3 text-indigo-300 whitespace-normal break-words">{fmtIstSchedule(s.nextScheduledAt ?? null)}</td>
                      <td className="py-2 pr-3">
                        <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${state.bg} ${state.color}`}>
                          <MatrixStateIcon className={`w-3 h-3 ${s.runState === 'running' ? 'animate-spin' : ''}`} />
                          {state.label}
                        </span>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {isLoading && (
        <div className="flex justify-center py-12">
          <RefreshCw className="w-6 h-6 text-slate-500 animate-spin" />
        </div>
      )}

      {/* Script cards by category */}
      {categories.map(cat => {
        const catScripts = grouped[cat] || [];
        if (!catScripts.length) return null;
        const CatIcon = CATEGORY_ICON[cat] || BarChart2;
        return (
          <div key={cat} className="space-y-3">
            <div className="flex items-center gap-2">
              <CatIcon className="w-4 h-4 text-slate-500" />
              <h2 className="text-sm font-bold text-slate-300 font-display uppercase tracking-widest">{cat}</h2>
              <div className="flex-1 h-px bg-slate-800" />
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-3">
              {catScripts.map(s => (
                <ScriptCard
                  key={s.id}
                  script={s}
                  onTrigger={handleTrigger}
                  triggering={triggeringIds.has(s.id)}
                />
              ))}
            </div>
          </div>
        );
      })}

      {/* Schedule reference */}
      <div className="v1-card p-4">
        <h3 className="text-xs font-bold text-slate-400 font-display uppercase tracking-widest mb-3 flex items-center gap-2">
          <Clock className="w-3.5 h-3.5" /> Auto-Schedule Reference
        </h3>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-2">
          {[
            { time: 'Every 15-30 min, market hours', scripts: 'Technical Signal Scan, Intraday Fetch/Rank, Live Screener Collect' },
            { time: 'Daily 7:30 AM IST',             scripts: 'Unified Ranker (canonical daily picks)' },
            { time: 'Daily 9:30 AM IST',             scripts: 'Outcome Resolver' },
            { time: 'Daily ~4:00-6:40 PM IST',        scripts: 'OHLCV Refresh, Screener Syncs (MC/ETNow/ET-Marketstats/Trendlyne)' },
            { time: 'Daily 7:30 PM IST',              scripts: 'Full ML Daily Ops (FII → FinBERT → Outcomes → Perf → Score → Drift → RL)' },
            { time: 'Chain-triggered, ~5-8 PM IST',   scripts: 'DL Inference (fires right after DL Feature Refresh; 5 AM fallback)' },
            { time: 'Daily 10:00-11:30 PM IST',       scripts: 'Quant EOD Sync, Stock/Quant Scoring, Confluence Outcomes' },
            { time: 'Sunday 8:30-11:30 AM IST',       scripts: 'Fundamentals Sync, ML/DL Weekly Retrain, Strategy Optimizer' },
          ].map(({ time, scripts }) => (
            <div key={time} className="space-y-1">
              <div className="text-[11px] font-semibold text-indigo-400">{time}</div>
              <div className="text-[11px] text-slate-400">{scripts}</div>
            </div>
          ))}
        </div>
        <p className="mt-3 text-[10px] text-slate-600">
          On a mid-week trading holiday, the daily pipeline (Outcome Resolver → ML Daily Ops → Unified Ranker)
          runs early instead (~7:10 AM IST) and every other job above skips its normal run for the day — the
          exchange never opened, so there is nothing new to fetch or re-score.
        </p>
      </div>
    </div>
  );
}
