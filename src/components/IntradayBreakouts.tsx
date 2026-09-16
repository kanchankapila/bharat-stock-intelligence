import React from 'react';
import { Card } from './MCCommon';
import { trpc } from '../lib/trpc';
import { Zap, TrendingUp, TrendingDown } from 'lucide-react';
import { cn } from '../lib/utils';

interface IntradayBreakoutsProps {
  onSelectStock: (symbol: string) => void;
}

export const IntradayBreakouts: React.FC<IntradayBreakoutsProps> = ({ onSelectStock }) => {
  const { data: response, isLoading } = trpc.getBreakouts.useQuery(undefined, {
    refetchInterval: 60000,
  });

  const breakouts = response?.data || [];

  if (isLoading) {
    return (
      <div className="col-span-12 h-64 bg-slate-900/50 animate-pulse rounded-3xl border border-slate-800" />
    );
  }

  return (
    <div className="v1-card p-6 col-span-12">
      <div className="flex items-center justify-between mb-6">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tighter uppercase italic flex items-center gap-3">
            <Zap className="w-6 h-6 text-amber-500 fill-amber-500/20" />
            Intraday Breakouts (NiftyTrader)
          </h2>
          <p className="text-[10px] font-bold text-slate-500 font-display uppercase tracking-widest mt-1">Live Breakout Detection</p>
        </div>
      </div>

      {breakouts.length === 0 ? (
        <div className="py-8 text-center">
          <p className="text-slate-600 text-[10px] font-bold font-display uppercase tracking-widest italic">No breakout data currently detected</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
          {breakouts.slice(0, 12).map((stock: any) => {
            const isUp = stock.change >= 0;
            return (
              <div 
                key={stock.symbol_name}
                onClick={() => onSelectStock(stock.symbol_name)}
                className={cn(isUp ? 'v1-card-up' : 'v1-card-down', 'p-4 cursor-pointer hover:border-slate-700 transition-all group')}
              >
                <div className="flex justify-between items-start mb-3">
                  <p className="text-sm font-black text-white italic font-display uppercase tracking-wider group-hover:text-blue-400 transition-colors">
                    {stock.symbol_name}
                  </p>
                  <div className={cn(
                    "flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded",
                    isUp ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                  )}>
                    {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {stock.change_percent}%
                  </div>
                </div>

                <div className="flex justify-between items-end">
                  <div>
                    <p className="text-[8px] font-black text-slate-500 font-display uppercase tracking-widest mb-1">LTP</p>
                    <p className="text-lg font-black text-white tabular-nums tracking-tighter">₹{stock.last_trade_price}</p>
                  </div>
                  <div className="text-right">
                    <p className="text-[8px] font-black text-slate-500 font-display uppercase tracking-widest mb-1">Vol Ratio</p>
                    <p className="text-xs font-bold text-slate-400 tabular-nums">{stock.ratio}x</p>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
