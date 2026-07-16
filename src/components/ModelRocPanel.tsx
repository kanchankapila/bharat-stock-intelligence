import React, { useMemo } from 'react';
import { trpc } from '../lib/trpc';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend, CartesianGrid,
} from 'recharts';
import { Activity, Loader2, AlertTriangle } from 'lucide-react';

const FONT_MONO = 'ui-monospace, SFMono-Regular, Menlo, monospace';

// Regime -> line colour. BEAR is the only regime with a live edge, so it reads green.
const REGIME_COLOR: Record<string, string> = {
  OVERALL: '#6366f1', BEAR: '#10b981', SIDEWAYS: '#f59e0b', BULL: '#f43f5e', UNKNOWN: '#64748b',
};

type Roc = { fpr: number; tpr: number };
type RegimeRes = {
  regime: string; n: number; positives: number; negatives: number; baseRate: number; auc: number; roc: Roc[];
};

// Live ROC is a step function over FPR; interpolate onto a shared grid so every regime can be a
// line in one chart. Linear interpolation between bracketing points is fine for display.
function interpTpr(roc: Roc[], x: number): number {
  if (!roc.length) return 0;
  if (x <= roc[0].fpr) return roc[0].tpr;
  if (x >= roc[roc.length - 1].fpr) return roc[roc.length - 1].tpr;
  for (let i = 1; i < roc.length; i++) {
    if (roc[i].fpr >= x) {
      const a = roc[i - 1], b = roc[i];
      const t = b.fpr === a.fpr ? 0 : (x - a.fpr) / (b.fpr - a.fpr);
      return a.tpr + t * (b.tpr - a.tpr);
    }
  }
  return roc[roc.length - 1].tpr;
}

function verdict(auc: number): { label: string; cls: string } {
  if (auc >= 0.60) return { label: 'Tradeable edge', cls: 'text-emerald-400' };
  if (auc >= 0.55) return { label: 'Marginal',       cls: 'text-amber-400' };
  return { label: 'No live edge', cls: 'text-rose-400' };
}

export function ModelRocPanel() {
  const { data, isLoading } = trpc.getModelRocDiagnostics.useQuery(undefined, {
    staleTime: 5 * 60_000,
  });

  const chartData = useMemo(() => {
    if (!data?.regimes?.length) return [];
    const N = 51;
    const grid = Array.from({ length: N }, (_, i) => i / (N - 1));
    return grid.map((fpr) => {
      const row: Record<string, number> = { fpr, chance: fpr };
      for (const r of data.regimes as RegimeRes[]) row[r.regime] = interpTpr(r.roc, fpr);
      return row;
    });
  }, [data]);

  if (isLoading) {
    return (
      <div className="glass border border-slate-800/60 rounded-2xl p-5 h-80 flex flex-col items-center justify-center">
        <Loader2 className="w-6 h-6 text-indigo-400 animate-spin mb-2" />
        <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">Computing deployment ROC…</span>
      </div>
    );
  }
  if (!data || !data.regimes.length) {
    return (
      <div className="glass border border-slate-800/60 rounded-2xl p-5 h-80 flex items-center justify-center">
        <span className="text-[10px] text-slate-500 font-mono uppercase tracking-widest">No resolved WIN/LOSS signals to score yet</span>
      </div>
    );
  }

  const overall = (data.regimes as RegimeRes[]).find((r) => r.regime === 'OVERALL');
  const trainAuc = data.trainingAuc ?? null;
  const liveAuc = overall?.auc ?? null;
  const gap = trainAuc != null && liveAuc != null ? trainAuc - liveAuc : null;

  return (
    <div className="glass border border-slate-800/60 rounded-2xl p-5">
      <div className="flex justify-between items-start mb-4">
        <div>
          <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono flex items-center gap-2">
            <Activity className="w-4 h-4 text-indigo-400" /> Deployment ROC — win-probability vs realized outcome
          </h3>
          <p className="text-[9px] text-slate-500 font-bold uppercase mt-0.5 font-mono">
            How well the live win_probability ranks WIN over LOSS, per market regime · {(data.scoredTotal ?? 0).toLocaleString()} scored / {data.totalResolved.toLocaleString()} resolved
          </p>
        </div>
        <span className="text-[8px] font-black text-slate-400 bg-slate-800/40 px-2 py-0.5 rounded border border-slate-700/40 font-mono uppercase tracking-widest">
          Out-of-sample
        </span>
      </div>

      {/* Train -> live gap callout: the whole point of the panel */}
      <div className="grid grid-cols-3 gap-3 mb-5">
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-3">
          <span className="text-[8px] text-slate-500 block uppercase font-black font-mono tracking-widest">Training-CV AUC</span>
          <span className="text-xl font-black font-mono italic text-slate-300">{trainAuc != null ? trainAuc.toFixed(3) : '—'}</span>
          <span className="text-[8px] text-slate-500 block font-bold font-mono uppercase">
            ensemble {data.trainingModelVersion ? `v${data.trainingModelVersion}` : ''}
          </span>
        </div>
        <div className="bg-slate-900/40 border border-slate-800/60 rounded-xl p-3">
          <span className="text-[8px] text-slate-500 block uppercase font-black font-mono tracking-widest">Live overall AUC</span>
          <span className={`text-xl font-black font-mono italic ${liveAuc != null ? verdict(liveAuc).cls : 'text-slate-300'}`}>
            {liveAuc != null ? liveAuc.toFixed(3) : '—'}
          </span>
          <span className="text-[8px] text-slate-500 block font-bold font-mono uppercase">realized WIN/LOSS</span>
        </div>
        <div className="bg-rose-500/5 border border-rose-500/20 rounded-xl p-3">
          <span className="text-[8px] text-rose-400/80 block uppercase font-black font-mono tracking-widest flex items-center gap-1">
            <AlertTriangle className="w-3 h-3" /> Train → live gap
          </span>
          <span className="text-xl font-black font-mono italic text-rose-400">
            {gap != null ? `${gap >= 0 ? '−' : '+'}${Math.abs(gap).toFixed(3)}` : '—'}
          </span>
          <span className="text-[8px] text-slate-500 block font-bold font-mono uppercase">edge lost in deployment</span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-12 gap-5">
        {/* ROC curves */}
        <div className="lg:col-span-8 h-72">
          <ResponsiveContainer width="100%" height="100%">
            <LineChart data={chartData} margin={{ top: 8, right: 12, bottom: 4, left: -12 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#161b22" />
              <XAxis
                dataKey="fpr" type="number" domain={[0, 1]}
                tick={{ fill: '#64748b', fontSize: 9, fontFamily: FONT_MONO }}
                tickFormatter={(v: number) => v.toFixed(1)}
                label={{ value: 'False Positive Rate', position: 'insideBottom', offset: -2, fill: '#475569', fontSize: 8, fontFamily: FONT_MONO }}
              />
              <YAxis
                domain={[0, 1]} tick={{ fill: '#64748b', fontSize: 9, fontFamily: FONT_MONO }}
                tickFormatter={(v: number) => v.toFixed(1)}
              />
              <Tooltip
                contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #21262d', borderRadius: 8, fontSize: 10, fontFamily: FONT_MONO, color: '#f8fafc' }}
                formatter={(v: number, name: string) => [Number(v).toFixed(3), name]}
                labelFormatter={(v: number) => `FPR ${Number(v).toFixed(2)}`}
              />
              <Legend wrapperStyle={{ fontSize: 9, fontFamily: FONT_MONO, textTransform: 'uppercase' }} />
              {/* chance diagonal (AUC = 0.5) */}
              <Line type="monotone" dataKey="chance" name="Chance (0.50)" stroke="#475569" strokeDasharray="4 4" dot={false} strokeWidth={1} legendType="none" />
              {(data.regimes as RegimeRes[]).map((r) => (
                <Line
                  key={r.regime} type="monotone" dataKey={r.regime} name={r.regime}
                  stroke={REGIME_COLOR[r.regime] ?? '#94a3b8'} dot={false}
                  strokeWidth={r.regime === 'OVERALL' ? 2.5 : 1.75}
                />
              ))}
            </LineChart>
          </ResponsiveContainer>
        </div>

        {/* Per-regime AUC breakdown */}
        <div className="lg:col-span-4 space-y-2">
          {(data.regimes as RegimeRes[]).map((r) => {
            const v = verdict(r.auc);
            return (
              <div key={r.regime} className="p-3 bg-slate-900/30 border border-slate-800 rounded-xl">
                <div className="flex justify-between items-center">
                  <span className="text-[10px] font-black font-mono uppercase tracking-wider" style={{ color: REGIME_COLOR[r.regime] ?? '#94a3b8' }}>
                    {r.regime}
                  </span>
                  <span className={`text-sm font-black font-mono italic ${v.cls}`}>{r.auc.toFixed(3)}</span>
                </div>
                <div className="flex justify-between items-center mt-1">
                  <span className="text-[8px] text-slate-500 font-bold font-mono uppercase">
                    n={r.n.toLocaleString()} · base {(r.baseRate * 100).toFixed(0)}%
                  </span>
                  <span className={`text-[8px] font-black font-mono uppercase tracking-wider ${v.cls}`}>{v.label}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {!!data.unscoredRegimes?.length && (
        <div className="mt-4 flex flex-wrap items-center gap-2">
          <span className="text-[8px] font-black text-amber-400/80 uppercase font-mono tracking-widest">
            Unmeasured (regime occurred but model wasn't scoring):
          </span>
          {data.unscoredRegimes.map((u) => (
            <span key={u.regime} className="text-[8px] font-mono font-bold text-slate-400 bg-slate-800/40 border border-slate-700/40 px-2 py-0.5 rounded">
              {u.regime} · {u.count.toLocaleString()}
            </span>
          ))}
        </div>
      )}

      <p className="text-[8px] text-slate-600 font-bold uppercase mt-3 font-mono leading-relaxed">
        AUC 0.50 = coin flip. Only actually-scored signals are counted (unscored 0.5-default rows are
        excluded). The deployed probability ranks above chance in BEAR; SIDEWAYS is weak; regimes with
        no scored signals show as unmeasured, not tested. Read alongside the breakout classifier,
        which carries the real cross-sectional edge.
      </p>
    </div>
  );
}
