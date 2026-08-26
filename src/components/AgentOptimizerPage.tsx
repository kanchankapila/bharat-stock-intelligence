import { trpc } from '../lib/trpc';
import { RefreshCw, Settings } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';

export function AgentOptimizerPage() {
  const { data, isLoading, refetch } = trpc.getOptimizerReport.useQuery({ limit: 30 });
  const runMutation = trpc.runOptimizerAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const latest = data?.latest as any;
  const history = (data?.history as any[]) ?? [];
  const changes = latest ? JSON.parse(latest.changes_json || '{}') as Record<string, { before: number; after: number }> : {};
  const underperforming = latest ? JSON.parse(latest.underperforming_segments_json || '{}') : {};

  const chartData = [...history].reverse().map((h: any) => ({
    date: h.run_date?.slice(5),
    baseline: h.baseline_win_rate,
    new: h.new_win_rate,
  }));

  return (
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <Settings className="w-6 h-6 text-teal-400" /> Optimizer Agent
          </h1>
          {latest && <p className="text-sm text-slate-400 mt-1 font-data">Last run: {latest.run_date} · Trigger: {latest.trigger}</p>}
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

      {isLoading && <div className="v1-card p-6 text-sm text-slate-400 font-data animate-pulse">Loading optimizer report...</div>}

      {latest && (
        <>
          <div className="v1-card p-5">
            <p className="v1-title-card text-teal-300 mb-2">⚙️ Optimization Report</p>
            <p className="text-slate-100 text-sm leading-relaxed">{latest.narrative || 'No narrative.'}</p>
          </div>

          <div className="v1-grid-4">
            {[
              { label: 'Baseline Win Rate', value: `${latest.baseline_win_rate?.toFixed(1)}%` },
              { label: 'New Win Rate', value: `${latest.new_win_rate?.toFixed(1)}%` },
              { label: 'Weights Changed', value: latest.weights_changed ? `✓ ${Object.keys(changes).length} types` : '— none' },
              { label: 'Full Optimizer', value: latest.full_optimizer_triggered ? '🔄 Triggered' : '— not needed' },
            ].map(m => (
              <div key={m.label} className="v1-card p-4">
                <p className="v1-data-label">{m.label}</p>
                <p className="v1-data-value text-xl text-white mt-1">{m.value}</p>
              </div>
            ))}
          </div>

          {Object.keys(changes).length > 0 && (
            <div className="v1-card p-5 overflow-x-auto">
              <p className="v1-title-card mb-3">Weight Changes</p>
              <table className="w-full text-sm">
                <thead className="text-xs text-slate-400 border-b border-white/10 font-display uppercase tracking-wider">
                  <tr>
                    <th className="text-left py-2 pr-4">Signal Type</th>
                    <th className="text-right py-2 pr-4">Before</th>
                    <th className="text-right py-2 pr-4">After</th>
                    <th className="text-right py-2">Δ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-data text-xs">
                  {Object.entries(changes).map(([sig, { before, after }]) => {
                    const delta = after - before;
                    return (
                      <tr key={sig} className="hover:bg-white/5 transition-colors">
                        <td className="py-2 pr-4 text-slate-300 font-semibold">{sig}</td>
                        <td className="py-2 pr-4 text-right text-slate-400">{before.toFixed(3)}</td>
                        <td className="py-2 pr-4 text-right text-white font-bold">{after.toFixed(3)}</td>
                        <td className={`py-2 text-right font-bold ${delta > 0 ? 'text-emerald-400' : 'text-rose-400'}`}>
                          {delta > 0 ? '+' : ''}{delta.toFixed(3)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          )}

          {Object.keys(underperforming).length > 0 && (
            <div className="v1-card v1-card-down p-4">
              <p className="v1-title-card text-rose-300 mb-2">⚠️ Underperforming Timeframes</p>
              {Object.entries(underperforming).map(([tf, rate]: any) => (
                <p key={tf} className="text-xs text-slate-300 font-data">{tf}: {Number(rate).toFixed(1)}% win rate</p>
              ))}
            </div>
          )}
        </>
      )}

      {chartData.length > 1 && (
        <div className="v1-card p-5">
          <p className="v1-title-card mb-4">Win Rate Trend (30 days)</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#0a0b10', borderColor: 'rgba(255,255,255,0.1)', color: '#fff' }} />
              <Legend />
              <Line type="monotone" dataKey="baseline" stroke="#f97316" strokeWidth={2} dot={false} name="Baseline %" />
              <Line type="monotone" dataKey="new" stroke="#14b8a6" strokeWidth={2} dot={false} name="Post-Optimize %" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!latest && !isLoading && (
        <div className="v1-card p-6 text-slate-400 text-sm font-data">No optimizer runs yet. Run the agent after the auditor completes.</div>
      )}
    </div>
  );
}
