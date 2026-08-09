import React, { useEffect, useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ArrowUpRight, ArrowDownRight, Minus } from 'lucide-react';
import { motion } from 'motion/react';
import { lookupExchangeTimeZone, currentTimeInZone, relativeFromNow } from '../lib/timeFormat';

export const GlobalMarketCards: React.FC = () => {
  const { data: globalMarketData, isLoading, error, refetch, dataUpdatedAt } = trpc.getGlobalMarketData.useQuery(undefined, {
    refetchOnWindowFocus: true,
    refetchOnMount: true,
    refetchInterval: 5 * 60_000,
  });

  // Ensure it refreshes every time the component mounts
  useEffect(() => {
    refetch();
  }, [refetch]);

  // Ticks once a minute so each market's local clock stays live without re-fetching data.
  const [, setClockTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setClockTick(n => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

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

              {/* Local exchange clock + live open/closed status, from the vendor's own market_status flag */}
              {(() => {
                const tz = lookupExchangeTimeZone(market.country);
                return (
                  <div className="flex items-center gap-1.5 mt-1.5 text-[8px] font-bold uppercase tracking-wide">
                    {tz && (
                      <span className="text-slate-500 tabular-nums">{currentTimeInZone(tz)} local</span>
                    )}
                    {typeof market.market_status === 'boolean' && (
                      <span className={cn(
                        'flex items-center gap-1',
                        market.market_status ? 'text-emerald-400' : 'text-slate-600'
                      )}>
                        <span className={cn('w-1.5 h-1.5 rounded-full', market.market_status ? 'bg-emerald-400 animate-pulse' : 'bg-slate-600')} />
                        {market.market_status ? 'Open' : 'Closed'}
                      </span>
                    )}
                  </div>
                );
              })()}

              <div className={cn("flex items-center text-[10px] font-black mt-1", textColor)}>
                <Icon className="w-3.5 h-3.5 mr-1" />
                <span className="tabular-nums">{Math.abs(changePer).toFixed(2)}%</span>
              </div>
            </motion.div>
          );
        })}
      </div>
      {dataUpdatedAt > 0 && (
        <div className="text-[8px] text-slate-600 font-semibold uppercase tracking-wide mt-2 text-right">
          Data fetched {relativeFromNow(dataUpdatedAt)} · local clocks live
        </div>
      )}
    </div>
  );
};
