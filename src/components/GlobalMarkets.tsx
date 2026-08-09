import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Activity, ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { motion } from 'motion/react';
import { GlobalMarketCards } from './GlobalMarketCards';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { lookupExchangeTimeZone, currentTimeInZone } from '../lib/timeFormat';
import { PriceFreshnessBadge } from './PriceFreshnessBadge';

export const GlobalMarkets: React.FC<{ className?: string }> = ({ className }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });

  const { data: globalData, isLoading, dataUpdatedAt } = trpc.getGlobalIndices.useQuery(undefined, {
    enabled: isVisible,
    refetchInterval: isVisible ? 30000 : false,
  });

  // Ticks once a minute so per-market local clocks stay live without re-fetching.
  const [, setClockTick] = React.useState(0);
  React.useEffect(() => {
    const t = setInterval(() => setClockTick(n => n + 1), 60_000);
    return () => clearInterval(t);
  }, []);

  if (isLoading || !globalData) return (
    <Card ref={ref} title="Global Intelligence" icon={Activity} className={cn("h-full", className)}>
      <div className="grid grid-cols-2 gap-3 animate-pulse pt-2">
        {[1, 2, 3, 4, 5, 6].map(i => (
          <div key={i} className="h-24 bg-slate-800/50 rounded-2xl" />
        ))}
      </div>
    </Card>
  );

  const allIndices = (() => {
    const raw = (globalData as any)?.data?.indiceList ?? [];
    return raw.flatMap((group: any) => 
      (group.list || []).map((idx: any) => ({
        name: idx.name,
        price: idx.value,
        change: idx.change,
        percentChange: idx.changePer,
        direction: idx.direction,
        region: group.name
      }))
    );
  })();

  const importantIndices = ['S&P 500', 'Nasdaq', 'FTSE 100', 'Nikkei 225', 'DAX', 'Hang Seng', 'Dow Jones', 'S&P 500 Futures', 'Nasdaq Futures', 'CAC 40', 'Shanghai Composite'];
  
  const displayIndices = allIndices.filter((idx: any) => 
    importantIndices.some(name => idx.name.includes(name))
  );

  return (
    <Card
      ref={ref}
      title="Global Intelligence"
      icon={Activity}
      className={cn("h-full", className)}
      action={<PriceFreshnessBadge updatedAt={dataUpdatedAt} thresholdMs={60_000} />}
    >
      <div className="grid grid-cols-2 gap-3 pt-2">
        {displayIndices.map((idx: any) => {
          const isUp = Number(idx.direction) === 1 || parseFloat(idx.percentChange) >= 0;
          return (
            <motion.div
              key={idx.name}
              initial={{ opacity: 0, scale: 0.95 }}
              animate={{ opacity: 1, scale: 1 }}
              whileHover={{ scale: 1.02, translateY: -2 }}
              className={cn(
                "p-2 rounded-xl border bg-slate-950/50 backdrop-blur-sm transition-all group cursor-default",
                isUp ? "border-emerald-500/20 hover:border-emerald-500/40 shadow-[0_0_15px_rgba(16,185,129,0.05)]" : "border-rose-500/20 hover:border-rose-500/40 shadow-[0_0_15px_rgba(244,63,94,0.05)]"
              )}
            >
              <div className="flex justify-between items-start mb-2">
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest truncate pr-2">
                  {idx.name}
                </span>
                <span className="text-[7px] font-bold text-slate-700 bg-slate-900 px-1.5 py-0.5 rounded uppercase shrink-0">
                  {idx.region}
                </span>
              </div>
              
              <div className="mb-1.5">
                <span className="text-sm font-black text-white tabular-nums tracking-tighter">
                  {idx.price}
                </span>
              </div>

              {(() => {
                const tz = lookupExchangeTimeZone(idx.name) ?? lookupExchangeTimeZone(idx.region);
                return tz ? (
                  <div className="text-[7px] font-bold text-slate-600 uppercase tracking-wide mb-1 tabular-nums">
                    {currentTimeInZone(tz)} local
                  </div>
                ) : null;
              })()}

              <div className={cn(
                "flex items-center gap-1 text-[10px] font-black",
                isUp ? "text-emerald-400" : "text-rose-400"
              )}>
                {isUp ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                {idx.percentChange}%
              </div>
            </motion.div>
          );
        })}
      </div>
      <div className="mt-2 pt-2 border-t border-slate-800/50">
          <p className="text-[9px] font-black text-slate-500 uppercase tracking-[0.2em] mb-2 text-center">Extended Market Insight</p>
          <GlobalMarketCards />
      </div>
    </Card>
  );
};
