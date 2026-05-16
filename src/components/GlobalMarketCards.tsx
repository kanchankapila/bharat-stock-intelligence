import React, { useEffect } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { motion } from 'motion/react';

export const GlobalMarketCards: React.FC = () => {
  const { data: globalMarketData, isLoading, error, refetch } = trpc.getGlobalMarketData.useQuery(undefined, {
    refetchOnWindowFocus: true,
    refetchOnMount: true,
  });

  // Ensure it refreshes every time the component mounts
  useEffect(() => {
    refetch();
  }, [refetch]);

  if (isLoading) {
    return (
      <div className="flex justify-center items-center p-4">
        <div className="animate-pulse flex space-x-4">
          <div className="h-20 w-40 bg-slate-800 rounded-lg"></div>
          <div className="h-20 w-40 bg-slate-800 rounded-lg"></div>
          <div className="h-20 w-40 bg-slate-800 rounded-lg"></div>
        </div>
      </div>
    );
  }

  if (error || !globalMarketData || globalMarketData.length === 0) {
    return null; // Don't show if there's an error or no data
  }

  // Filter out any invalid items, if necessary. Group by region or just display all.
  // We'll just display a horizontally scrollable list of cards.

  return (
    <div className="w-full pt-1">
      <div className="grid grid-cols-2 gap-3">
        {globalMarketData.map((market, index) => {
          const changePer = parseFloat(market.change_per);
          let statusColor = 'border-yellow-500/20';
          let textColor = 'text-yellow-400';
          let Icon = Minus;

          if (changePer > 0) {
            statusColor = 'border-emerald-500/20 hover:border-emerald-500/40';
            textColor = 'text-emerald-400';
            Icon = ArrowUpRight;
          } else if (changePer < 0) {
            statusColor = 'border-rose-500/20 hover:border-rose-500/40';
            textColor = 'text-rose-400';
            Icon = ArrowDownRight;
          }

          return (
            <motion.div
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              transition={{ delay: index * 0.05 }}
              key={`${market.symbol}-${index}`}
              className={cn(
                "flex flex-col p-3 rounded-2xl border bg-slate-900/40 backdrop-blur-sm transition-all hover:shadow-lg",
                statusColor
              )}
            >
              <div className="flex justify-between items-start mb-1">
                <span className="text-[10px] font-black text-slate-500 uppercase tracking-widest truncate mr-1">
                  {market.symbol}
                </span>
                <span className="text-[8px] text-slate-600 font-bold uppercase">
                  {market.country}
                </span>
              </div>
              
              <div className="flex items-end justify-between mt-1">
                <span className="text-base font-black text-white tabular-nums tracking-tighter">
                  {market.current_price}
                </span>
              </div>

              <div className={cn("flex items-center text-[10px] font-black mt-1", textColor)}>
                <Icon className="w-3.5 h-3.5 mr-1" />
                <span className="tabular-nums">{Math.abs(changePer).toFixed(2)}%</span>
              </div>
            </motion.div>
          );
        })}
      </div>
    </div>
  );
};
