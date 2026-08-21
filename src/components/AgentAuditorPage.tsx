import { useState } from 'react';
import { trpc } from '../lib/trpc';
import { RefreshCw, BarChart2 } from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Cell } from 'recharts';

type Timeframe = 'intraday' | 'swing' | 'positional' | 'investment';
const TF_LABELS: Record<Timeframe, string> = {
  intraday: 'Intraday', swing: 'Swing', positional: 'Positional', investment: 'Investment',
};

export function AgentAuditorPage() {
  const [tf, setTf] = useState<Timeframe>('swing');
  const { data, isLoading, refetch } = trpc.getAuditReport.useQuery({ timeframe: tf });
  const runMutation = trpc.runAuditorAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const report = (data?.reports as any[])?.[0];
  const attribution = report ? JSON.parse(report.signal_attribution_json || '{}') as Record<string, number> : {};
  const attrData = Object.entries(attribution)
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)
    .map(([sig, wr]) => ({ sig: sig.slice(0, 16), wr: +wr.toFixed(1) }));

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="v1-title-page flex items-center gap-2">
            <BarChart2 className="w-6 h-6 text-orange-400" /> Auditor Agent
          </h1>
          {report && <p className="text-sm text-slate-400 mt-1">Auditing picks from: {report.audit_for_date}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-orange-600 hover:bg-orange-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      <div className="flex gap-2">
        {(Object.keys(TF_LABELS) as Timeframe[]).map(t => (
          <button key={t} onClick={() => setTf(t)}
            className={`px-4 py-2 rounded-lg text-sm font-medium transition-colors ${
              tf === t ? 'bg-orange-600 text-white' : 'bg-white/5 text-slate-400 hover:bg-white/10'
            }`}>
            {TF_LABELS[t]}
          </button>
        ))}
      </div>

      {isLoading && <p className="text-slate-400">Loading audit...</p>}

      {report && (
        <>
          <div className="bg-orange-900/20 rounded-xl p-5 border border-orange-500/20">
            <p className="text-sm font-semibold text-orange-300 mb-2">📋 Audit Report — {TF_LABELS[tf]}</p>
            <p className="text-white leading-relaxed">{report.narrative || 'No narrative.'}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Hit Rate', value: `${report.hit_rate?.toFixed(0)}%`, color: report.hit_rate >= 60 ? 'text-emerald-400' : 'text-rose-400' },
              { label: 'Avg Return', value: `${report.avg_return_pct >= 0 ? '+' : ''}${report.avg_return_pct?.toFixed(2)}%`, color: report.avg_return_pct >= 0 ? 'text-emerald-400' : 'text-rose-400' },
              { label: 'Alpha vs Nifty', value: `${report.alpha_pct >= 0 ? '+' : ''}${report.alpha_pct?.toFixed(2)}%`, color: report.alpha_pct >= 0 ? 'text-emerald-400' : 'text-rose-400' },
              { label: 'Profit Factor', value: report.profit_factor?.toFixed(2), color: report.profit_factor >= 1.5 ? 'text-emerald-400' : 'text-yellow-400' },
            ].map(m => (
              <div key={m.label} className="v1-card p-4">
                <p className="v1-data-label">{m.label}</p>
                <p className={`v1-data-value mt-1 ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          <div className="grid grid-cols-3 gap-4 text-center">
            {[
              { label: '✅ Hits', value: report.hits, color: 'text-emerald-400' },
              { label: '❌ Misses', value: report.misses, color: 'text-rose-400' },
              { label: '⏳ Open', value: report.open_positions, color: 'text-yellow-400' },
            ].map(m => (
              <div key={m.label} className="v1-card p-4">
                <p className="v1-data-label">{m.label}</p>
                <p className={`v1-data-value mt-1 ${m.color}`}>{m.value}</p>
              </div>
            ))}
          </div>

          {attrData.length > 0 && (
            <div className="v1-card p-4">
              <p className="v1-title-card mb-4">Signal Attribution (Win Rate %)</p>
              <ResponsiveContainer width="100%" height={160}>
                <BarChart data={attrData} layout="vertical">
                  <XAxis type="number" domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} />
                  <YAxis type="category" dataKey="sig" tick={{ fontSize: 10, fill: '#94a3b8' }} width={100} />
                  <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
                  <Bar dataKey="wr" name="Win Rate %">
                    {attrData.map((entry, i) => (
                      <Cell key={i} fill={entry.wr >= 60 ? '#34d399' : entry.wr >= 45 ? '#facc15' : '#fb7185'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          )}
        </>
      )}
      {!report && !isLoading && (
        <p className="text-slate-500 text-sm">No audit data for {TF_LABELS[tf]} yet. Run the agent after market close.</p>
      )}
    </div>
  );
}
