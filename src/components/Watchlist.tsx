import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { 
  Bookmark as WatchlistIcon, Plus 
} from 'lucide-react';
import { 
  ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { MarketData } from '../services/marketService';

interface WatchlistProps {
  watchlist: string[];
  stocks: MarketData[];
  onSelectStock: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

export const Watchlist: React.FC<WatchlistProps> = ({ 
  watchlist, 
  stocks, 
  onSelectStock, 
  onRemove 
}) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });

  const { data: liveQuotes } = trpc.getLiveQuotesBatch.useQuery(watchlist, {
    enabled: isVisible && watchlist.length > 0,
    refetchInterval: isVisible ? 10000 : false,
  });

  const watchlistStocks = stocks.filter(s => watchlist.includes(s.symbol)).map(stock => {
    const live = liveQuotes?.find((q: any) => q.symbol === stock.symbol);
    if (live) {
      return { ...stock, price: live.price, changePct: live.changePct ?? stock.changePct };
    }
    return stock;
  });

  return (
    <div ref={ref} className="p-4 space-y-4">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <WatchlistIcon className="w-5 h-5 text-indigo-400" />
            My Watchlist
          </h2>
          <p className="text-slate-500 text-xs mt-1">Tracking your selected assets</p>
        </div>
      </div>

      {watchlistStocks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {watchlistStocks.map(stock => {
            const isUp = stock.changePct >= 0;
            return (
              <Card 
                key={stock.symbol} 
                className="group hover:border-blue-500/30 transition-all cursor-pointer relative overflow-hidden" 
                onClick={() => onSelectStock(stock.symbol)}
              >
                <div className="absolute top-0 right-0 p-4 z-10">
                  <button 
                    onClick={(e) => { e.stopPropagation(); onRemove(stock.symbol); }}
                    className="p-1.5 bg-slate-900/50 backdrop-blur-md rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-lg border border-slate-800"
                  >
                    <Plus className="w-3.5 h-3.5 rotate-45" />
                  </button>
                </div>
                
                <div className="flex justify-between items-start mb-2">
                  <div>
                    <h4 className="text-xs font-semibold text-white tracking-wider uppercase">{stock.symbol}</h4>
                    <p className="text-[10px] text-slate-500 truncate max-w-[120px]">{stock.name}</p>
                  </div>
                  <div className={cn(
                    "px-2 py-1 rounded-lg text-[10px] font-semibold",
                    isUp ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                  )}>
                    {isUp ? '+' : ''}{stock.changePct}%
                  </div>
                </div>
                
                <div className="mt-4 flex items-end justify-between">
                   <div>
                      <p className="text-[9px] text-slate-500 uppercase tracking-wider mb-1">Price</p>
                      <p className="text-xl font-bold text-white tabular-nums tracking-tight">₹{stock.price.toLocaleString()}</p>
                   </div>
                   <div className="h-8 w-20">
                      <ResponsiveContainer width="100%" height="100%">
                         <BarChart data={Array.from({length: 8}, () => ({ v: Math.random() }))}>
                            <Bar dataKey="v" fill={isUp ? "#10b981" : "#f43f5e"} opacity={0.3} radius={[2, 2, 0, 0]} />
                         </BarChart>
                      </ResponsiveContainer>
                   </div>
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="py-32 flex flex-col items-center justify-center bg-slate-900/20 rounded-2xl border border-white/[0.05] border-dashed">
          <WatchlistIcon className="w-12 h-12 text-slate-700 mb-5" />
          <h3 className="text-white font-semibold text-lg tracking-tight mb-2">Your Watchlist is Empty</h3>
          <p className="text-slate-500 text-xs max-w-xs text-center leading-relaxed">
            Add stocks to track them here.
          </p>
        </div>
      )}
    </div>
  );
};
