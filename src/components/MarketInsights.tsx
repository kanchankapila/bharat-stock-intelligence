import React from 'react';
import { Card } from './Card';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { 
  Activity, TrendingUp, TrendingDown, Users, Trophy, 
  Bookmark as WatchlistIcon 
} from 'lucide-react';
import { useIntersectionObserver } from '../hooks/useIntersectionObserver';

export const IndexOverview: React.FC<{ className?: string }> = ({ className }) => {
  const ref = React.useRef<HTMLDivElement>(null);
  const isVisible = useIntersectionObserver(ref, { threshold: 0.1 });

  const { data: indices, isLoading } = trpc.getAllIndices.useQuery(undefined, {
    enabled: isVisible,
    refetchInterval: isVisible ? 30000 : false,
  });

  if (isLoading || !indices) return <div ref={ref} className="h-40 bg-slate-900/50 animate-pulse rounded-2xl" />;

  const groups: { name: string; list: any[] }[] = (indices as any)?.data?.indiceList ?? [];
  const keyList = groups.find(g => g.name === 'Key Indices')?.list ?? [];

  return (
    <div ref={ref}>
      <Card title="Market Watch" icon={Activity} className={cn("h-full", className)}>
        <div className="space-y-3 pt-2">
          {keyList.slice(0, 8).filter((idx: any) => idx.name).map((idx: any) => {
            const isUp = Number(idx.direction) === 1 || parseFloat(idx.changePer ?? '0') >= 0;
            const pct = parseFloat(idx.changePer ?? '0');
            return (
              <div key={idx.name} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50 hover:border-slate-700 transition-all">
                <div>
                  <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">{idx.name}</p>
                  <p className="text-sm font-black text-white tabular-nums mt-0.5">{idx.value}</p>
                </div>
                <div className="text-right">
                  <div className={cn(
                    "flex items-center gap-1 text-[10px] font-black px-2 py-0.5 rounded",
                    isUp ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                  )}>
                    {isUp ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                    {isUp ? '+' : ''}{pct.toFixed(2)}%
                  </div>
                  <p className={cn("text-[9px] font-bold mt-1 tabular-nums", isUp ? "text-emerald-600" : "text-rose-600")}>
                    {isUp ? '+' : ''}{idx.change}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </Card>
    </div>
  );
};

export const InstitutionalInsights: React.FC<{ symbol?: string; className?: string }> = ({ symbol = 'RELIANCE', className }) => {
  const { data: mfData } = trpc.getMFInvestments.useQuery({ symbol });
  const mfs = mfData?.Table || [];

  return (
    <Card title={`Institutional Velocity (${symbol})`} icon={Users} className={cn("h-full", className)}>
      <div className="space-y-4 pt-2">
        <div className="p-3 bg-blue-600/10 border border-blue-500/20 rounded-xl">
          <p className="text-[10px] font-black text-blue-400 uppercase tracking-widest mb-1">Top Active Insight</p>
          <p className="text-xs text-slate-300 italic leading-relaxed">
            Institutional activity tracks heavy volume inflows into index leaders. Reliability: <span className="text-white font-black">94%</span>
          </p>
        </div>
        
        <div className="space-y-3">
          <h4 className="text-[9px] font-black text-slate-600 uppercase tracking-[0.2em] mb-2">Major MF Positions</h4>
          {mfs.slice(0, 5).map((mf: any, idx: number) => (
            <div key={idx} className="flex justify-between items-center p-2 bg-slate-950 rounded-lg border border-slate-800/50">
              <div className="flex-1 mr-4">
                <p className="text-[10px] font-black text-white line-clamp-1 uppercase tracking-tight">{mf.schemeName}</p>
                <p className="text-[9px] font-bold text-slate-500 mt-0.5">{mf.marketValue} Cr held</p>
              </div>
              <div className="text-right">
                <p className="text-[10px] font-black text-white italic">{mf.percentToAum}%</p>
                <p className="text-[9px] font-bold text-slate-600 uppercase tracking-tighter">of AUM</p>
              </div>
            </div>
          ))}
        </div>
      </div>
    </Card>
  );
};

export const PennyStockIntelligence: React.FC<{ 
  watchlist: string[]; 
  onToggleWatchlist: (symbol: string) => void;
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
                    <button 
                      onClick={() => onToggleWatchlist(stock.symbol)}
                      className={cn(
                        "p-1 rounded-lg transition-all",
                        watchlist.includes(stock.symbol) ? "bg-amber-500/20 text-amber-500" : "text-slate-600 hover:text-slate-400"
                      )}
                    >
                      <WatchlistIcon className={cn("w-3 h-3", watchlist.includes(stock.symbol) && "fill-amber-500")} />
                    </button>
                    <div>
                      <p className="text-xs font-black text-white group-hover:text-amber-400 transition-colors uppercase cursor-pointer" onClick={() => onSelectStock(stock.symbol)}>{stock.symbol}</p>
                      <p className="text-[9px] font-bold text-slate-600 line-clamp-1">{stock.companyName || stock.name}</p>
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
