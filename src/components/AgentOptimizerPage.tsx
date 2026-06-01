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
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Settings className="w-6 h-6 text-teal-400" /> Optimizer Agent
          </h1>
          {latest && <p className="text-sm text-gray-400 mt-1">Last run: {latest.run_date} · Trigger: {latest.trigger}</p>}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-teal-600 hover:bg-teal-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      {isLoading && <p className="text-gray-400">Loading...</p>}

      {latest && (
        <>
          <div className="bg-teal-900/20 rounded-xl p-5 border border-teal-500/20">
            <p className="text-sm font-semibold text-teal-300 mb-2">⚙️ Optimization Report</p>
            <p className="text-white leading-relaxed">{latest.narrative || 'No narrative.'}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Baseline Win Rate', value: `${latest.baseline_win_rate?.toFixed(1)}%` },
              { label: 'New Win Rate', value: `${latest.new_win_rate?.toFixed(1)}%` },
              { label: 'Weights Changed', value: latest.weights_changed ? `✓ ${Object.keys(changes).length} types` : '— none' },
              { label: 'Full Optimizer', value: latest.full_optimizer_triggered ? '🔄 Triggered' : '— not needed' },
            ].map(m => (
              <div key={m.label} className="bg-white/5 rounded-xl p-4 border border-white/10">
                <p className="text-xs text-gray-400">{m.label}</p>
                <p className="text-lg font-bold text-white mt-1">{m.value}</p>
              </div>
            ))}
          </div>

          {Object.keys(changes).length > 0 && (
            <div className="bg-white/5 rounded-xl p-4 border border-white/10 overflow-x-auto">
              <p className="text-sm font-semibold text-gray-300 mb-3">Weight Changes</p>
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-white/10">
                    <th className="text-left py-2 pr-4">Signal Type</th>
                    <th className="text-right py-2 pr-4">Before</th>
                    <th className="text-right py-2 pr-4">After</th>
                    <th className="text-right py-2">Δ</th>
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(changes).map(([sig, { before, after }]) => {
                    const delta = after - before;
                    return (
                      <tr key={sig} className="border-b border-white/5">
                        <td className="py-2 pr-4 text-gray-300">{sig}</td>
                        <td className="py-2 pr-4 text-right text-gray-400">{before.toFixed(3)}</td>
                        <td className="py-2 pr-4 text-right text-white">{after.toFixed(3)}</td>
                        <td className={`py-2 text-right font-medium ${delta > 0 ? 'text-green-400' : 'text-red-400'}`}>
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
            <div className="bg-red-900/20 rounded-xl p-4 border border-red-500/20">
              <p className="text-sm font-semibold text-red-300 mb-2">⚠️ Underperforming Timeframes</p>
              {Object.entries(underperforming).map(([tf, rate]: any) => (
                <p key={tf} className="text-sm text-gray-300">{tf}: {Number(rate).toFixed(1)}% win rate</p>
              ))}
            </div>
          )}
        </>
      )}

      {chartData.length > 1 && (
        <div className="bg-white/5 rounded-xl p-4 border border-white/10">
          <p className="text-sm font-semibold text-gray-300 mb-4">Win Rate Trend (30 days)</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#9ca3af' }} />
              <Tooltip contentStyle={{ background: '#1f2937', border: '1px solid #374151' }} />
              <Legend />
              <Line type="monotone" dataKey="baseline" stroke="#f97316" strokeWidth={2} dot={false} name="Baseline %" />
              <Line type="monotone" dataKey="new" stroke="#14b8a6" strokeWidth={2} dot={false} name="Post-Optimize %" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}

      {!latest && !isLoading && (
        <p className="text-gray-500 text-sm">No optimizer runs yet. Run the agent after the auditor completes.</p>
      )}
    </div>
  );
}
