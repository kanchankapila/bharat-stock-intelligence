import React, { useState } from 'react';
import { trpc } from '../../../lib/trpc';
import { 
  Activity, Search, TrendingUp, Clock, Filter, 
  ArrowUpRight, ArrowDownRight, Radio, Target
} from 'lucide-react';
import { cn } from '../../../lib/utils';
import { format } from 'date-fns';

export const V2SignalTracking: React.FC = () => {
  const [daysFilter, setDaysFilter] = useState(30);
  const [searchQuery, setSearchQuery] = useState('');
  
  const { data: signals, isLoading, error } = trpc.getSignalTracking.useQuery({ days: daysFilter });

  if (isLoading) {
    return (
      <div className="flex flex-col items-center justify-center min-h-[60vh]">
         <Activity className="w-12 h-12 text-indigo-500/20 animate-pulse mb-4" />
         <p className="text-slate-400 text-xs font-black uppercase tracking-[0.2em] animate-pulse">
           Syncing Universal Signal Ledger...
         </p>
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-8 text-center bg-terminal-panel border border-rose-500/30 rounded-2xl">
        <p className="text-rose-400 font-mono text-sm">Error loading signals: {error.message}</p>
      </div>
    );
  }

  const filteredSignals = (signals || []).filter((s: any) => 
    s.symbol.toLowerCase().includes(searchQuery.toLowerCase()) || 
    s.signal_source.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500">
      {/* Header Controls */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-terminal-panel p-4 border border-terminal-border rounded-2xl">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center">
            <Radio className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h2 className="text-lg font-black text-slate-100 uppercase tracking-widest font-mono">Signal Ledger</h2>
            <p className="text-[10px] text-slate-400 font-bold uppercase tracking-widest mt-0.5">
              Tracking universal alpha generation
            </p>
          </div>
        </div>

        <div className="flex flex-col sm:flex-row items-center gap-3">
          {/* Search */}
          <div className="relative w-full sm:w-64">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
            <input 
              type="text" 
              placeholder="Search symbol or source..."
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              className="w-full bg-terminal-bg border border-terminal-border rounded-xl py-2 pl-9 pr-3 text-xs text-slate-200 placeholder:text-slate-600 focus:outline-none focus:border-indigo-500/50 transition-colors font-mono"
            />
          </div>

          {/* Days Filter */}
          <div className="flex items-center bg-terminal-bg border border-terminal-border rounded-xl p-1 shrink-0">
            {[7, 30, 90, 365].map(days => (
              <button
                key={days}
                onClick={() => setDaysFilter(days)}
                className={cn(
                  "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-wider transition-all",
                  daysFilter === days 
                    ? "bg-indigo-600/20 text-indigo-400 border border-indigo-500/30" 
                    : "text-slate-500 hover:text-slate-300"
                )}
              >
                {days}D
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* Main Table */}
      <div className="bg-terminal-panel border border-terminal-border rounded-2xl overflow-hidden">
        <div className="overflow-x-auto terminal-scrollbar">
          <table className="w-full text-left border-collapse">
            <thead>
              <tr className="bg-terminal-panel-header/50">
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border whitespace-nowrap">Generated At</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border">Symbol</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border text-center">Type / Source</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border text-right">Entry Price</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border text-right">Current Price</th>
                <th className="px-4 py-3 text-[10px] font-black uppercase text-slate-500 tracking-widest border-b border-terminal-border text-right">Growth / PnL</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-terminal-border">
              {filteredSignals.length > 0 ? (
                filteredSignals.map((sig: any) => {
                  const isPositive = sig.growth_pct != null && sig.growth_pct > 0;
                  const isNegative = sig.growth_pct != null && sig.growth_pct < 0;

                  return (
                    <tr key={sig.id} className="hover:bg-indigo-900/10 transition-colors group">
                      <td className="px-4 py-3 whitespace-nowrap">
                        <div className="flex items-center gap-1.5 text-slate-400">
                          <Clock className="w-3 h-3" />
                          <span className="text-[10px] font-mono">
                            {format(new Date(sig.signal_generated_at), 'MMM dd, HH:mm')}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3">
                        <div className="flex items-center gap-2">
                          <span className="text-sm font-black text-slate-200 tracking-wider font-mono">
                            {sig.symbol}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-center">
                        <div className="flex flex-col items-center justify-center gap-1">
                          <span className={cn(
                            "px-2 py-0.5 rounded text-[8px] font-black tracking-widest uppercase border",
                            sig.signal_type === 'BUY' ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" : 
                            sig.signal_type === 'SELL' ? "bg-rose-500/10 text-rose-400 border-rose-500/20" : 
                            "bg-slate-500/10 text-slate-400 border-slate-500/20"
                          )}>
                            {sig.signal_type}
                          </span>
                          <span className="text-[8px] text-slate-500 uppercase font-black tracking-widest">
                            {sig.signal_source}
                          </span>
                        </div>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs text-slate-300 font-mono">
                          ₹{sig.entry_price?.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }) ?? '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        <span className="text-xs font-bold text-white font-mono">
                          {sig.current_price 
                            ? `₹${sig.current_price.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` 
                            : '—'}
                        </span>
                      </td>
                      <td className="px-4 py-3 text-right">
                        {sig.growth_pct != null ? (
                          <div className={cn(
                            "inline-flex items-center gap-1 px-2 py-1 rounded-md text-xs font-black font-mono border",
                            isPositive ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20" :
                            isNegative ? "bg-rose-500/10 text-rose-400 border-rose-500/20" :
                            "bg-slate-500/10 text-slate-400 border-slate-500/20"
                          )}>
                            {isPositive ? <ArrowUpRight className="w-3 h-3" /> : isNegative ? <ArrowDownRight className="w-3 h-3" /> : null}
                            {isPositive ? '+' : ''}{sig.growth_pct.toFixed(2)}%
                          </div>
                        ) : (
                          <span className="text-slate-500 text-xs">—</span>
                        )}
                      </td>
                    </tr>
                  )
                })
              ) : (
                <tr>
                  <td colSpan={6} className="px-4 py-12 text-center text-slate-500 font-mono text-sm">
                    No signals found in the selected timeframe.
                  </td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
};
