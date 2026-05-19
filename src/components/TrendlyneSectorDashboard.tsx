import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ArrowUpDown, TrendingUp, TrendingDown, PieChart, Activity, Layers } from 'lucide-react';

interface SectorData {
  name: { stockName: string; url: string | null };
  sp_count: number;
  market_cap: number;
  weighted_avg_ms: number;
  rsi_gt_50: number;
  mfi_gt_50: number;
  currentPrice_gt_sma_20: number;
  currentPrice_gt_sma_50: number;
  currentPrice_gt_sma_200: number;
  sma_50_gt_sma_200: number;
  gainers_today: number;
  gainers_week: number;
}

export const TrendlyneSectorDashboard: React.FC = () => {
  const [viewMode, setViewMode] = useState<'sectors' | 'indices'>('sectors');
  const [sortField, setSortField] = useState<keyof SectorData | 'name'>('weighted_avg_ms');
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('desc');

  const { data: sectorResponse, isLoading: isSectorLoading, error: sectorError } = trpc.getTrendlyneSectorRotation.useQuery(undefined, { enabled: viewMode === 'sectors' });
  const { data: indexResponse, isLoading: isIndexLoading, error: indexError } = trpc.getTrendlyneIndexRotation.useQuery(undefined, { enabled: viewMode === 'indices' });

  const isLoading = viewMode === 'sectors' ? isSectorLoading : isIndexLoading;
  const error = viewMode === 'sectors' ? sectorError : indexError;
  const currentDataResponse = viewMode === 'sectors' ? sectorResponse : indexResponse;

  const handleSort = (field: keyof SectorData | 'name') => {
    if (sortField === field) {
      setSortDir(sortDir === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortDir('desc');
    }
  };

  const getMomentumColor = (score: number) => {
    if (score >= 55) return "text-emerald-400 bg-emerald-500/10 border-emerald-500/20";
    if (score >= 45) return "text-amber-400 bg-amber-500/10 border-amber-500/20";
    return "text-rose-400 bg-rose-500/10 border-rose-500/20";
  };

  const renderSortIcon = (field: string) => {
    if (sortField !== field) return <ArrowUpDown className="w-3 h-3 ml-1 opacity-20 group-hover:opacity-100 transition-opacity" />;
    return sortDir === 'desc' ? <TrendingDown className="w-3 h-3 ml-1 text-violet-400" /> : <TrendingUp className="w-3 h-3 ml-1 text-violet-400" />;
  };

  const renderContent = () => {
    if (isLoading) {
      return (
        <div className="flex flex-col items-center justify-center h-64 bg-[#141416]/80 rounded-2xl border border-white/[0.07] animate-pulse">
          <Activity className="w-8 h-8 text-violet-500 animate-spin mb-4" />
          <p className="text-zinc-400 text-sm font-bold uppercase tracking-widest">Loading Data...</p>
        </div>
      );
    }

    if (error || !currentDataResponse?.body?.tableData) {
      return (
        <div className="p-6 bg-[#141416]/80 rounded-2xl border border-rose-900/50 flex flex-col items-center justify-center">
          <Activity className="w-8 h-8 text-rose-500 mb-4" />
          <p className="text-rose-400 font-bold">Failed to load data.</p>
          <p className="text-zinc-500 text-sm mt-2">{error?.message || "Data unavailable"}</p>
        </div>
      );
    }

    const items: SectorData[] = currentDataResponse.body.tableData;

    const sortedItems = [...items].sort((a: any, b: any) => {
      let aVal = a[sortField];
      let bVal = b[sortField];
      if (sortField === 'name') {
        aVal = a.name.stockName;
        bVal = b.name.stockName;
        return sortDir === 'asc' ? aVal.localeCompare(bVal) : bVal.localeCompare(aVal);
      }
      return sortDir === 'asc' ? aVal - bVal : bVal - aVal;
    });

    return (
      <>
        <div className="grid grid-cols-1 lg:grid-cols-4 gap-4 mb-6">
          <div className="lg:col-span-4 grid grid-cols-2 md:grid-cols-4 gap-4">
             {sortedItems.slice(0, 4).map((s) => (
               <div key={s.name.stockName} className="bg-[#141416] border border-white/[0.07] rounded-xl p-4 flex flex-col justify-between hover:border-white/[0.1] transition-colors">
                 <div className="flex justify-between items-start mb-4">
                   <h3 className="text-sm font-black text-zinc-300 uppercase tracking-tight leading-tight">{s.name.stockName}</h3>
                   <div className={cn("px-2 py-1 rounded text-[10px] font-black border", getMomentumColor(s.weighted_avg_ms))}>
                      {s.weighted_avg_ms.toFixed(1)} MS
                   </div>
                 </div>
                 <div className="grid grid-cols-2 gap-2 text-[10px] uppercase font-bold tracking-widest text-zinc-500">
                   <div>
                     <span className="block text-zinc-400 mb-0.5">RSI &gt; 50</span>
                     <span className={s.rsi_gt_50 > 50 ? "text-emerald-400" : "text-rose-400"}>{s.rsi_gt_50}%</span>
                   </div>
                   <div>
                     <span className="block text-zinc-400 mb-0.5">Day Gainers</span>
                     <span className={s.gainers_today > 50 ? "text-emerald-400" : "text-rose-400"}>{s.gainers_today}%</span>
                   </div>
                   <div>
                     <span className="block text-zinc-400 mb-0.5">LTP &gt; SMA20</span>
                     <span className={s.currentPrice_gt_sma_20 > 50 ? "text-emerald-400" : "text-rose-400"}>{s.currentPrice_gt_sma_20}%</span>
                   </div>
                   <div>
                     <span className="block text-zinc-400 mb-0.5">Week Gainers</span>
                     <span className={s.gainers_week > 50 ? "text-emerald-400" : "text-rose-400"}>{s.gainers_week}%</span>
                   </div>
                 </div>
               </div>
             ))}
          </div>
        </div>

        <div className="bg-[#141416] border border-white/[0.07] rounded-2xl overflow-hidden">
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="bg-[#0c0c0e]/50 border-b border-white/[0.07] text-[10px] font-black text-zinc-500 uppercase tracking-widest">
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('name')}>
                    <div className="flex items-center">{viewMode === 'sectors' ? 'Sector' : 'Index'} {renderSortIcon('name')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('weighted_avg_ms')}>
                    <div className="flex items-center">Momentum Score {renderSortIcon('weighted_avg_ms')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('rsi_gt_50')}>
                    <div className="flex items-center">RSI &gt; 50 {renderSortIcon('rsi_gt_50')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('currentPrice_gt_sma_20')}>
                    <div className="flex items-center">LTP &gt; SMA20 {renderSortIcon('currentPrice_gt_sma_20')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('sma_50_gt_sma_200')}>
                    <div className="flex items-center">SMA50 &gt; SMA200 {renderSortIcon('sma_50_gt_sma_200')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('gainers_today')}>
                    <div className="flex items-center">Day Gainers {renderSortIcon('gainers_today')}</div>
                  </th>
                  <th className="p-4 cursor-pointer group" onClick={() => handleSort('gainers_week')}>
                    <div className="flex items-center">Week Gainers {renderSortIcon('gainers_week')}</div>
                  </th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800">
                {sortedItems.map((s) => (
                  <tr key={s.name.stockName} className="hover:bg-white/[0.05] transition-colors">
                    <td className="p-4">
                      <div className="flex flex-col">
                        <span className="font-bold text-zinc-200">{s.name.stockName}</span>
                        <span className="text-[10px] text-zinc-500 mt-1">{s.sp_count} Stocks</span>
                      </div>
                    </td>
                    <td className="p-4">
                      <span className={cn("px-2 py-1 rounded text-[11px] font-black inline-block border", getMomentumColor(s.weighted_avg_ms))}>
                        {s.weighted_avg_ms.toFixed(1)}
                      </span>
                    </td>
                    <td className="p-4">
                       <span className={cn("font-medium", s.rsi_gt_50 > 50 ? "text-emerald-400" : "text-rose-400")}>
                          {s.rsi_gt_50}%
                       </span>
                    </td>
                    <td className="p-4">
                       <span className={cn("font-medium", s.currentPrice_gt_sma_20 > 50 ? "text-emerald-400" : "text-rose-400")}>
                          {s.currentPrice_gt_sma_20}%
                       </span>
                    </td>
                    <td className="p-4">
                       <span className={cn("font-medium", s.sma_50_gt_sma_200 > 50 ? "text-emerald-400" : "text-rose-400")}>
                          {s.sma_50_gt_sma_200}%
                       </span>
                    </td>
                    <td className="p-4">
                       <span className={cn("font-medium", s.gainers_today > 50 ? "text-emerald-400" : "text-rose-400")}>
                          {s.gainers_today}%
                       </span>
                    </td>
                    <td className="p-4">
                       <span className={cn("font-medium", s.gainers_week > 50 ? "text-emerald-400" : "text-rose-400")}>
                          {s.gainers_week}%
                       </span>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      </>
    );
  };

  return (
    <div className="space-y-6">
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-black text-white tracking-tight uppercase italic flex items-center gap-3">
            <PieChart className="w-6 h-6 text-violet-500" />
            Market Rotation Dashboard
          </h2>
          <p className="text-zinc-400 text-sm font-medium mt-1 flex items-center gap-2">
            Data sourced from Trendlyne
            {currentDataResponse?.body?.last_updated && (
              <span className="text-[10px] bg-white/[0.08] px-2 py-0.5 rounded text-zinc-300">
                Updated: {currentDataResponse.body.last_updated}
              </span>
            )}
          </p>
        </div>
        <div className="flex items-center p-1 bg-[#141416] border border-white/[0.07] rounded-xl">
           <button
             onClick={() => setViewMode('sectors')}
             className={cn(
               "px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors flex items-center gap-2",
               viewMode === 'sectors' ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]/50"
             )}
           >
             <PieChart className="w-4 h-4" /> Sectors
           </button>
           <button
             onClick={() => setViewMode('indices')}
             className={cn(
               "px-4 py-2 rounded-lg text-xs font-black uppercase tracking-wider transition-colors flex items-center gap-2",
               viewMode === 'indices' ? "bg-blue-600 text-white" : "text-zinc-400 hover:text-zinc-200 hover:bg-white/[0.08]/50"
             )}
           >
             <Layers className="w-4 h-4" /> Indices
           </button>
        </div>
      </div>

      {renderContent()}
    </div>
  );
};
