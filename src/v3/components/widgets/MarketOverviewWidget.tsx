import React from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { ArrowUpRight, ArrowDownRight, Activity } from 'lucide-react';
import { motion } from 'framer-motion';

export const MarketOverviewWidget: React.FC = () => {
  const { data: indices, isLoading: loadingIndices } = trpc.getMarketOverview.useQuery(undefined, {
    refetchInterval: 10000,
  });

  const { data: globalData, isLoading: loadingGlobal } = trpc.getGlobalMarketData.useQuery(undefined, {
    refetchInterval: 30000,
  });

  const isLoading = loadingIndices || loadingGlobal;

  const defaultIndex = { value: 0, change: 0, changePct: 0, indId: '' };
  
  const indianIndices = [
    { name: 'NIFTY 50',   ...(indices?.nifty50   || defaultIndex) },
    { name: 'SENSEX',     ...(indices?.sensex     || defaultIndex) },
    { name: 'BANK NIFTY', ...(indices?.bankNifty  || defaultIndex) },
  ];

  // Pick top 3 global indices for overview
  const globalIndices = (globalData || []).slice(0, 3).map(g => {
    const change = parseFloat(g.change_value);
    const changePct = parseFloat(g.change_per);
    const value = parseFloat(g.current_price.replace(/,/g, ''));
    return {
      name: g.symbol,
      value,
      change,
      changePct,
    };
  });

  if (isLoading) {
    return (
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="h-28 rounded-xl surface-primary glass-border animate-pulse" />
        ))}
      </div>
    );
  }

  const allIndices = [...indianIndices, ...globalIndices];

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-6 gap-4">
      {allIndices.map((item, idx) => {
        const isUp = item.change >= 0;

        return (
          <motion.div
            key={item.name + idx}
            initial={{ opacity: 0, y: 10 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.05 }}
            className={cn(
              'relative rounded-lg p-4 overflow-hidden',
              isUp
                ? 'surface-primary glass-border glow-success-strong'
                : 'surface-primary glass-border glow-danger-strong'
            )}
          >
            {/* Top accent line */}
            <div className={cn(
              'absolute top-0 left-0 right-0 h-0.5',
              isUp ? 'bg-gradient-to-r from-emerald-500 to-emerald-500/20' : 'bg-gradient-to-r from-rose-500 to-rose-500/20'
            )} />

            {/* Content */}
            <div className="flex flex-col gap-3 pt-1">
              <div className="flex items-center justify-between">
                <span className="text-label">{item.name}</span>
                <Activity className={cn('w-4 h-4 transition-colors', isUp ? 'text-emerald-500' : 'text-rose-500')} />
              </div>

              <div className="flex flex-col gap-1">
                <span className="text-2xl font-bold text-slate-50 tabular-nums">
                  {item.value.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                </span>
                <div className={cn(
                  'flex items-center gap-1.5 text-sm font-semibold tabular-nums',
                  isUp ? 'text-emerald-400' : 'text-rose-400'
                )}>
                  {isUp ? <ArrowUpRight className="w-3.5 h-3.5" /> : <ArrowDownRight className="w-3.5 h-3.5" />}
                  <span>{item.change > 0 ? '+' : ''}{item.change.toFixed(2)}</span>
                  <span className="text-xs text-slate-500">({item.changePct > 0 ? '+' : ''}{item.changePct.toFixed(2)}%)</span>
                </div>
              </div>
            </div>
          </motion.div>
        );
      })}
    </div>
  );
};
