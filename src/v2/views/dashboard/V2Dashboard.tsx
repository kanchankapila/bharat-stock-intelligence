import React from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { 
  TrendingUp, TrendingDown, Activity, Cpu, ShieldAlert, BarChart3, 
  Layers, CheckCircle, RefreshCw 
} from 'lucide-react';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, Tooltip, CartesianGrid, AreaChart, Area } from 'recharts';

export const V2Dashboard: React.FC = () => {
  const { data: dashboardData, isLoading: loadingDash, isError: errorDash, refetch: refetchDash } = trpc.getPerformanceDashboard.useQuery() as { data: any; isLoading: boolean; isError: boolean; refetch: () => void };
  const { data: fiiDiiData, isLoading: loadingFii, isError: errorFii, refetch: refetchFii } = trpc.getFiiDiiFlow.useQuery({ days: 10 });
  const { data: featImportance } = trpc.getFeatureImportance.useQuery({ modelName: 'ensemble', topN: 8 });

  if (loadingDash || loadingFii) {
    return (
      <div className="py-20 flex flex-col items-center justify-center">
        <Activity className="w-12 h-12 text-indigo-500/20 animate-pulse mb-4" />
        <p className="text-slate-400 text-xs font-black uppercase tracking-widest animate-pulse">Syncing Quantitative Data Feeds...</p>
      </div>
    );
  }

  // A real query failure previously fell straight through to empty-state rendering,
  // indistinguishable from "no data yet" — surface it and let the user retry.
  if (errorDash || errorFii) {
    return (
      <div className="py-20 flex flex-col items-center justify-center gap-3">
        <ShieldAlert className="w-10 h-10 text-rose-500/60" />
        <p className="text-rose-400 text-xs font-black uppercase tracking-widest">Failed to load dashboard data.</p>
        <button
          onClick={() => { refetchDash(); refetchFii(); }}
          className="text-[10px] px-3 py-1.5 rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 uppercase tracking-widest font-bold"
        >
          Retry
        </button>
      </div>
    );
  }

  // Process FII/DII Flow Chart Data
  const flowChartData = (fiiDiiData ?? []).slice().reverse().map((f: any) => ({
    date: f.date,
    FII: f.fii_net ?? 0,
    DII: f.dii_net ?? 0,
  }));

  // Process Feature Importance Data
  const featureChartData = (featImportance ?? []).map((f: any) => ({
    name: f.feature_name.replace('_', ' ').toUpperCase(),
    Weight: f.importance * 100,
  }));

  return (
    <div className="space-y-6">
      {/* Dynamic Header Metrics Grid */}
      <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
        <div className="p-4 bg-terminal-panel border border-terminal-border rounded-2xl relative overflow-hidden">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Ensemble Prediction Quality</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-200 font-mono italic">
              {dashboardData?.overall?.win_rate != null ? `${(dashboardData.overall.win_rate * 100).toFixed(1)}%` : '—'}
            </span>
            <span className="text-[9px] text-emerald-400 font-bold font-mono">Win Rate</span>
          </div>
          <div className="w-full h-1 bg-slate-800 rounded-full mt-3 overflow-hidden">
            <div 
              className="h-full bg-indigo-500" 
              style={{ width: `${dashboardData?.overall?.win_rate != null ? dashboardData.overall.win_rate * 100 : 0}%` }}
            />
          </div>
        </div>

        <div className="p-4 bg-terminal-panel border border-terminal-border rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Sharpe Ratio (1Y Ann.)</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-200 font-mono italic">
              {dashboardData?.overall?.sharpe_ratio != null ? dashboardData.overall.sharpe_ratio.toFixed(2) : '—'}
            </span>
            <span className="text-[9px] text-indigo-400 font-bold uppercase tracking-wider">Alpha Grade</span>
          </div>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-2">Annualized portfolio metric</p>
        </div>

        <div className="p-4 bg-terminal-panel border border-terminal-border rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Active Trading Signals</p>
          <div className="flex items-baseline gap-2">
            <span className="text-2xl font-black text-slate-200 font-mono italic">
              {dashboardData?.overall?.total_signals != null ? dashboardData.overall.total_signals : '—'}
            </span>
            <span className="text-[9px] text-slate-400 font-bold uppercase">Gated rules</span>
          </div>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-2">Active database counts</p>
        </div>

        <div className="p-4 bg-terminal-panel border border-terminal-border rounded-2xl">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">Alpha vs Nifty 50</p>
          <div className="flex items-baseline gap-2">
            <span className={cn(
              "text-2xl font-black font-mono italic",
              dashboardData?.overall?.alpha_vs_nifty == null ? "text-slate-500" :
                dashboardData.overall.alpha_vs_nifty >= 0 ? "text-emerald-400" : "text-rose-400"
            )}>
              {dashboardData?.overall?.alpha_vs_nifty != null
                ? `${dashboardData.overall.alpha_vs_nifty >= 0 ? '+' : ''}${dashboardData.overall.alpha_vs_nifty.toFixed(2)}%`
                : '—'}
            </span>
            <span className="text-[9px] text-slate-400 font-bold uppercase">Excess Outperformance</span>
          </div>
          <p className="text-[8px] text-slate-400 font-bold uppercase mt-2">
            {dashboardData?.overall?.alpha_vs_nifty != null ? 'From strategy_performance' : 'Not yet computed'}
          </p>
        </div>
      </div>

      {/* Main Analysis Visual Grids */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* FII/DII Net Cash Flow Chart (8 Cols) */}
        <div className="lg:col-span-8 p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-4">
          <div className="flex justify-between items-center">
            <div>
              <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">FII & DII Daily Flow Matrix</h3>
              <p className="text-[9px] text-slate-500 font-medium">Net buying / selling flows in Indian Markets (Cr)</p>
            </div>
            <span className="text-[9px] font-black text-slate-400 bg-terminal-panel-header px-2 py-0.5 border border-terminal-border rounded">REAL-TIME DB SYNC</span>
          </div>

          <div className="h-64">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={flowChartData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#161b22" vertical={false} />
                <XAxis dataKey="date" tick={{ fill: '#64748b', fontSize: 9 }} />
                <YAxis tick={{ fill: '#64748b', fontSize: 9 }} />
                <Tooltip contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #21262d' }} />
                <Bar dataKey="FII" fill="#f43f5e" radius={[2, 2, 0, 0]} name="FII Net" />
                <Bar dataKey="DII" fill="#10b981" radius={[2, 2, 0, 0]} name="DII Net" />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>

        {/* Feature Importance Heatmap (4 Cols) */}
        <div className="lg:col-span-4 p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-4">
          <div>
            <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Model Feature Importances</h3>
            <p className="text-[9px] text-slate-500 font-medium">Weights calculated from latest training epoch</p>
          </div>

          {featureChartData.length > 0 ? (
            <div className="h-64">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={featureChartData} layout="vertical">
                  <CartesianGrid strokeDasharray="3 3" stroke="#161b22" horizontal={false} />
                  <XAxis type="number" hide />
                  <YAxis dataKey="name" type="category" tick={{ fill: '#94a3b8', fontSize: 7 }} width={100} />
                  <Tooltip contentStyle={{ backgroundColor: '#0d1117', border: '1px solid #21262d' }} />
                  <Bar dataKey="Weight" fill="#8a2be2" radius={[0, 2, 2, 0]} name="Weight %" />
                </BarChart>
              </ResponsiveContainer>
            </div>
          ) : (
            <div className="h-64 flex items-center justify-center border border-dashed border-terminal-border rounded-xl">
              <span className="text-[10px] text-slate-500 uppercase tracking-widest font-mono">No features loaded</span>
            </div>
          )}
        </div>
      </div>

      {/* Model Registry and Strategy Performance Grid */}
      <div className="grid grid-cols-1 lg:grid-cols-12 gap-6">
        {/* ML Registry (6 Cols) */}
        <div className="lg:col-span-6 p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-4">
          <div className="flex items-center gap-2">
            <Cpu className="w-4 h-4 text-indigo-400" />
            <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Active Model Registry</h3>
          </div>
          
          <div className="space-y-3">
            {((dashboardData as any)?.latestModel || []).map((m: any, i: number) => (
              <div key={i} className="p-3 bg-terminal-panel-header/50 border border-terminal-border rounded-xl flex justify-between items-center">
                <div>
                  <h4 className="text-xs font-black text-slate-200 uppercase font-mono">{m.model_name}</h4>
                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{m.model_type}</p>
                </div>
                <div className="text-right">
                  <span className="text-xs font-black text-indigo-400 font-mono">AUC: {m.cv_roc_auc != null ? m.cv_roc_auc.toFixed(3) : 'N/A'}</span>
                  <p className="text-[8px] text-slate-500 uppercase font-bold mt-0.5">{m.training_samples} samples trained</p>
                </div>
              </div>
            ))}
          </div>
        </div>

        {/* Strategy Performance (6 Cols) */}
        <div className="lg:col-span-6 p-6 bg-terminal-panel border border-terminal-border rounded-2xl space-y-4">
          <div className="flex items-center gap-2">
            <Layers className="w-4 h-4 text-emerald-400" />
            <h3 className="text-xs font-black text-slate-200 uppercase tracking-wider font-mono">Top Performance Metrics</h3>
          </div>

          <div className="space-y-3">
            {((dashboardData as any)?.topSignals || []).map((s: any, i: number) => (
              <div key={i} className="p-3 bg-terminal-panel-header/50 border border-terminal-border rounded-xl flex justify-between items-center">
                <div>
                  <h4 className="text-xs font-bold text-slate-200 uppercase">{s.strategy_name.replace('_', ' ')}</h4>
                  <p className="text-[9px] text-slate-400 font-bold uppercase tracking-wider mt-0.5">{s.total_signals} total signals</p>
                </div>
                <div className="text-right">
                  <span className="text-xs font-black text-emerald-400 font-mono">{(s.win_rate * 100).toFixed(1)}% WR</span>
                  <p className="text-[8px] text-slate-500 uppercase font-bold mt-0.5">Sharpe: {s.sharpe_ratio != null ? s.sharpe_ratio.toFixed(2) : 'N/A'}</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
};
