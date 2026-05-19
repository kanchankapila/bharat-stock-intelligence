import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Zap, Bookmark as WatchlistIcon, Plus, Minus } from 'lucide-react';
import stockData from '../data/stocklist';

interface MomentumIntelligenceProps {
  watchlist: string[];
  onToggle: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
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
                className="flex justify-between items-center p-2.5 bg-[#0c0c0e]/50 rounded-lg border border-emerald-500/10 hover:border-emerald-500/30 transition-all group cursor-pointer animate-fade-in"
              >
                <div className="flex items-center gap-3">
                  <div onClick={(e) => e.stopPropagation()}>
                    {watchlist.includes(symbol) ? (
                      <button
                        onClick={() => onToggle(symbol)}
                        className="p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-md flex items-center justify-center w-7 h-7"
                        title="Remove from Watchlist"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onToggle(symbol, { price: parseFloat(stock.lastPrice || '0'), name, source: 'Momentum: Accumulation' })}
                        className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all shadow-md flex items-center justify-center w-7 h-7"
                        title="Add to Watchlist"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-black text-white group-hover:text-emerald-400 transition-colors uppercase leading-none truncate max-w-[150px]">{name || symbol}</p>
                    <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest mt-1 leading-none">{symbol}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] font-bold text-zinc-500 tabular-nums">₹{stock.lastPrice}</span>
                      <span className="text-[9px] font-black text-zinc-600 uppercase tracking-tighter bg-[#141416] px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-black text-emerald-500 bg-emerald-500/10 px-2 py-1 rounded-lg">+{stock.percentChange}%</span>
                  <p className="text-[9px] font-bold text-zinc-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
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
                className="flex justify-between items-center p-2.5 bg-[#0c0c0e]/50 rounded-lg border border-rose-500/10 hover:border-rose-500/30 transition-all group cursor-pointer animate-fade-in"
              >
                <div className="flex items-center gap-3">
                  <div onClick={(e) => e.stopPropagation()}>
                    {watchlist.includes(symbol) ? (
                      <button
                        onClick={() => onToggle(symbol)}
                        className="p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-md flex items-center justify-center w-7 h-7"
                        title="Remove from Watchlist"
                      >
                        <Minus className="w-3.5 h-3.5" />
                      </button>
                    ) : (
                      <button
                        onClick={() => onToggle(symbol, { price: parseFloat(stock.lastPrice || '0'), name, source: 'Momentum: Distribution' })}
                        className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all shadow-md flex items-center justify-center w-7 h-7"
                        title="Add to Watchlist"
                      >
                        <Plus className="w-3.5 h-3.5" />
                      </button>
                    )}
                  </div>
                  <div>
                    <p className="text-xs font-black text-white group-hover:text-rose-400 transition-colors uppercase leading-none truncate max-w-[150px]">{name || symbol}</p>
                    <p className="text-[8px] font-black text-zinc-500 uppercase tracking-widest mt-1 leading-none">{symbol}</p>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] font-bold text-zinc-500 tabular-nums">₹{stock.lastPrice}</span>
                      <span className="text-[9px] font-black text-zinc-600 uppercase tracking-tighter bg-[#141416] px-1.5 py-0.5 rounded italic">RSI: {stock.rsi}</span>
                    </div>
                  </div>
                </div>
                <div className="text-right">
                  <span className="text-[10px] font-black text-rose-500 bg-rose-500/10 px-2 py-1 rounded-lg">{stock.percentChange}%</span>
                  <p className="text-[9px] font-bold text-zinc-600 mt-1 uppercase tracking-widest">{stock.trend}</p>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </Card>
  );
};
