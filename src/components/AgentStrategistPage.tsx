import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { RefreshCw, Target } from 'lucide-react';

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
  const runMutation = trpc.runStrategistAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const picks = (data?.picks as any[]) ?? [];
  const topNarrative = picks[0]?.narrative;

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="v1-title-page flex items-center gap-2">
            <Target className="w-6 h-6 text-purple-400" /> Strategist Agent
          </h1>
          {data?.runDate && <p className="text-sm text-slate-400 mt-1">Run date: {data.runDate}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-purple-600 hover:bg-purple-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      <div className="flex gap-2">
        {(Object.keys(TF_LABELS) as Timeframe[]).map(t => (
          <button
            key={t}
            onClick={() => setTf(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tf === t ? 'bg-purple-600 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'
            }`}
          >
            {TF_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-slate-400">Loading picks...</p>}

      {topNarrative && (
        <div className="bg-purple-900/20 rounded-xl p-5 border border-purple-500/20">
          <p className="text-sm font-semibold text-purple-300 mb-2">🎯 Strategy Brief — {TF_LABELS[tf]}</p>
          <p className="text-white leading-relaxed">{topNarrative}</p>
        </div>
      )}

      {picks.length === 0 && !isLoading && (
        <p className="text-slate-500 text-sm">No picks for {TF_LABELS[tf]} today.</p>
      )}

      {picks.length > 0 && (
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="text-slate-400 border-b border-white/10">
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
            <tbody>
              {picks.map((p: any) => (
                <tr key={p.id} className="border-b border-white/5 hover:bg-white/5">
                  <td className="py-3 pr-4 text-slate-500">{p.rank}</td>
                  <td className="py-3 pr-4 font-semibold text-white">{p.symbol}</td>
                  <td className="py-3 pr-4">
                    <span className={`px-2 py-0.5 rounded border text-xs font-medium ${CONVICTION_COLOR[p.conviction]}`}>
                      {p.conviction}
                    </span>
                  </td>
                  <td className="py-3 pr-4 text-right text-slate-300">₹{p.entry_zone_low}–{p.entry_zone_high}</td>
                  <td className="py-3 pr-4 text-right text-rose-400">₹{p.stop_loss}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400">₹{p.target_1}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400">₹{p.target_2}</td>
                  <td className="py-3 pr-4 text-right text-emerald-400">₹{p.target_3}</td>
                  <td className="py-3 text-right">
                    <div className="flex items-center justify-end gap-2">
                      <div className="w-16 h-1.5 bg-white/10 rounded-full overflow-hidden">
                        <div className="h-full bg-purple-400 rounded-full" style={{ width: `${Math.min(p.composite_score, 100)}%` }} />
                      </div>
                      <span className="text-slate-300 w-8 text-right">{p.composite_score?.toFixed(0)}</span>
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
