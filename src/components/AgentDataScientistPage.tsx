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
  const { data: triggerErrors, refetch: refetchTriggerErrors } = trpc.getAgentTriggerErrors.useQuery();
  const runMutation = trpc.runDataScientistAgent.useMutation({
    onSuccess: () => setTimeout(() => { refetch(); refetchTriggerErrors(); }, 3000),
  });
  const triggerError = (triggerErrors as any)?.data_scientist;

  const latest = data?.latest as any;
  const history = (data?.history as any[]) ?? [];
  const issues = latest ? JSON.parse(latest.issues_json || '[]') as any[] : [];

  const chartData = [...history].reverse().map((h: any) => ({
    date: h.run_date?.slice(5),
    score: h.data_quality_score,
    auc: h.model_auc ? +(h.model_auc * 100).toFixed(1) : null,
  }));

  return (
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <Database className="w-6 h-6 text-indigo-400" /> Data Scientist Agent
          </h1>
          {latest && (
            <p className="text-sm text-slate-400 mt-1 font-data">
              Last run: {latest.run_date} · Grade:{' '}
              <span className={`font-bold ${GRADE_COLOR[latest.quality_grade]}`}>
                {latest.quality_grade}
              </span>
            </p>
          )}
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

      {isLoading && <div className="v1-card p-6 text-sm text-slate-400 font-data animate-pulse">Loading Agent Report...</div>}

      {latest && (
        <>
          <div className={`v1-card p-5 ${GRADE_BG[latest.quality_grade]}`}>
            <p className="v1-title-card text-slate-300 mb-2">🧠 Agent Analysis</p>
            <p className="text-slate-100 text-sm leading-relaxed">{latest.narrative || 'No narrative available.'}</p>
          </div>

          <div className="v1-grid-4">
            {[
              { label: 'Quality Score', value: `${latest.data_quality_score?.toFixed(0)}/100`, sub: `Grade ${latest.quality_grade}` },
              { label: 'OHLCV Coverage', value: `${latest.ohlcv_coverage_pct?.toFixed(1)}%`, sub: `${latest.stale_symbols_count} stale` },
              { label: 'Model AUC', value: latest.model_auc?.toFixed(3), sub: latest.model_drift_detected ? '⚠️ Drift detected' : '✓ Stable' },
              { label: 'Signal Resolution', value: `${latest.signal_resolution_rate?.toFixed(1)}%`, sub: 'outcomes resolved' },
            ].map(m => (
              <div key={m.label} className="v1-card p-4">
                <p className="v1-data-label">{m.label}</p>
                <p className="v1-data-value text-xl text-white mt-1">{m.value}</p>
                <p className="text-xs text-slate-400 font-data mt-1">{m.sub}</p>
              </div>
            ))}
          </div>

          {issues.length > 0 && (
            <div className="v1-card v1-card-neutral p-4">
              <p className="v1-title-card text-amber-400 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4" /> Issues Flagged
              </p>
              <ul className="space-y-2">
                {issues.map((iss: any, i: number) => (
                  <li key={i} className="flex items-start gap-2 text-xs font-data">
                    <span className={`px-2 py-0.5 rounded text-[10px] font-bold ${iss.severity === 'HIGH' ? 'bg-rose-900/60 text-rose-300' : 'bg-amber-900/60 text-amber-300'}`}>
                      {iss.severity}
                    </span>
                    <span className="text-slate-300">{iss.issue}</span>
                  </li>
                ))}
              </ul>
            </div>
          )}
          {issues.length === 0 && (
            <div className="v1-card v1-card-up p-4 flex items-center gap-2 text-emerald-400 text-xs font-semibold">
              <CheckCircle className="w-4 h-4" /> No issues flagged today
            </div>
          )}
        </>
      )}

      {chartData.length > 1 && (
        <div className="v1-card p-5">
          <p className="v1-title-card mb-4">30-Day Quality Score Trend</p>
          <ResponsiveContainer width="100%" height={180}>
            <LineChart data={chartData}>
              <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis domain={[0, 100]} tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip contentStyle={{ background: '#0a0b10', borderColor: 'rgba(255,255,255,0.1)', color: '#fff' }} />
              <Line type="monotone" dataKey="score" stroke="#6366f1" strokeWidth={2} dot={false} name="Quality Score" />
            </LineChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  );
}
