import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { RefreshCw, Target, AlertTriangle } from 'lucide-react';

type Timeframe = 'intraday' | 'swing' | 'positional' | 'investment';

const TF_LABELS: Record<Timeframe, string> = {
  intraday: 'Intraday', swing: 'Swing', positional: 'Positional', investment: 'Investment',
};
const CONVICTION_COLOR: Record<string, string> = {
  HIGH: 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40',
  MEDIUM: 'bg-yellow-500/20 text-yellow-300 border-yellow-500/40',
  LOW: 'bg-slate-500/20 text-slate-300 border-slate-500/40',
};

export function AgentStrategistPage() {
  const [tf, setTf] = useState<Timeframe>('swing');
  const { data, isLoading, refetch } = trpc.getAgentStrategyPicks.useQuery({ timeframe: tf } as any);
  const { data: triggerErrors, refetch: refetchTriggerErrors } = trpc.getAgentTriggerErrors.useQuery();
  const runMutation = trpc.runStrategistAgent.useMutation({
    onSuccess: () => setTimeout(() => { refetch(); refetchTriggerErrors(); }, 3000),
  });
  const triggerError = (triggerErrors as any)?.strategist;

  const picks = (data?.picks as any[]) ?? [];
  const topNarrative = picks[0]?.narrative;

  return (
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <Target className="w-6 h-6 text-purple-400" /> Strategist Agent
          </h1>
          {data?.runDate && <p className="text-sm text-slate-400 mt-1 font-data">Run date: {data.runDate}</p>}
        </div>
        <div className="v1-header-actions">
          <button
            onClick={() => runMutation.mutate()}
            disabled={runMutation.isPending}
            className="v1-btn-primary"
          >
            <RefreshCw className={`w-4 h-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
            Run Now
          </button>
        </div>
      </div>

      {triggerError?.error && (
        <div className="flex items-center gap-2 text-sm text-rose-400 bg-rose-950/40 border border-rose-900 rounded-lg px-3 py-2">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>Last direct run failed{triggerError.at ? ` at ${triggerError.at}` : ''}: {triggerError.error}</span>
        </div>
      )}

      <div className="flex gap-2">
        {(Object.keys(TF_LABELS) as Timeframe[]).map(t => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`px-4 py-2 rounded-lg text-xs font-semibold font-display tracking-wide transition-colors ${
              tf === t ? 'bg-indigo-600 text-white shadow-lg shadow-indigo-500/20' : 'v1-btn-secondary'
            }`}
          >
            {TF_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <div className="v1-card p-6 text-sm text-slate-400 font-data animate-pulse">Loading picks...</div>}

      {topNarrative && (
        <div className="v1-card p-5">
          <p className="v1-title-card text-purple-300 mb-2">🎯 Strategy Brief — {TF_LABELS[tf]}</p>
          <p className="text-slate-100 text-sm leading-relaxed">{topNarrative}</p>
        </div>
      )}

      {picks.length === 0 && !isLoading && (
        <div className="v1-card p-6 text-slate-400 text-sm font-data">No picks for {TF_LABELS[tf]} today.</div>
      )}

      {picks.length > 0 && (
        <div className="v1-card p-5 overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="text-xs text-slate-400 border-b border-white/10 font-display uppercase tracking-wider">
              <tr>
                <th className="text-left py-3 pr-4">#</th>
                <th className="text-left py-3 pr-4">Symbol</th>
                <th className="text-left py-3 pr-4">Conviction</th>
                <th className="text-right py-3 pr-4">Entry Zone</th>
                <th className="text-right py-3 pr-4">Stop Loss</th>
                <th className="text-right py-3 pr-4">T1</th>
                <th className="text-right py-3 pr-4">T2</th>
                <th className="text-right py-3 pr-4">T3</th>
                <th className="text-right py-3">Score</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-white/5 font-data text-xs">
              {picks.map((p: any) => (
                <tr key={p.id} className="hover:bg-white/5 transition-colors">
                  <td className="py-3 pr-4 text-slate-500">{p.rank}</td>
                  <td className="py-3 pr-4 font-bold text-white">{p.symbol}</td>
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-0.5 rounded border text-[10px] font-bold ${CONVICTION_COLOR[p.conviction]}`}>
                      {p.conviction}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right text-slate-300">₹{p.entry_zone_low}–{p.entry_zone_high}</td>
                  <td className="py-3 pr-4 text-right text-rose-400 font-bold">₹{p.stop_loss}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400 font-bold">₹{p.target_1}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400 font-bold">₹{p.target_2}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400 font-bold">₹{p.target_3}</td>
                  <td className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-purple-400 rounded-full" style={{ width: `${Math.min(p.composite_score, 100)}%` }} />
                      </div>
                      <span className="v1-data-value text-slate-300 text-xs w-8 text-right">{p.composite_score?.toFixed(0)}</span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
