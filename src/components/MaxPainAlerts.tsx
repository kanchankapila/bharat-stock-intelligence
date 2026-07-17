import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Target, Activity, AlertTriangle, ShieldAlert, ArrowUpRight, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface Props {
  onSelectStock?: (symbol: string) => void;
}

export const MaxPainAlerts: React.FC<Props> = ({ onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');

  const { data: maxPainData = [], isLoading, isError } = trpc.getMaxPainAlerts.useQuery(undefined, {
    staleTime: 5 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
  });

  const filtered = maxPainData.filter(d =>
    d.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
    d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-[580px] glass border border-slate-800/50 rounded-2xl p-5 text-slate-200">
      {/* Header */}
      <div className="flex-shrink-0 mb-5">
        <h2 className="text-xl font-bold font-['Rajdhani'] flex items-center gap-2">
          <Target className="w-5 h-5 text-rose-400" />
          Max Pain Strike Magnet Alerts
        </h2>
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-0.5">
          Option open interest gravity pulls price towards Max Pain strike on expiry weeks
        </p>
      </div>

      {/* Search Input */}
      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
        <input
          type="text"
          placeholder="Search stocks by symbol or name..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs font-medium text-slate-200 placeholder-slate-650 focus:outline-none focus:border-slate-700 transition-colors"
        />
      </div>

      {/* List Container */}
      <div className="flex-grow overflow-y-auto pr-1 terminal-scrollbar min-h-0">
        {isLoading ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            Loading live Max Pain data&hellip;
          </div>
        ) : isError ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            Failed to load Max Pain data.
          </div>
        ) : filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            No Max Pain magnet alignments.
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map((item, idx) => {
                const isBullishMagnet = item.diffPct < 0;
                return (
                  <motion.div
                    key={item.symbol}
                    layout
                    initial={{ opacity: 0, scale: 0.98 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.98 }}
                    transition={{ duration: 0.2 }}
                    className="p-4 bg-slate-950/45 border border-slate-900 hover:border-slate-800/80 rounded-xl transition-all cursor-pointer flex flex-col sm:flex-row sm:items-center justify-between gap-4 group"
                    onClick={() => onSelectStock?.(item.symbol)}
                  >
                    {/* Left Details */}
                    <div className="space-y-1 sm:w-1/3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white uppercase tracking-wider">{item.symbol}</span>
                        <span className={cn("text-[8px] font-black px-1.5 py-0.5 rounded border uppercase",
                          item.strength === 'Strong Magnet' ? "bg-rose-500/10 text-rose-400 border-rose-500/20 animate-pulse" : "bg-slate-900 text-slate-500 border-slate-850"
                        )}>
                          {item.strength}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 font-bold leading-tight truncate">{item.name}</p>
                    </div>

                    {/* Middle Numbers */}
                    <div className="grid grid-cols-3 gap-4 flex-grow max-w-xs text-center sm:text-left">
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Prev Close</span>
                        <span className="text-xs font-bold text-slate-200 font-mono">₹{item.ltp.toFixed(1)}</span>
                      </div>
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Max Pain</span>
                        <span className="text-xs font-bold text-indigo-400 font-mono">₹{item.maxPain.toFixed(1)}</span>
                      </div>
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Distance</span>
                        <span className={cn("text-xs font-black font-mono", isBullishMagnet ? "text-emerald-400" : "text-rose-400")}>
                          {item.diffPct >= 0 ? '+' : ''}{item.diffPct.toFixed(2)}%
                        </span>
                      </div>
                    </div>

                    {/* Right Recommendation Badge */}
                    <div className="flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 border-slate-900/40 pt-2 sm:pt-0">
                      <div className="text-right">
                        <p className={cn("text-[9px] font-black uppercase tracking-wider", isBullishMagnet ? "text-emerald-400" : "text-rose-400")}>
                          {item.rec}
                        </p>
                        <p className="text-[8px] text-slate-550 font-bold mt-0.5">Potential reversion gap of {Math.abs(item.diffPct).toFixed(1)}%</p>
                      </div>
                      <ArrowUpRight className="w-4 h-4 text-slate-650 group-hover:text-rose-400 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
                    </div>
                  </motion.div>
                );
              })}
            </AnimatePresence>
          </div>
        )}
      </div>
    </div>
  );
};
export default MaxPainAlerts;
