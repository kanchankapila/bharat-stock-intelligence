import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Award, Calendar, Search, TrendingUp, Sparkles, ArrowUpRight } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { cn } from '../lib/utils';

interface Props {
  onSelectStock?: (symbol: string) => void;
}

export const EarningsPlaybook: React.FC<Props> = ({ onSelectStock }) => {
  const [searchQuery, setSearchQuery] = useState('');

  // Fallback high-fidelity Earnings and IV Skew dataset
  const earningsData = [
    { symbol: 'TCS', name: 'Tata Consultancy Services Ltd.', date: '2026-07-14', consensusEps: 'Rs.30.10', historySurprise: '+0.8% Beat', ivPct: 90, skew: 'Call Skew (Bullish Bias)' },
    { symbol: 'INFY', name: 'Infosys Ltd.', date: '2026-07-17', consensusEps: 'Rs.18.20', historySurprise: '+2.4% Beat', ivPct: 82, skew: 'Call Skew (Bullish Bias)' },
    { symbol: 'WIPRO', name: 'Wipro Ltd.', date: '2026-07-19', consensusEps: 'Rs.6.20', historySurprise: '-3.4% Miss', ivPct: 78, skew: 'Put Skew (Bearish Bias)' },
    { symbol: 'RELIANCE', name: 'Reliance Industries Ltd.', date: '2026-07-21', consensusEps: 'Rs.34.50', historySurprise: '-1.2% Miss', ivPct: 65, skew: 'Flat (Neutral Bias)' },
  ];

  const filtered = earningsData.filter(d => 
    d.symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
    d.name.toLowerCase().includes(searchQuery.toLowerCase())
  );

  return (
    <div className="flex flex-col h-[580px] glass border border-slate-800/50 rounded-2xl p-5 text-slate-200">
      {/* Header */}
      <div className="flex-shrink-0 mb-5">
        <h2 className="text-xl font-bold font-['Rajdhani'] flex items-center gap-2">
          <Sparkles className="w-5 h-5 text-amber-400" />
          Earnings Surprise & Volatility Skew Playbook
        </h2>
        <p className="text-[10px] font-mono text-slate-500 uppercase tracking-widest mt-0.5">
          Earnings announcement calendars combined with implied volatility skew analysis
        </p>
      </div>

      {/* Search Input */}
      <div className="relative mb-4 flex-shrink-0">
        <Search className="absolute left-3 top-2.5 w-3.5 h-3.5 text-slate-500" />
        <input
          type="text"
          placeholder="Filter earnings playbook by symbol..."
          value={searchQuery}
          onChange={(e) => setSearchQuery(e.target.value)}
          className="w-full bg-slate-950/60 border border-slate-800 rounded-xl pl-9 pr-4 py-2 text-xs font-medium text-slate-200 placeholder-slate-650 focus:outline-none focus:border-slate-700 transition-colors"
        />
      </div>

      {/* List Container */}
      <div className="flex-grow overflow-y-auto pr-1 terminal-scrollbar min-h-0">
        {filtered.length === 0 ? (
          <div className="flex items-center justify-center h-full text-slate-500 text-xs font-bold">
            No upcoming earnings playbook items found.
          </div>
        ) : (
          <div className="space-y-3">
            <AnimatePresence mode="popLayout">
              {filtered.map((item, idx) => {
                const isPositiveSurprise = item.historySurprise.includes('Beat');
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
                    {/* Left details */}
                    <div className="space-y-1 sm:w-1/3">
                      <div className="flex items-center gap-2">
                        <span className="text-sm font-black text-white uppercase tracking-wider">{item.symbol}</span>
                        <span className="text-[8px] font-black px-1.5 py-0.5 rounded border border-slate-800 bg-slate-900 text-slate-400 font-mono">
                          {item.date}
                        </span>
                      </div>
                      <p className="text-[10px] text-slate-500 font-bold leading-tight truncate">{item.name}</p>
                    </div>

                    {/* Middle numbers */}
                    <div className="grid grid-cols-3 gap-4 flex-grow max-w-xs text-center sm:text-left">
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Est. EPS</span>
                        <span className="text-xs font-bold text-slate-200 font-mono">{item.consensusEps}</span>
                      </div>
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">Hist. Surprise</span>
                        <span className={cn("text-xs font-black font-mono", isPositiveSurprise ? "text-emerald-400" : "text-rose-400")}>
                          {item.historySurprise}
                        </span>
                      </div>
                      <div>
                        <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block">IV Percentile</span>
                        <span className={cn("text-xs font-black font-mono",
                          item.ivPct >= 80 ? "text-rose-400" : "text-slate-300"
                        )}>
                          {item.ivPct}%
                        </span>
                      </div>
                    </div>

                    {/* Right skew recommendation */}
                    <div className="flex items-center justify-between sm:justify-end gap-3 border-t sm:border-t-0 border-slate-900/40 pt-2 sm:pt-0">
                      <div className="text-right">
                        <p className="text-[9px] font-black text-indigo-400 uppercase tracking-wider">
                          {item.skew}
                        </p>
                        <p className="text-[8px] text-slate-550 font-bold mt-0.5">High IV indicates option premiums are inflated</p>
                      </div>
                      <ArrowUpRight className="w-4 h-4 text-slate-650 group-hover:text-indigo-400 group-hover:translate-x-0.5 group-hover:-translate-y-0.5 transition-all" />
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
export default EarningsPlaybook;
