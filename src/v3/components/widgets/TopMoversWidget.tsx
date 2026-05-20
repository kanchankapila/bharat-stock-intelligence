import React, { useState } from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';

export const TopMoversWidget: React.FC = () => {
  const { data: topMovers, isLoading } = trpc.getTopMovers.useQuery(undefined, {
    refetchInterval: 15000, // Refresh every 15s
  });

  const [activeTab, setActiveTab] = useState<'gainers' | 'losers'>('gainers');

  if (isLoading) {
    return (
      <div className="bg-slate-900 border border-slate-800 rounded-xl p-6 h-[400px] flex flex-col">
        <div className="h-6 w-32 bg-slate-800 rounded-md animate-pulse mb-6" />
        <div className="flex gap-4 mb-4">
          <div className="h-8 w-24 bg-slate-800 rounded-md animate-pulse" />
          <div className="h-8 w-24 bg-slate-800 rounded-md animate-pulse" />
        </div>
        <div className="space-y-3 flex-1">
          {[1, 2, 3, 4, 5].map(i => (
            <div key={i} className="h-12 w-full bg-slate-800/50 rounded-md animate-pulse" />
          ))}
        </div>
      </div>
    );
  }

  const moversList = activeTab === 'gainers' ? topMovers?.topGainers || [] : topMovers?.topLosers || [];

  return (
    <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-xl p-6 flex flex-col h-full shadow-lg">
      <div className="flex items-center justify-between mb-6">
        <h2 className="text-xl font-bold text-slate-100 flex items-center gap-2">
          {activeTab === 'gainers' ? <TrendingUp className="text-emerald-500 w-5 h-5" /> : <TrendingDown className="text-rose-500 w-5 h-5" />}
          Market Movers
        </h2>
        
        <div className="flex bg-slate-800/50 p-1 rounded-lg border border-slate-700/50">
          <button
            onClick={() => setActiveTab('gainers')}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
              activeTab === 'gainers' ? 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Top Gainers
          </button>
          <button
            onClick={() => setActiveTab('losers')}
            className={cn(
              'px-4 py-1.5 text-sm font-medium rounded-md transition-colors',
              activeTab === 'losers' ? 'bg-rose-500/20 text-rose-400 border border-rose-500/30' : 'text-slate-400 hover:text-slate-200'
            )}
          >
            Top Losers
          </button>
        </div>
      </div>

      <div className="flex-1 overflow-y-auto pr-2 custom-scrollbar">
        <div className="space-y-2">
          <AnimatePresence mode="popLayout">
            {moversList.slice(0, 10).map((stock, idx) => {
              const isGainer = stock.change_percent >= 0;
              const isFlat = stock.change_percent === 0;

              return (
                <motion.div
                  key={stock.symbol_name + activeTab}
                  initial={{ opacity: 0, x: -20 }}
                  animate={{ opacity: 1, x: 0 }}
                  exit={{ opacity: 0, scale: 0.95 }}
                  transition={{ delay: idx * 0.05 }}
                  className="flex items-center justify-between p-3 rounded-lg bg-slate-800/30 hover:bg-slate-800/70 border border-transparent hover:border-slate-700 transition-all group"
                >
                  <div className="flex items-center gap-3">
                    <div className={cn(
                      'w-10 h-10 rounded-full flex items-center justify-center font-bold text-sm',
                      isGainer ? 'bg-emerald-500/10 text-emerald-400' : isFlat ? 'bg-slate-500/10 text-slate-400' : 'bg-rose-500/10 text-rose-400'
                    )}>
                      {stock.symbol_name.substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                      <h4 className="text-sm font-bold text-slate-200 group-hover:text-white transition-colors">{stock.symbol_name}</h4>
                      <p className="text-[11px] text-slate-500 font-medium">Vol: {stock.today_volume.toLocaleString()}</p>
                    </div>
                  </div>
                  
                  <div className="text-right">
                    <p className="text-sm font-bold text-slate-200 tabular-nums">₹{stock.today_close.toFixed(2)}</p>
                    <div className={cn(
                      'flex items-center justify-end gap-1 text-[12px] font-semibold tabular-nums mt-0.5',
                      isGainer ? 'text-emerald-400' : isFlat ? 'text-slate-400' : 'text-rose-400'
                    )}>
                      {isGainer ? <TrendingUp className="w-3 h-3" /> : isFlat ? <Minus className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                      <span>{stock.change_percent > 0 ? '+' : ''}{stock.change_percent.toFixed(2)}%</span>
                    </div>
                  </div>
                </motion.div>
              );
            })}
          </AnimatePresence>
          {moversList.length === 0 && (
            <div className="text-center py-8 text-slate-500">
              No movers data available right now.
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
