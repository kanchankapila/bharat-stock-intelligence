import { trpc } from '../lib/trpc';
import { RefreshCw, Database, AlertTriangle, CheckCircle } from 'lucide-react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from 'recharts';

const GRADE_COLOR: Record<string, string> = {
  A: 'text-emerald-400', B: 'text-indigo-400', C: 'text-yellow-400', D: 'text-rose-400',
};
const GRADE_BG: Record<string, string> = {
  A: 'bg-emerald-900/40', B: 'bg-indigo-900/40', C: 'bg-yellow-900/40', D: 'bg-rose-900/40',
};

export function AgentDataScientistPage() {
  const { data, isLoading, refetch } = trpc.getDataScientistReport.useQuery({ limit: 30 });
  const runMutation = trpc.runDataScientistAgent.useMutation({
    onSuccess: () => setTimeout(() => refetch(), 3000),
  });

  const latest = data?.latest as any;
  const history = (data?.history as any[]) ?? [];
  const issues = latest ? JSON.parse(latest.issues_json || '[]') as any[] : [];

  const chartData = [...history].reverse().map((h: any) => ({
    date: h.run_date?.slice(5),
    score: h.data_quality_score,
    auc: h.model_auc ? +(h.model_auc * 100).toFixed(1) : null,
  }));

  return (
    <div className="p-6 space-y-6 max-w-5xl mx-auto">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-white flex items-center gap-2">
            <Database className="w-6 h-6 text-indigo-400" /> Data Scientist Agent
          </h1>
          {latest && (
            <p className="text-sm text-slate-400 mt-1">
              Last run: {latest.run_date} · Grade:{' '}
              <span className={`font-bold ${GRADE_COLOR[latest.quality_grade]}`}>
                {latest.quality_grade}
              </span>
            </p>
          )}
        </div>
        <button
          onClick={() => runMutation.mutate()}
          disabled={runMutation.isPending}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 hover:bg-indigo-500 rounded-lg text-white text-sm disabled:opacity-50"
        >
          <RefreshCw className={`w-4 h-4 ${runMutation.isPending ? 'animate-spin' : ''}`} />
          Run Now
        </button>
      </div>

      {isLoading && <p className="text-slate-400">Loading...</p>}

      {latest && (
        <>
          <div className={`rounded-xl p-5 border border-white/10 ${GRADE_BG[latest.quality_grade]}`}>
            <p className="text-sm font-semibold text-slate-300 mb-2">🧠 Agent Analysis</p>
            <p className="text-white leading-relaxed">{latest.narrative || 'No narrative available.'}</p>
          </div>

          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            {[
              { label: 'Quality Score', value: `${latest.data_quality_score?.toFixed(0)}/100`, sub: `Grade ${latest.quality_grade}` },
              { label: 'OHLCV Coverage', value: `${latest.ohlcv_coverage_pct?.toFixed(1)}%`, sub: `${latest.stale_symbols_count} stale` },
              { label: 'Model AUC', value: latest.model_auc?.toFixed(3), sub: latest.model_drift_detected ? '⚠️ Drift detected' : '✓ Stable' },
              { label: 'Signal Resolution', value: `${latest.signal_resolution_rate?.toFixed(1)}%`, sub: 'outcomes resolved' },
            ].map(m => (
              <div key={m.label} className="v1-card p-4">
                <p className="text-xs text-slate-400">{m.label}</p>
                <p className="text-2xl font-bold text-white mt-1">{m.value}</p>
                <p className="text-xs text-slate-500 mt-1">{m.sub}</p>
              </div>
            ))}
          </div>

          {issues.length > 0 && (
            <div className="bg-white/5 rounded-xl p-4 border border-yellow-500/30">
              <p className="text-sm font-semibold text-yellow-400 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Issues Flagged
              </p>
              <ul className="space-y-2">
                {issues.map((iss: any, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-sm">
                    <span className={`px-2 py-0.5 rounded text-xs font-medium ${iss.severity === 'HIGH' ? 'bg-rose-900 text-rose-300' : 'bg-yellow-900 text-yellow-300'}`}>
                      {iss.severity}
                    </span>
                    <span className="text-slate-300">{iss.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {issues.length === 0 && (
            <div className="flex items-center gap-2 text-emerald-400 text-sm">
              <CheckCircle className="w-4 h-4" /> No issues flagged today
            </div>
          )}
        </>
      )}

      {chartData.length > 1 && (
        <div className="v1-card p-4">
          <p className="text-sm font-semibold text-slate-300 mb-4">30-Day Quality Score Trend</p>
          <ResponsiveContainer width="100%" height={160}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155' }} />
              <Line type="monotone" dataKey="score" stroke="#818cf8" strokeWidth={2} dot={false} name="Quality Score" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
