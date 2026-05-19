import React, { useState, useMemo } from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { 
  Zap, TrendingUp, TrendingDown, Target, ShieldAlert,
  Flame, Filter, Activity, BarChart2
} from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

interface V3FnoIntelligenceWidgetProps {
  onSelectStock: (symbol: string) => void;
}

const scanners = {
  futures: [
    { id: 'long-build-up',    name: 'Long Buildup',    icon: TrendingUp,   sentiment: 'bullish' },
    { id: 'short-build-up',   name: 'Short Buildup',   icon: TrendingDown, sentiment: 'bearish' },
    { id: 'short-covering',   name: 'Short Covering',  icon: Zap,          sentiment: 'bullish' },
    { id: 'long-unwinding',   name: 'Long Unwinding',  icon: ShieldAlert,  sentiment: 'bearish' },
  ],
  options: [
    { id: 'oi-gainers-call',  name: 'Call OI Gainers', icon: TrendingUp,   sentiment: 'bearish' },
    { id: 'oi-gainers-put',   name: 'Put OI Gainers',  icon: TrendingDown, sentiment: 'bullish' },
    { id: 'iv-rise',          name: 'IV Spike',         icon: Zap,          sentiment: 'neutral' },
    { id: 'iv-fall',          name: 'IV Crush',         icon: ShieldAlert,  sentiment: 'neutral' },
  ]
};

export const V3FnoIntelligenceWidget: React.FC<V3FnoIntelligenceWidgetProps> = ({ onSelectStock }) => {
  const [activeTab, setActiveTab] = useState<'options' | 'futures'>('futures');
  const [activeScanner, setActiveScanner] = useState<string>('long-build-up');
  
  const { data: scannerData, isLoading } = trpc.getTrendlyneFnoScanners.useQuery({
    mtype: activeTab,
    screenType: activeScanner,
    instType: 'all',
  }, { refetchInterval: 30000 });

  const rows = useMemo(() => scannerData?.tableData || [], [scannerData]);

  return (
    <div className="flex flex-col gap-6 h-[calc(100vh-140px)]">
      {/* Top Control Bar */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl p-4 shadow-lg">
        <div className="flex bg-slate-800/50 p-1 rounded-xl">
          <button 
            onClick={() => { setActiveTab('futures'); setActiveScanner('long-build-up'); }}
            className={cn("px-6 py-2 rounded-lg text-sm font-bold tracking-widest uppercase transition-all",
              activeTab === 'futures' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-500 hover:text-slate-300")}
          >
            Futures
          </button>
          <button 
            onClick={() => { setActiveTab('options'); setActiveScanner('oi-gainers-call'); }}
            className={cn("px-6 py-2 rounded-lg text-sm font-bold tracking-widest uppercase transition-all",
              activeTab === 'options' ? "bg-cyan-600 text-white shadow-lg shadow-cyan-500/20" : "text-slate-500 hover:text-slate-300")}
          >
            Options
          </button>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-4 gap-6 flex-1 min-h-0">
        {/* Left Sidebar - Scanners */}
        <div className="lg:col-span-1 bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl p-4 flex flex-col gap-2 overflow-y-auto custom-scrollbar">
          <h3 className="text-xs font-bold text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-2">
            <Filter className="w-4 h-4" /> Strategies
          </h3>
          {scanners[activeTab].map(s => {
            const Icon = s.icon;
            const isActive = activeScanner === s.id;
            return (
              <button 
                key={s.id} 
                onClick={() => setActiveScanner(s.id)}
                className={cn("p-4 rounded-xl text-left transition-all border flex items-center gap-3",
                  isActive ? "bg-slate-800 border-indigo-500/50 shadow-inner" : "bg-slate-900/50 border-slate-800 hover:border-slate-700")}
              >
                <div className={cn("p-2 rounded-lg", isActive ? "bg-indigo-500/20 text-indigo-400" : "bg-slate-800 text-slate-500")}>
                  <Icon className="w-4 h-4" />
                </div>
                <div>
                  <p className={cn("text-sm font-bold", isActive ? "text-white" : "text-slate-400")}>{s.name}</p>
                  <span className={cn("text-[9px] font-bold uppercase tracking-widest px-1.5 py-0.5 rounded-sm mt-1 inline-block",
                    s.sentiment === 'bullish' ? "bg-emerald-500/10 text-emerald-400" :
                    s.sentiment === 'bearish' ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-400"
                  )}>{s.sentiment}</span>
                </div>
              </button>
            )
          })}
        </div>

        {/* Main Content Area */}
        <div className="lg:col-span-3 bg-slate-900/40 backdrop-blur-xl border border-slate-800 rounded-2xl flex flex-col shadow-lg overflow-hidden">
          <div className="p-5 border-b border-slate-800/60 bg-slate-800/20 flex items-center justify-between">
             <div className="flex items-center gap-2">
               <Activity className="w-5 h-5 text-indigo-400" />
               <h2 className="text-lg font-bold text-slate-100 uppercase tracking-wider">{scanners[activeTab].find(s => s.id === activeScanner)?.name} Signals</h2>
             </div>
             {isLoading && <div className="w-4 h-4 border-2 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />}
          </div>

          <div className="flex-1 overflow-auto custom-scrollbar p-2">
            {isLoading && rows.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-slate-500 text-sm font-medium animate-pulse">Loading intelligence data...</p>
              </div>
            ) : rows.length === 0 ? (
              <div className="flex items-center justify-center h-full">
                <p className="text-slate-500 text-sm font-medium">No signals found matching this criteria.</p>
              </div>
            ) : (
              <table className="w-full text-left border-collapse">
                 <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
                    <tr>
                      <th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800/50">Symbol</th>
                      <th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800/50 text-right">LTP</th>
                      <th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800/50 text-right">OI Change%</th>
                      <th className="py-3 px-4 text-xs font-semibold text-slate-400 uppercase tracking-wider border-b border-slate-800/50 text-center">Status</th>
                    </tr>
                 </thead>
                 <tbody className="divide-y divide-slate-800/30">
                    <AnimatePresence>
                      {rows.map((row: any[], idx: number) => {
                        const symbol = row[0]?.name || 'UNKNOWN';
                        // Extracting values depending on if it's options or futures
                        const ltp = activeTab === 'options' ? (typeof row[3] === 'number' ? row[3] : 0) : (typeof row[1] === 'number' ? row[1] : 0);
                        const oiChg = activeTab === 'options' ? (typeof row[10] === 'number' ? row[10] : 0) : (typeof row[8] === 'number' ? row[8] : 0);
                        const buildup = typeof row[row.length - 1] === 'string' ? row[row.length - 1] : 'Mixed';
                        
                        const isBull = buildup === 'Long Build Up' || buildup === 'Short Covering';
                        const isBear = buildup === 'Short Build Up' || buildup === 'Long Unwinding';

                        return (
                          <motion.tr 
                            key={`${symbol}-${idx}`}
                            initial={{ opacity: 0, y: 10 }}
                            animate={{ opacity: 1, y: 0 }}
                            className="hover:bg-slate-800/40 cursor-pointer group transition-colors"
                            onClick={() => onSelectStock(symbol)}
                          >
                            <td className="py-3 px-4">
                               <span className="font-bold text-slate-200 group-hover:text-indigo-400 transition-colors">{symbol}</span>
                            </td>
                            <td className="py-3 px-4 text-right font-medium text-slate-300 tabular-nums">
                               ₹{ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}
                            </td>
                            <td className="py-3 px-4 text-right">
                               <span className={cn(
                                 "inline-block px-2 py-1 rounded-md text-xs font-bold tabular-nums",
                                 oiChg >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                               )}>
                                 {oiChg >= 0 ? '+' : ''}{oiChg.toFixed(2)}%
                               </span>
                            </td>
                            <td className="py-3 px-4 text-center">
                               <span className={cn(
                                 "text-[10px] font-black uppercase tracking-widest px-2 py-1 rounded-full border",
                                 isBull ? "bg-emerald-500/5 text-emerald-400 border-emerald-500/20" : 
                                 isBear ? "bg-rose-500/5 text-rose-400 border-rose-500/20" : 
                                 "bg-slate-800 text-slate-400 border-slate-700"
                               )}>
                                 {buildup}
                               </span>
                            </td>
                          </motion.tr>
                        )
                      })}
                    </AnimatePresence>
                 </tbody>
              </table>
            )}
          </div>
        </div>
      </div>
    </div>
  );
};
