import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  TrendingUp, TrendingDown, Star, ArrowUpRight, ArrowDownRight,
  Zap, Activity, Trophy
} from 'lucide-react';
import { PriceFreshnessBadge } from './PriceFreshnessBadge';

interface TopMoversIntelligenceProps {
  onSelectStock: (symbol: string) => void;
}

export const TopMoversIntelligence: React.FC<TopMoversIntelligenceProps> = ({ onSelectStock }) => {
  const { data: movers, isLoading, dataUpdatedAt } = trpc.getTopMovers.useQuery(undefined, {
    refetchInterval: 60000
  });

  const renderMoversList = (list: any[], color: string) => (
    <div className="space-y-3">
      {list.slice(0, 6).map((stock: any) => (
        <div 
          key={stock.symbol_name} 
          onClick={() => onSelectStock(stock.symbol_name)}
          className="flex items-center justify-between group hover:bg-white/[0.03] p-2 rounded-xl transition-all cursor-pointer border border-transparent hover:border-white/[0.07]"
        >
          <div>
            <p className="text-white font-semibold text-[11px] tracking-tight uppercase">{stock.symbol_name}</p>
            <p className="text-slate-500 text-[9px] tracking-wide">
              Vol: {stock.today_volume ? `${(stock.today_volume / 1000000).toFixed(1)}M` : '—'}
            </p>
          </div>
          <div className="text-right">
            <p className="text-white font-black text-xs tabular-nums">₹{Number(stock.today_close).toLocaleString()}</p>
            <p className={cn(
              "text-[10px] font-black tabular-nums",
              Number(stock.change_percent) >= 0 ? "text-emerald-400" : "text-rose-400"
            )}>
              {Number(stock.change_percent) >= 0 ? '+' : ''}{Number(stock.change_percent).toFixed(2)}%
            </p>
          </div>
        </div>
      ))}
    </div>
  );

  if (isLoading || !movers) {
    return (
      <div className="col-span-12 grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-40 bg-slate-900/50 animate-pulse rounded-2xl border border-slate-800" />
        ))}
      </div>
    );
  }

  const sections = [
    { title: 'Top Gainers', data: movers?.topGainers || [], icon: TrendingUp, color: 'emerald' },
    { title: 'Top Losers', data: movers?.topLosers || [], icon: TrendingDown, color: 'rose' },
    { title: 'Top Watchlist', data: movers?.topWatchList || [], icon: Star, color: 'violet' },
    { title: 'Gap Up Stocks', data: movers?.gapUp || [], icon: ArrowUpRight, color: 'blue' },
    { title: 'Gap Down Stocks', data: movers?.gapDown || [], icon: ArrowDownRight, color: 'orange' },
    { title: 'Open = Low (Bullish)', data: movers?.sameOpenAndLow || [], icon: Zap, color: 'emerald' },
    { title: 'Open = High (Bearish)', data: movers?.sameOpenAndHigh || [], icon: Activity, color: 'rose' },
  ];

  return (
    <div className="col-span-12 space-y-4">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-3">
            <Trophy className="w-5 h-5 text-amber-500 fill-amber-500/20" />
            Top Movers
          </h2>
          <p className="text-xs text-slate-500 mt-1">Real-time market activity and setup detection</p>
        </div>
        <div className="flex flex-col items-end gap-1.5">
          <div className="flex items-center gap-2 px-3 py-1 bg-slate-900/60 border border-white/[0.08] rounded-full backdrop-blur-sm">
             <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
             <span className="text-[9px] font-semibold text-slate-400 uppercase tracking-widest">Live NSE</span>
          </div>
          <PriceFreshnessBadge updatedAt={dataUpdatedAt} thresholdMs={90_000} />
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
        {sections.map(section => (
          <Card key={section.title} title={section.title} icon={section.icon}>
            {renderMoversList(section.data, section.color)}
            {section.data.length === 0 && (
              <div className="py-8 text-center">
                <p className="text-slate-600 text-[10px] font-bold uppercase tracking-widest italic">No data detected</p>
              </div>
            )}
          </Card>
        ))}
      </div>
    </div>
  );
};
