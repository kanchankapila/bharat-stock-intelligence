import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Zap, Bookmark as WatchlistIcon } from 'lucide-react';
import stockData from '../data/stocklist';

interface MomentumIntelligenceProps {
  watchlist: string[];
  onToggle: (symbol: string) => void;
  onSelectStock: (symbol: string) => void;
}

export const MomentumIntelligence: React.FC<MomentumIntelligenceProps> = ({ 
  watchlist, 
  onToggle, 
  onSelectStock 
}) => {
  const { data: bullish } = trpc.getTechnicalTrends.useQuery({ type: 'bullish' });
  const { data: bearish } = trpc.getTechnicalTrends.useQuery({ type: 'bearish' });

  const bullishList = (bullish?.data?.list || bullish?.data?.tableDataList)?.slice(0, 5) || [];
  const bearishList = (bearish?.data?.list || bearish?.data?.tableDataList)?.slice(0, 5) || [];

  const resolveStock = (shortName: string) => {
    const match = stockData.find(s => s.symbol.toUpperCase() === shortName.toUpperCase());
    return { symbol: match?.symbol || shortName, name: match?.name || '' };
  };

  return (
    <Card title="Momentum Intelligence" icon={Zap}>
      <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-1">
        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
            <h3 className="text-[10px] font-black text-emerald-500 uppercase tracking-[0.2em]">Institutional Accumulation</h3>
          </div>
          {bullishList.map((stock: any) => {
            const { symbol, name } = resolveStock(stock.shortName);
            return (
              <div
                key={stock.stockId}
                onClick={() => onSelectStock(symbol)}
                className="flex justify-between items-center p-2.5 bg-slate-950/50 rounded-lg border border-emerald-500/10 hover:border-emerald-500/30 transition-all group cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggle(symbol); }}
                    className={cn(
                      "p-1.5 rounded-lg transition-all",
                      watchlist.includes(symbol) ? "bg-amber-500/20 text-amber-500" : "text-slate-700 hover:text-slate-400"
                    )}
                  >
                    <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(symbol) && "fill-amber-500")} />
                  </button>
                  <div>
                    <p className="text-xs font-black text-white group-hover:text-emerald-400 transition-colors uppercase">{symbol}</p>
                    {name && <p className="text-[9px] font-bold text-slate-500 truncate max-w-[140px]">{name}</p>}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-bold text-slate-500 tabular-nums">₹{stock.lastPrice}</span>
                      <span className="text-[9px] font-black text-slate-600 uppercase tracking-tighter bg-slate-900 px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-lg">+{stock.percentChange}%</span>
                  <p className="text-[9px] font-bold text-slate-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
                </div>
              </div>
            );
          })}
        </div>

        <div className="space-y-4">
          <div className="flex items-center gap-2 mb-4">
            <div className="w-2 h-2 rounded-full bg-rose-500 animate-pulse" />
            <h3 className="text-[10px] font-black text-rose-500 uppercase tracking-[0.2em]">Distribution Pressure</h3>
          </div>
          {bearishList.map((stock: any) => {
            const { symbol, name } = resolveStock(stock.shortName);
            return (
              <div
                key={stock.stockId}
                onClick={() => onSelectStock(symbol)}
                className="flex justify-between items-center p-2.5 bg-slate-950/50 rounded-lg border border-rose-500/10 hover:border-rose-500/30 transition-all group cursor-pointer"
              >
                <div className="flex items-center gap-3">
                  <button
                    onClick={(e) => { e.stopPropagation(); onToggle(symbol); }}
                    className={cn(
                      "p-1.5 rounded-lg transition-all",
                      watchlist.includes(symbol) ? "bg-amber-500/20 text-amber-500" : "text-slate-700 hover:text-slate-400"
                    )}
                  >
                    <WatchlistIcon className={cn("w-3.5 h-3.5", watchlist.includes(symbol) && "fill-amber-500")} />
                  </button>
                  <div>
                    <p className="text-xs font-black text-white group-hover:text-rose-400 transition-colors uppercase">{symbol}</p>
                    {name && <p className="text-[9px] font-bold text-slate-500 truncate max-w-[140px]">{name}</p>}
                    <div className="flex items-center gap-2 mt-0.5">
                      <span className="text-[10px] font-bold text-slate-500 tabular-nums">₹{stock.lastPrice}</span>
                      <span className="text-[9px] font-black text-slate-600 uppercase tracking-tighter bg-slate-900 px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-black text-rose-500 bg-rose-500/10 px-2 py-1 rounded-lg">{stock.percentChange}%</span>
                  <p className="text-[9px] font-bold text-slate-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
};
