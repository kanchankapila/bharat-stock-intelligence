import React from 'react';
import {
  BarChart, Bar, XAxis, YAxis, ResponsiveContainer, Tooltip, CartesianGrid,
} from 'recharts';
import { motion } from 'motion/react';
import { Filter, Activity, TrendingUp, PieChart, History, BarChart3 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// Fundamentals tab.
export const V1FundamentalInsights: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: unifiedData, isLoading: loadingUnified } = trpc.getAlphaQuantDetail.useQuery({ symbol });
  const { data: funds, isLoading: loadingFunds } = trpc.getTrendlyneFundamentals.useQuery({ symbol });
  const { data: actions, isLoading: loadingActions } = trpc.getCorporateActions.useQuery({ symbol });

  if (loadingUnified || loadingFunds || loadingActions) return <div className="p-20 text-center animate-pulse text-slate-400">Auditing financials...</div>;

  // Extract ratios from consolidated data
  const ratioItems = (unifiedData as any)?.ratios?.item || [];
  const detailedInsights = (unifiedData as any)?.detailedInsights;

  const getRatio = (name: string, fallbackNames: string[] = []) => {
    const allNames = [name, ...fallbackNames].map(n => n.toLowerCase().replace(/[^a-z0-9]/g, ''));

    // 1. Try primary ratios items
    const row = ratioItems.find((r: any) => {
      const label = (r.label || "").toLowerCase().replace(/[^a-z0-9]/g, '');
      return allNames.some(an => label.includes(an));
    });
    if (row && row.value !== undefined) return row.value;

    // 2. Try industry comparison in detailed insights
    const icRow = detailedInsights?.industryComparison?.find((ic: any) => {
      const title = (ic.title || "").toLowerCase().replace(/[^a-z0-9]/g, '');
      return allNames.some(an => title.includes(an));
    });
    if (icRow && icRow.value !== undefined) return icRow.value;

    // 3. Try Tradebrains key metrics fallback
    const tbMetrics = (unifiedData as any)?.tradebrains?.keyMetrics;
    if (tbMetrics) {
      // Direct match or include
      const tbEntry = Object.entries(tbMetrics).find(([k, v]) => {
        const key = k.toLowerCase().replace(/[^a-z0-9]/g, '');
        return allNames.some(an => key.includes(an) || an.includes(key));
      });
      if (tbEntry && tbEntry[1] !== undefined && tbEntry[1] !== null) return tbEntry[1];
    }

    return 'N/A';
  };

  const displayRatios = [
    { label: 'Debt/Equity', name: 'debt/equity', fallbacks: ['debt equity', 'debt to equity', 'gearing'], icon: Filter },
    { label: 'Current Ratio', name: 'current ratio', fallbacks: ['current'], icon: Activity },
    { label: 'Quick Ratio', name: 'quick ratio', fallbacks: ['quick'], icon: Activity },
    { label: 'Interest Coverage', name: 'interest coverage', fallbacks: ['interest coverage ratio'], icon: Activity },
    { label: 'ROE %', name: 'roe', fallbacks: ['return on equity', 'roe %'], icon: Activity },
    { label: 'P/E Ratio', name: 'p/e ratio', fallbacks: ['ttm pe ratio', 'pe'], icon: Activity },
    { label: 'P/B Ratio', name: 'p/b ratio', fallbacks: ['price to book ratio', 'pb'], icon: TrendingUp },
  ];

  // Extract shareholding from consolidated data
  const shPattern = (unifiedData as any)?.shareholdingPattern;
  let promoters = 0, fii = 0, dii = 0, publicHolding = 0, pledging = '0.00';

  if (shPattern?.list) {
    const findVal = (name: string) => parseFloat(shPattern.list.find((i: any) => i.name?.includes(name))?.value) || 0;
    promoters = findVal('Promoter');
    fii = findVal('FII');
    dii = findVal('DII');
    publicHolding = findVal('Public');
    pledging = shPattern.promoterPledging || '0.00';
  }

  const corpActions = (actions as any)?.corporate_actions || [];

  return (
    <div className="space-y-6">
       {/* Financial Ratios Section */}
       <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
          {displayRatios.map(ratio => (
            <div key={ratio.label} className="p-4 glass border border-slate-800/50 rounded-2xl">
               <div className="flex justify-between items-start mb-2">
                  <ratio.icon className="w-4 h-4 text-blue-400" />
                  <span className="text-[8px] font-black text-slate-400 font-display uppercase tracking-widest border border-slate-800/50 px-1.5 py-0.5 rounded">Ratios</span>
               </div>
               <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">{ratio.label}</p>
               <p className="text-xl font-black text-white italic tracking-tighter mt-1">{getRatio(ratio.name, (ratio as any).fallbacks)}</p>
            </div>
          ))}
       </div>

       <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Shareholding Pattern Visual */}
          <Card title="Shareholding Pattern" icon={PieChart}>
             <div className="space-y-4 mt-2">
                {[
                  { type: 'Promoter', val: promoters },
                  { type: 'FII', val: fii },
                  { type: 'DII', val: dii },
                  { type: 'Public', val: publicHolding }
                ].map(item => (
                  <div key={item.type} className="space-y-1.5">
                    <div className="flex justify-between text-[10px] font-black font-display uppercase tracking-widest">
                       <span className="text-slate-400">{item.type}</span>
                       <span className="text-white">{item.val}%</span>
                    </div>
                    <div className="h-1.5 glass-strong rounded-full overflow-hidden border border-slate-800/20">
                       <motion.div
                          initial={{ width: 0 }}
                          animate={{ width: `${item.val}%` }}
                          className="h-full bg-blue-500 shadow-[0_0_10px_rgba(59,130,246,0.5)]"
                       />
                    </div>
                  </div>
                ))}
                <p className="text-[9px] text-slate-400 italic mt-4 font-bold text-center uppercase tracking-tighter">
                  Promoter pledging: {pledging}%
                </p>
             </div>
          </Card>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          {/* Corporate Actions */}
          <Card title="Corporate Actions" icon={History}>
             <div className="space-y-3 mt-2 max-h-[250px] overflow-y-auto pr-2 custom-scrollbar">
                {corpActions.length > 0 ? corpActions.map((action: any, i: number) => (
                  <div key={i} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30 hover:border-slate-800/30 transition-colors">
                     <div>
                        <p className="text-[10px] font-black text-blue-500 font-display uppercase tracking-widest">{action.purpose || 'Action'}</p>
                        <p className="text-xs font-bold text-slate-200 mt-0.5">{action.details || 'N/A'}</p>
                     </div>
                     <span className="text-[9px] font-black text-slate-400 glass px-2 py-1 rounded">
                       {action.date || action.ex_date || 'TBA'}
                     </span>
                  </div>
                )) : (
                  <p className="text-center py-10 text-slate-400 italic text-xs font-bold font-display uppercase tracking-widest">No recent actions recorded</p>
                )}
             </div>
          </Card>
       </div>

       {(() => {
          // Use real quarterly data from Trendlyne fundamentals if available
          const quarterlyRows: any[] = (funds as any)?.data?.financials?.quarterly?.revenue ?? [];
          const profitRows: any[] = (funds as any)?.data?.financials?.quarterly?.profit ?? [];
          if (quarterlyRows.length === 0 && profitRows.length === 0) return null;
          const chartData = quarterlyRows.slice(-6).map((r: any, i: number) => ({
            q: r.period || `Q${i + 1}`,
            revenue: r.value ?? 0,
            profit: profitRows[i]?.value ?? 0,
          }));
          return (
            <Card title="Quarterly Performance" icon={BarChart3}>
               <div className="h-64 mt-4">
                  <ResponsiveContainer width="100%" height="100%">
                     <BarChart data={chartData}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="q" tick={{ fill: '#64748b', fontSize: 10 }} />
                        <YAxis hide />
                        <Tooltip contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b' }} />
                        <Bar dataKey="revenue" fill="#3b82f6" radius={[4, 4, 0, 0]} name="Revenue" />
                        <Bar dataKey="profit" fill="#10b981" radius={[4, 4, 0, 0]} name="Profit" />
                     </BarChart>
                  </ResponsiveContainer>
               </div>
            </Card>
          );
       })()}
    </div>
  );
};

export default V1FundamentalInsights;
