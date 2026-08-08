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
import { relativeFromNow, formatISTWithLocal } from '../lib/timeFormat';
import { AddToPortfolioButton } from './AddToPortfolioButton';

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
  userId?: string | null;
}

const WatchlistSparkline: React.FC<{ symbol: string; isUp: boolean; enabled: boolean }> = ({ symbol, isUp, enabled }) => {
  const { data } = trpc.getOHLCData.useQuery(
    { symbol, dur: '1m' },
    { enabled, staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  const bars = React.useMemo(() => {
    const closes: number[] = (data?.data ?? []).map((d: any) => d.close).filter((c: number) => Number.isFinite(c));
    return closes.slice(-8).map(v => ({ v }));
  }, [data]);

  if (bars.length < 2) return <div className="h-8 w-20" />;

  return (
    <div className="h-8 w-20">
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={bars}>
          <Bar dataKey="v" fill={isUp ? "#10b981" : "#f43f5e"} opacity={0.3} radius={[2, 2, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </div>
  );
};

export const Watchlist: React.FC<WatchlistProps> = ({
  watchlist,
  stocks,
  watchlistDetails,
  onSelectStock,
  onRemove,
  userId
}) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });

  const { data: liveQuotes, dataUpdatedAt: quotesUpdatedAt } = trpc.getLiveQuotesBatch.useQuery(watchlist, {
    enabled: isVisible && watchlist.length > 0,
    refetchInterval: isVisible ? 10000 : false,
  });

  // > 3x the poll interval means the last poll likely failed silently rather than the tab
  // just having been backgrounded (isVisible gates polling off entirely when backgrounded,
  // so a live stale reading here only fires while the panel is actually on-screen).
  const quotesAreStale = quotesUpdatedAt > 0 && Date.now() - quotesUpdatedAt > 30_000;

  const { data: closeSeries } = trpc.getRecentCloseSeries.useQuery(
    { symbols: watchlist, days: 15 },
    { enabled: isVisible && watchlist.length > 0, staleTime: 15 * 60_000 }
  );

  // Was an un-memoized filter->map with a nested O(n·m) .find() per row against liveQuotes and
  // watchlistDetails, recomputed on every render including the unrelated 10s liveQuotes poll
  // tick. Build lookup Maps once per data change instead of re-scanning both arrays per row.
  const watchlistStocks = React.useMemo(() => {
    const watchSet = new Set(watchlist);
    const liveBySymbol = new Map<string, any>((liveQuotes ?? []).map((q: any) => [q.symbol, q]));
    const detailBySymbol = new Map((watchlistDetails ?? []).map(d => [d.symbol, d]));
    return stocks.filter(s => watchSet.has(s.symbol)).map(stock => {
      const live = liveBySymbol.get(stock.symbol);
      const detail = detailBySymbol.get(stock.symbol);
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
  }, [stocks, watchlist, liveQuotes, watchlistDetails]);

  return (
    <div ref={ref} className="p-4 space-y-4">
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4">
        <div>
          <h2 className="text-xl font-bold text-slate-100 tracking-tight flex items-center gap-2">
            <WatchlistIcon className="w-5 h-5 text-indigo-400" />
            My Watchlist
          </h2>
          <p className="text-slate-400 text-xs mt-1">
            Tracking your selected assets
            {watchlistStocks.length > 0 && quotesUpdatedAt > 0 && (
              <span
                className={cn('ml-2', quotesAreStale ? 'text-amber-400 font-semibold' : 'text-slate-500')}
                title={formatISTWithLocal(quotesUpdatedAt)}
              >
                · prices {relativeFromNow(quotesUpdatedAt)}{quotesAreStale ? ' — may be delayed' : ''}
              </span>
            )}
          </p>
        </div>
      </div>

      {watchlistStocks.length > 0 ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
          {watchlistStocks.map(stock => {
            const isUp = stock.changePct >= 0;
            return (
              <Card 
                key={stock.symbol} 
                className="group hover:border-blue-500/30 transition-all cursor-pointer relative overflow-hidden flex flex-col justify-between" 
                onClick={() => onSelectStock(stock.symbol)}
              >
                <div>
                  <div className="absolute top-0 right-0 p-4 z-10 flex items-center gap-1.5">
                    <AddToPortfolioButton symbol={stock.symbol} currentPrice={stock.price} userId={userId} className="bg-slate-900/60 text-slate-300 backdrop-blur-md" />
                    <button
                      onClick={(e) => { e.stopPropagation(); onRemove(stock.symbol); }}
                      className="p-1.5 bg-rose-500/10 backdrop-blur-md rounded-lg text-rose-500 hover:bg-rose-500 hover:text-indigo-600 transition-all shadow-lg border border-rose-500/20"
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
                      <p className="text-[10px] font-black text-slate-400 tracking-widest mt-1 uppercase">{stock.symbol}</p>
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
                        <p className="text-[7px] font-black text-slate-400 uppercase tracking-widest mb-1">LTP</p>
                        <p className="text-xl font-black text-white tabular-nums tracking-tight italic">₹{stock.price.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</p>
                     </div>
                     <div className="h-8 w-20">
                        {(() => {
                          const closes = closeSeries?.[stock.symbol];
                          if (!closes || closes.length < 2) {
                            return <span className="text-[8px] text-slate-600 italic">No trend yet</span>;
                          }
                          const data = closes.map(v => ({ v }));
                          return (
                            <ResponsiveContainer width="100%" height="100%">
                               <BarChart data={data}>
                                  <Bar dataKey="v" fill={isUp ? "#10b981" : "#f43f5e"} opacity={0.5} radius={[2, 2, 0, 0]} />
                               </BarChart>
                            </ResponsiveContainer>
                          );
                        })()}
                     </div>
                  </div>
                </div>

                {/* Enriched Watchlist Metadata Badging */}
                <div className="mt-4 pt-4 border-t border-slate-800/30 space-y-1.5 text-[9.5px] font-black text-slate-400 uppercase tracking-widest">
                  {stock.capturedPrice != null && (
                    <div className="flex items-center justify-between">
                      <span>Captured Price</span>
                      <span className="text-slate-300 italic font-black text-[10px]">₹{stock.capturedPrice.toLocaleString('en-IN', { minimumFractionDigits: 2 })}</span>
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
                      <span className="text-slate-400 italic">
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
        <div className="py-32 flex flex-col items-center justify-center bg-slate-950/20 rounded-2xl border border-white/[0.05] border-dashed">
          <WatchlistIcon className="w-12 h-12 text-slate-300 mb-5" />
          <h3 className="text-white font-semibold text-lg tracking-tight mb-2">Your Watchlist is Empty</h3>
          <p className="text-slate-400 text-xs max-w-xs text-center leading-relaxed">
            Add stocks to track them here.
          </p>
        </div>
      )}
    </div>
  );
};
