import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { 
  Activity, TrendingUp, TrendingDown, Users, Trophy, 
  Bookmark as WatchlistIcon, Plus, Minus
} from 'lucide-react';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';

export const IndexOverview: React.FC<{ className?: string; onSelectIndex?: (id: string, name: string) => void }> = ({ className, onSelectIndex }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });

  const { data: indices, isLoading } = trpc.getAllIndices.useQuery(undefined, {
    enabled: isVisible,
    refetchInterval: isVisible ? 30000 : false,
  });

  const getIndexId = (name: string) => {
    if (name.includes('Nifty 50') || name.toUpperCase() === 'NIFTY 50') return '9';
    if (name.includes('Sensex') || name.toUpperCase() === 'SENSEX') return '4';
    if (name.includes('Bank Nifty') || name.toUpperCase() === 'BANK NIFTY') return '23';
    return '';
  };

  if (isLoading || !indices) return <div ref={ref} className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  const groups: { name: string; list: any[] }[] = (indices as any)?.data?.indiceList ?? [];
  const keyList = groups.find(g => g.name === 'Key Indices')?.list ?? [];

  return (
    <Card title="Key Market Indices" icon={Activity} className={className}>
      <div ref={ref} className="grid grid-cols-1 sm:grid-cols-3 gap-4 pt-2">
        {keyList.slice(0, 3).map((idx: any) => {
          const indexId = getIndexId(idx.name);
          const isClickable = !!indexId && !!onSelectIndex;
          
          return (
            <div 
              key={idx.name} 
              onClick={() => isClickable && onSelectIndex(indexId, idx.name)}
              className={cn(
                "p-4 bg-slate-950 border border-slate-800 rounded-2xl transition-all group relative overflow-hidden",
                isClickable ? "cursor-pointer hover:border-blue-500/30 hover:shadow-lg hover:translate-y-[-1px]" : ""
              )}
            >
              <div className="flex justify-between items-start mb-2">
                <h4 className="text-xs font-black text-slate-400 group-hover:text-white transition-colors uppercase tracking-widest">{idx.name}</h4>
                <span className={cn(
                  "text-[9px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter",
                  parseFloat(idx.percentChange) >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                )}>
                  {parseFloat(idx.percentChange) >= 0 ? '▲' : '▼'} {Math.abs(parseFloat(idx.percentChange)).toFixed(2)}%
                </span>
              </div>
              <div className="flex items-baseline gap-2">
                <span className="text-xl font-black text-white italic tracking-tight">{idx.lastPrice}</span>
                <span className={cn(
                  "text-[10px] font-bold",
                  parseFloat(idx.change) >= 0 ? "text-emerald-500" : "text-rose-500"
                )}>
                  {parseFloat(idx.change) >= 0 ? '+' : ''}{idx.change}
                </span>
              </div>
              
              {/* Dynamic bottom strip for click indicators */}
              {isClickable && (
                <div className="absolute bottom-0 left-0 right-0 h-[2px] bg-gradient-to-r from-blue-500 to-indigo-500 opacity-0 group-hover:opacity-100 transition-opacity" />
              )}
            </div>
          );
        })}
      </div>
    </Card>
  );
};

export const InstitutionalInsights: React.FC<{ symbol?: string; className?: string }> = ({ symbol, className }) => {
  const { data: instData } = trpc.getInstitutionalFlows.useQuery();
  const flows = instData?.data?.institutionalDetails ?? [];

  return (
    <Card title="Institutional Flows" icon={Users} className={className}>
      <div className="space-y-4 pt-2">
        {flows.slice(0, 2).map((flow: any) => (
          <div key={flow.category} className="p-4 bg-slate-950 border border-slate-800 rounded-2xl flex justify-between items-center">
            <div>
              <h4 className="text-xs font-black text-slate-400 uppercase tracking-widest">{flow.category} Activity</h4>
              <p className="text-[9px] font-bold text-slate-600 mt-1 uppercase tracking-wider">Date: {flow.date}</p>
            </div>
            <div className="text-right">
              <span className={cn(
                "text-sm font-black italic tracking-tight px-3 py-1 rounded-xl block mb-1",
                parseFloat(flow.netBuySell) >= 0 ? "bg-emerald-500/10 text-emerald-400 border border-emerald-500/10" : "bg-rose-500/10 text-rose-400 border border-rose-500/10"
              )}>
                {parseFloat(flow.netBuySell) >= 0 ? '+' : ''}₹{parseFloat(flow.netBuySell).toLocaleString()} Cr
              </span>
              <div className="flex gap-2 text-[9px] font-bold text-slate-500 justify-end">
                <span>B: ₹{parseFloat(flow.buyValue).toLocaleString()}</span>
                <span>•</span>
                <span>S: ₹{parseFloat(flow.sellValue).toLocaleString()}</span>
              </div>
            </div>
          </div>
        ))}
      </div>
    </Card>
  );
};

export const PennyStockIntelligence: React.FC<{ 
  watchlist: string[]; 
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock: (symbol: string) => void;
  className?: string;
}> = ({ watchlist, onToggleWatchlist, onSelectStock, className }) => {
  const { data: pennyData } = trpc.getETPennyStocks.useQuery();
  const pennies = pennyData?.searchResult?.searchData?.records?.slice(0, 5) || [];

  return (
    <Card title="Micro-Cap Opportunity" icon={Trophy} className={cn("h-full", className)}>
      <div className="overflow-x-auto pt-2">
        <table className="w-full">
          <thead>
            <tr className="border-b border-slate-800">
              <th className="pb-3 text-left text-[9px] font-black text-slate-500 uppercase tracking-widest">Symbol</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Price</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Wk %</th>
              <th className="pb-3 text-right text-[9px] font-black text-slate-500 uppercase tracking-widest">Vol Chg</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-slate-800/50">
            {pennies.map((stock: any) => (
              <tr key={stock.fincode || stock.symbol} className="group hover:bg-slate-900/50 transition-colors">
                <td className="py-3">
                  <div className="flex items-center gap-2">
                    <div onClick={(e) => e.stopPropagation()}>
                      {watchlist.includes(stock.symbol) ? (
                        <button 
                          onClick={() => onToggleWatchlist(stock.symbol)}
                          className="p-1 bg-rose-500/10 border border-rose-500/20 rounded text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-md flex items-center justify-center w-5.5 h-5.5"
                          title="Remove from Watchlist"
                        >
                          <Minus className="w-2.5 h-2.5" />
                        </button>
                      ) : (
                        <button 
                          onClick={() => onToggleWatchlist(stock.symbol, { price: parseFloat(stock.currentPrice || '0'), name: stock.companyName || stock.name, source: 'Micro-Cap Opportunity' })}
                          className="p-1 bg-emerald-500/10 border border-emerald-500/20 rounded text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all shadow-md flex items-center justify-center w-5.5 h-5.5"
                          title="Add to Watchlist"
                        >
                          <Plus className="w-2.5 h-2.5" />
                        </button>
                      )}
                    </div>
                    <div>
                      <p className="text-xs font-black text-white group-hover:text-amber-400 transition-colors uppercase cursor-pointer truncate max-w-[120px] leading-tight" onClick={() => onSelectStock(stock.symbol)}>
                        {stock.companyName || stock.name}
                      </p>
                      <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mt-0.5">{stock.symbol}</p>
                    </div>
                  </div>
                </td>
                <td className="py-3 text-right">
                  <p className="text-xs font-black text-white tabular-nums">₹{stock.currentPrice}</p>
                </td>
                <td className="py-3 text-right">
                  <span className={cn(
                    "text-[10px] font-black px-1.5 py-0.5 rounded",
                    parseFloat(stock.weekPercentChange) >= 0 ? "text-emerald-500 bg-emerald-500/10" : "text-rose-500 bg-rose-500/10"
                  )}>
                    {parseFloat(stock.weekPercentChange).toFixed(2)}%
                  </span>
                </td>
                <td className="py-3 text-right">
                  <p className="text-[10px] font-bold text-slate-500">{stock.volumeChange || '—'}</p>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  );
};
