import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { 
  Bookmark as WatchlistIcon, Minus 
} from 'lucide-react';
import { 
  ResponsiveContainer, BarChart, Bar 
} from 'recharts';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';
import { MarketData } from '../services/marketService';

interface WatchlistProps {
  watchlist: string[];
  stocks: MarketData[];
  watchlistDetails?: Array<{
    symbol: string;
    price?: number;
    name?: string;
    addedAt: string;
    source?: string;
  }>;
  onSelectStock: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

export const Watchlist: React.FC<WatchlistProps> = ({ 
  watchlist, 
  stocks, 
  watchlistDetails,
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
    const detail = watchlistDetails?.find(d => d.symbol === stock.symbol);
    
    return { 
      ...stock, 
      price: live ? live.price : stock.price, 
      changePct: live ? (live.changePct ?? stock.changePct) : stock.changePct,
      capturedPrice: detail?.price,
      capturedName: detail?.name,
      capturedDate: detail?.addedAt,
      capturedSource: detail?.source
    };
  });

  return (
    <div ref={ref} className="p-4 space-y-4">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-white tracking-tight flex items-center gap-2">
            <WatchlistIcon className="w-5 h-5 text-indigo-400" />
            My Watchlist
          </h2>
          <p className="text-zinc-500 text-xs mt-1">Tracking your selected assets</p>
        </div>
      </div>

      {watchlistStocks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {watchlistStocks.map(stock => {
            const isUp = stock.changePct >= 0;
            return (
              <Card 
                key={stock.symbol} 
                className="group hover:border-violet-500/30 transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between" 
                onClick={() => onSelectStock(stock.symbol)}
              >
                <div>
                  <div className="absolute top-0 right-0 p-4 z-10">
                    <button 
                      onClick={(e) => { e.stopPropagation(); onRemove(stock.symbol); }}
                      className="p-1.5 bg-rose-500/10 backdrop-blur-md rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-lg border border-rose-500/20"
                      title="Remove from Watchlist"
                    >
                      <Minus className="w-3.5 h-3.5" />
                    </button>
                  </div>
                  
                  <div className="flex justify-between items-start mb-2 pr-8">
                    <div className="min-w-0">
                      <h4 className="text-sm font-black text-white tracking-tight group-hover:text-amber-400 transition-colors uppercase italic leading-none truncate" title={stock.capturedName || stock.name}>
                        {stock.capturedName || stock.name}
                      </h4>
                      <p className="text-[9px] font-black text-zinc-500 tracking-widest mt-1 uppercase">{stock.symbol}</p>
                    </div>
                    <div className={cn(
                      "px-2 py-1 rounded-lg text-[10px] font-black shrink-0 ml-2 italic",
                      isUp ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                    )}>
                      {isUp ? '+' : ''}{stock.changePct}%
                    </div>
                  </div>
                  
                  <div className="mt-4 flex items-end justify-between">
                     <div>
                        <p className="text-[7px] font-black text-zinc-600 uppercase tracking-widest mb-1">LTP</p>
                        <p className="text-xl font-black text-white tabular-nums tracking-tight italic">₹{stock.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                     </div>
                     <div className="h-8 w-20">
                        <ResponsiveContainer width="100%" height="100%">
                           <BarChart data={Array.from({length: 8}, () => ({ v: Math.random() }))}>
                              <Bar dataKey="v" fill={isUp ? "#10b981" : "#f43f5e"} opacity={0.3} radius={[2, 2, 0, 0]} />
                           </BarChart>
                        </ResponsiveContainer>
                     </div>
                  </div>
                </div>

                {/* Enriched Watchlist Metadata Badging */}
                <div className="mt-4 pt-4 border-t border-white/[0.05] space-y-1.5 text-[8px] font-black text-zinc-500 uppercase tracking-widest">
                  {stock.capturedPrice != null && (
                    <div className="flex items-center justify-between">
                      <span>Captured Price</span>
                      <span className="text-zinc-300 italic font-black text-[9px]">₹{stock.capturedPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
                    </div>
                  )}
                  {stock.capturedSource && (
                    <div className="flex items-center justify-between">
                      <span>Added Via</span>
                      <span className="text-indigo-400 truncate max-w-[140px] font-black leading-none">{stock.capturedSource}</span>
                    </div>
                  )}
                  {stock.capturedDate && (
                    <div className="flex items-center justify-between">
                      <span>Added Date</span>
                      <span className="text-zinc-400 italic">
                        {new Date(stock.capturedDate).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' })}
                      </span>
                    </div>
                  )}
                </div>
              </Card>
            );
          })}
        </div>
      ) : (
        <div className="py-32 flex flex-col items-center justify-center bg-[#141416]/20 rounded-2xl border border-white/[0.05] border-dashed">
          <WatchlistIcon className="w-12 h-12 text-zinc-700 mb-5" />
          <h3 className="text-white font-semibold text-lg tracking-tight mb-2">Your Watchlist is Empty</h3>
          <p className="text-zinc-500 text-xs max-w-xs text-center leading-relaxed">
            Add stocks to track them here.
          </p>
        </div>
      )}
    </div>
  );
};
