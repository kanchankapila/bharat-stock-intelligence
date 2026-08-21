import React, { useMemo } from 'react';
import {
  AreaChart, Area, XAxis, YAxis, ResponsiveContainer, Tooltip,
  PieChart as RePieChart, Pie, Cell,
} from 'recharts';
import { Activity, AlertCircle, Target } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// F&O tab.
export const V1OptionChain: React.FC<{ symbol: string; stockPrice: number }> = ({ symbol, stockPrice }) => {
  const { data: fnoSignals } = trpc.getFnOSignals.useQuery({ symbol });
  const { data: ocResponse, isLoading } = trpc.getOptionChain.useQuery({ symbol }, {
    refetchInterval: 30000
  });

  const ocData = ocResponse?.success ? ocResponse.data : null;
  const chain = ocData?.optionChain || [];

  const ivRank = ocData?.marketSentiment?.ivRank;
  const ivPercentile = ocData?.marketSentiment?.ivPercentile;
  const maxPain = ocData?.marketSentiment?.maxPain;

  // Portfolio-impact Greeks (Finding #73, 2026-07-28 audit): OI-weighted sum of each Greek
  // across the full chain — same real per-strike callDelta/callTheta/callVega/callGamma the
  // chart above already plots, not invented numbers.
  const portfolioGreeks = useMemo(() => {
    const totalOi = chain.reduce((s: number, r: any) => s + (r.callOi || 0) + (r.putOi || 0), 0);
    if (!totalOi) return { Delta: 0, Gamma: 0, Theta: 0, Vega: 0 };
    const weighted = (callKey: string, putKey: string) => chain.reduce((s: number, r: any) =>
      s + (r[callKey] || 0) * (r.callOi || 0) + (r[putKey] || 0) * (r.putOi || 0), 0) / totalOi;
    return {
      Delta: weighted('callDelta', 'putDelta'),
      Gamma: weighted('callGamma', 'putGamma'),
      Theta: weighted('callTheta', 'putTheta'),
      Vega:  weighted('callVega', 'putVega'),
    };
  }, [chain]);

  if (isLoading) {
    return (
      <div className="py-20 text-center glass-strong rounded-2xl border border-slate-800/50 border-dashed">
        <Activity className="w-8 h-8 text-blue-500 animate-spin mx-auto mb-4" />
        <p className="text-slate-400 font-bold font-display uppercase tracking-widest text-[10px]">Fetching real-time option chain...</p>
      </div>
    );
  }

  if (!ocData || chain.length === 0) {
    return (
      <div className="py-20 text-center glass-strong rounded-2xl border border-slate-800/50 border-dashed">
        <AlertCircle className="w-8 h-8 text-rose-500 mx-auto mb-4" />
        <h3 className="text-slate-300 font-black text-lg uppercase tracking-tighter italic">Option Chain Unavailable</h3>
        <p className="text-slate-400 text-[10px] uppercase font-bold tracking-widest mt-2">Could not retrieve F&O data for {symbol}</p>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* IV Section */}
      {/* F&O Sentiment Metrics */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">Max Pain Strike</p>
            <p className="text-2xl font-black text-slate-100 italic">₹{maxPain || '—'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Expiry Magnet</p>
          </div>
          <div className="p-3 bg-blue-500/10 rounded-xl">
             <Target className="w-5 h-5 text-blue-400" />
          </div>
        </div>

        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">IV Rank</p>
            <p className="text-2xl font-black text-slate-100 italic">{ivRank || 'N/A'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Volatility vs History</p>
          </div>
          <div className="w-12 h-12 relative opacity-50">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivRank || 1 }, { value: Math.max(0, 100 - (ivRank || 0)) }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill={ivRank ? "#3b82f6" : "#1e293b"} />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>

        <div className="p-4 glass border border-slate-800/50 rounded-2xl flex items-center justify-between">
          <div>
            <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">IV Percentile</p>
            <p className="text-2xl font-black text-emerald-400 italic">{ivPercentile ? `${ivPercentile}%` : 'N/A'}</p>
            <p className="text-[8px] text-slate-400 font-bold uppercase mt-1">Relative Volatility</p>
          </div>
          <div className="w-12 h-12 relative opacity-50">
            <ResponsiveContainer width="100%" height="100%">
              <RePieChart>
                <Pie
                  data={[{ value: ivPercentile || 1 }, { value: Math.max(0, 100 - (ivPercentile || 0)) }]}
                  innerRadius="80%"
                  outerRadius="100%"
                  paddingAngle={0}
                  dataKey="value"
                  startAngle={90}
                  endAngle={-270}
                >
                  <Cell fill={ivPercentile ? "#10b981" : "#1e293b"} />
                  <Cell fill="#1e293b" />
                </Pie>
              </RePieChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* Option Chain Table */}
      <div className="overflow-x-auto rounded-2xl border border-slate-800/50 glass-strong/50">
        <table className="w-full text-left border-collapse min-w-[1200px]">
          <thead>
            <tr className="glass">
              <th colSpan={5} className="px-4 py-2 text-center text-[10px] font-black uppercase text-blue-500 border-b border-slate-800/50">Calls</th>
              <th className="px-4 py-2 text-center text-[10px] font-black uppercase text-slate-400 border-b border-slate-800/50">Strike</th>
              <th colSpan={5} className="px-4 py-2 text-center text-[10px] font-black uppercase text-rose-500 border-b border-slate-800/50">Puts</th>
            </tr>
            <tr className="glass/50">
              {['Buildup', 'OI', 'Delta', 'IV', 'LTP'].map(h => (
                <th key={`c-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">{h}</th>
              ))}
              <th className="px-3 py-3 text-[8px] font-black uppercase text-slate-200 tracking-widest text-center bg-slate-800">Price</th>
              {['LTP', 'IV', 'Delta', 'OI', 'Buildup'].map(h => (
                <th key={`p-${h}`} className="px-3 py-3 text-[8px] font-black uppercase text-slate-400 tracking-widest text-center">{h}</th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {chain.map((row: any) => {
              const strike = row.strikePrice;
              const isAtTheMoney = Math.abs(stockPrice - strike) < (stockPrice * 0.005);

              return (
                <tr key={strike} className={cn(
                  "hover:bg-slate-900/40 transition-colors text-center",
                  isAtTheMoney && "bg-blue-600/5"
                )}>
                  {/* CALLS */}
                  <td className={cn(
                    "px-3 py-4 text-[8px] font-black uppercase",
                    row.callBuiltup?.includes('Long') ? "text-emerald-400" : row.callBuiltup?.includes('Short') ? "text-rose-400" : "text-slate-400"
                  )}>{row.callBuiltup}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{(row.callOi/1000).toFixed(1)}k</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-emerald-400">{row.callDelta?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{row.callIv?.toFixed(1)}%</td>
                  <td className="px-3 py-4 text-[10px] font-black text-white tabular-nums">₹{row.callLtp?.toFixed(2)}</td>

                  {/* STRIKE */}
                  <td className="px-3 py-4 text-xs font-black text-white bg-slate-800/30 border-x border-slate-800/50 tabular-nums">₹{strike}</td>

                  {/* PUTS */}
                  <td className="px-3 py-4 text-[10px] font-black text-white tabular-nums">₹{row.putLtp?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{row.putIv?.toFixed(1)}%</td>
                  <td className="px-3 py-4 text-[10px] font-bold text-rose-400">{row.putDelta?.toFixed(2)}</td>
                  <td className="px-3 py-4 text-[10px] font-medium text-slate-400">{(row.putOi/1000).toFixed(1)}k</td>
                  <td className={cn(
                    "px-3 py-4 text-[8px] font-black uppercase",
                    row.putBuiltup?.includes('Long') ? "text-emerald-400" : row.putBuiltup?.includes('Short') ? "text-rose-400" : "text-slate-400"
                  )}>{row.putBuiltup}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      <Card title="Greeks Analysis (Portfolio Impact)" icon={Activity}>
        <div className="h-64">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={chain.map(row => ({
              strike: row.strikePrice,
              delta: row.callDelta || 0,
              theta: Math.abs(row.callTheta || 0) / 10, // normalized
              vega: (row.callVega || 0) * 5 // scaled
            }))}>
              <XAxis dataKey="strike" hide />
              <YAxis hide />
              <Tooltip
                contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px' }}
                itemStyle={{ fontSize: '11px', fontWeight: 'bold' }}
              />
              <Area type="monotone" dataKey="delta" stroke="#10b981" fill="#10b981" fillOpacity={0.1} name="Delta" />
              <Area type="monotone" dataKey="theta" stroke="#f43f5e" fill="#f43f5e" fillOpacity={0.1} name="Theta" />
              <Area type="monotone" dataKey="vega" stroke="#3b82f6" fill="#3b82f6" fillOpacity={0.1} name="Vega" />
            </AreaChart>
          </ResponsiveContainer>
        </div>
        <div className="grid grid-cols-4 gap-4 mt-6">
           {['Delta', 'Gamma', 'Theta', 'Vega'].map(g => (
             <div key={g} className="text-center p-3 glass-strong rounded-xl border border-slate-800/50">
                <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">{g}</p>
                <div className={cn(
                  "h-1 rounded-full mb-1",
                  g === 'Delta' ? 'bg-emerald-500' : g === 'Theta' ? 'bg-rose-500' : 'bg-blue-500'
                )} />
                <p className="text-[10px] font-bold text-slate-300">
                  {portfolioGreeks[g as keyof typeof portfolioGreeks].toFixed(g === 'Gamma' ? 4 : 2)}
                </p>
             </div>
           ))}
        </div>
      </Card>
    </div>
  );
};

export default V1OptionChain;
