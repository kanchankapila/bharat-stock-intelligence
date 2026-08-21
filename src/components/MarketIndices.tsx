import React from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';
import { ArrowUpRight, ArrowDownRight } from 'lucide-react';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { marketHoursRefetchInterval } from '../lib/timeFormat';
import { PriceFreshnessBadge } from './PriceFreshnessBadge';

export const MarketIndices: React.FC<{ onSelect?: (id: string, name: string) => void }> = ({ onSelect }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });
  const activeRefetch = marketHoursRefetchInterval(5000);

  const { data: indices, isLoading, dataUpdatedAt } = trpc.getMarketOverview.useQuery(undefined, {
    enabled: isVisible,
    refetchInterval: isVisible ? activeRefetch : false,
  });

  if (isLoading || !indices) return (
    <div ref={ref} className="col-span-12 grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
      {[1, 2, 3].map(i => (
        <div key={i} className="h-36 rounded-2xl shimmer" />
      ))}
    </div>
  );

  // The backend's stale-fetch fallback is a truthy object with null value/change/changePct
  // (see market.router.ts's getMarketOverview) -- object presence alone doesn't mean real data.
  const defaultIndex = { value: 0, change: 0, changePct: 0 };
  const hasRealData = (idx: { value: number | null } | null | undefined): boolean => !!idx && idx.value != null;
  const displayItems = [
    { name: 'NIFTY 50',   hasData: hasRealData(indices.nifty50),   ...(indices.nifty50   || defaultIndex) },
    { name: 'SENSEX',     hasData: hasRealData(indices.sensex),     ...(indices.sensex     || defaultIndex) },
    { name: 'BANK NIFTY', hasData: hasRealData(indices.bankNifty),  ...(indices.bankNifty  || defaultIndex) },
  ];

  const getIndexId = (name: string) => {
    if (name === 'NIFTY 50') return '9';
    if (name === 'SENSEX') return '4';
    if (name === 'BANK NIFTY') return '23';
    return '';
  };

  return (
    <div ref={ref} className="col-span-12">
      {dataUpdatedAt > 0 && (
        <div className="flex justify-end mb-1.5">
          <PriceFreshnessBadge updatedAt={dataUpdatedAt} thresholdMs={15_000} />
        </div>
      )}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4 mb-2">
      {displayItems.map((item, idx) => {
        const isUp = item.hasData && item.change >= 0;

        return (
          <motion.div
            key={item.name}
            initial={{ opacity: 0, y: 16 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ delay: idx * 0.08, type: 'spring', stiffness: 220, damping: 22 }}
            onClick={() => onSelect?.(getIndexId(item.name), item.name)}
            className={cn(
              'relative rounded-2xl overflow-hidden transition-all duration-300 cursor-pointer group',
              'bg-slate-900/60 backdrop-blur-xl',
              !item.hasData
                ? 'border border-slate-700/30 shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
                : isUp
                  ? 'border border-emerald-500/20 hover:border-emerald-500/35 shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
                  : 'border border-rose-500/20 hover:border-rose-500/35 shadow-[0_4px_24px_rgba(0,0,0,0.4)]'
            )}
          >
            {/* Colored top accent bar */}
            <div className={cn(
              'absolute top-0 left-0 right-0 h-[2px]',
              !item.hasData
                ? 'bg-slate-700/40'
                : isUp
                  ? 'bg-gradient-to-r from-emerald-500 via-emerald-400 to-emerald-500/0'
                  : 'bg-gradient-to-r from-rose-500 via-rose-400 to-rose-500/0'
            )} />

            {/* Ambient glow blob */}
            <div className={cn(
              'absolute -top-10 -right-10 w-36 h-36 rounded-full opacity-[0.04] blur-3xl pointer-events-none transition-opacity duration-500 group-hover:opacity-[0.08]',
              !item.hasData ? 'bg-slate-500' : isUp ? 'bg-emerald-400' : 'bg-rose-400'
            )} />

            <div className="relative z-10 p-5">
              {/* Header row */}
              <div className="flex items-center justify-between mb-4">
                <div className="flex items-center gap-2">
                  <div className={cn(
                    'w-1.5 h-1.5 rounded-full',
                    item.hasData && 'animate-pulse',
                    !item.hasData ? 'bg-slate-500' : isUp ? 'bg-emerald-400' : 'bg-rose-400'
                  )} />
                  <span className="text-[10px] font-semibold text-slate-400 font-display uppercase tracking-widest">{item.name}</span>
                </div>
                <span className={cn(
                  'text-[9px] font-semibold px-2 py-0.5 rounded-full font-display uppercase tracking-wider border',
                  !item.hasData
                    ? 'bg-slate-700/20 text-slate-400 border-slate-600/30'
                    : isUp
                      ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20'
                      : 'bg-rose-500/10 text-rose-400 border-rose-500/20'
                )}>
                  {!item.hasData ? 'No data' : isUp ? '↑ Bull' : '↓ Bear'}
                </span>
              </div>

              {/* Price */}
              <div className="mb-4">
                <h2 className="text-2xl font-bold text-white tabular-nums tracking-tight">
                  {item.hasData ? item.value.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
                </h2>
                <div className={cn(
                  'flex items-center gap-1.5 mt-1',
                  !item.hasData ? 'text-slate-500' : isUp ? 'text-emerald-400' : 'text-rose-400'
                )}>
                  {item.hasData && (isUp
                    ? <ArrowUpRight className="w-3.5 h-3.5" />
                    : <ArrowDownRight className="w-3.5 h-3.5" />)}
                  {item.hasData ? (
                    <>
                      <span className="text-sm font-semibold tabular-nums">
                        {item.change >= 0 ? '+' : ''}{item.change.toFixed(2)}
                      </span>
                      <span className="text-[11px] opacity-60 tabular-nums">
                        ({item.changePct >= 0 ? '+' : ''}{item.changePct.toFixed(2)}%)
                      </span>
                    </>
                  ) : (
                    <span className="text-sm font-semibold">Unavailable</span>
                  )}
                </div>
              </div>

              {/* Day range bar */}
              <div>
                <div className="h-[3px] bg-slate-800/80 rounded-full overflow-hidden mb-1.5">
                  <motion.div
                    initial={{ width: 0 }}
                    animate={{ width: `${55 + idx * 14}%` }}
                    transition={{ delay: 0.35 + idx * 0.1, duration: 0.9, ease: 'easeOut' }}
                    className={cn(
                      'h-full rounded-full',
                      !item.hasData
                        ? 'bg-slate-700'
                        : isUp
                          ? 'bg-gradient-to-r from-emerald-700 to-emerald-400'
                          : 'bg-gradient-to-r from-rose-700 to-rose-400'
                    )}
                  />
                </div>
                <div className="flex justify-between">
                  <span className="text-[9px] text-slate-600 font-medium">Day Low</span>
                  <span className="text-[9px] text-slate-600 font-medium">Day High</span>
                </div>
              </div>
            </div>
          </motion.div>
        );
      })}
      </div>
    </div>
  );
};
