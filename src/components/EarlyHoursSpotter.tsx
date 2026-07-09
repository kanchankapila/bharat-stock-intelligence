import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { 
  Zap, TrendingUp, TrendingDown, RefreshCw, AlertCircle, 
  Info, Sparkles, Volume2, ArrowUpRight, BarChart3, Bookmark, 
  FileText, Activity, Layers, CheckCircle2
} from 'lucide-react';
import { cn } from '../lib/utils';

interface EarlyHoursSpotterProps {
  onSelectStock: (symbol: string) => void;
}

export default function EarlyHoursSpotter({ onSelectStock }: EarlyHoursSpotterProps) {
  const [selectedDate, setSelectedDate] = useState<string>('');
  
  const { data: candidates, isLoading, error, refetch, isRefetching } = 
    trpc.getEarlyHoursPredictions.useQuery(
      selectedDate ? { date: selectedDate } : undefined,
      { staleTime: 30000 }
    );

  const refreshMutation = trpc.refreshEarlyHoursSpotter.useMutation();

  const handleRefresh = async () => {
    try {
      await refreshMutation.mutateAsync();
      await refetch();
    } catch (err) {
      console.error("Manual pre-open refresh failed:", err);
    }
  };

  const getScoreColor = (score: number) => {
    if (score >= 50) return 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20';
    if (score >= 40) return 'text-sky-400 bg-sky-500/10 border-sky-500/20';
    return 'text-amber-400 bg-amber-500/10 border-amber-500/20';
  };

  const getImbalanceLabel = (val: number) => {
    if (val > 0.4) return { text: 'Buy Heavy', color: 'text-emerald-400', pct: (val + 1) * 50 };
    if (val > 0.1) return { text: 'Moderate Buy', color: 'text-emerald-300', pct: (val + 1) * 50 };
    if (val < -0.4) return { text: 'Sell Heavy', color: 'text-rose-400', pct: (val + 1) * 50 };
    if (val < -0.1) return { text: 'Moderate Sell', color: 'text-rose-300', pct: (val + 1) * 50 };
    return { text: 'Balanced', color: 'text-slate-400', pct: 50 };
  };

  if (isLoading) {
    return (
      <div className="p-6 space-y-6">
        <div className="h-20 bg-slate-900/50 rounded-3xl animate-pulse border border-slate-800" />
        <div className="grid grid-cols-1 md:grid-cols-4 gap-4">
          {[...Array(4)].map((_, i) => (
            <div key={i} className="h-24 bg-slate-900/50 rounded-2xl animate-pulse border border-slate-800" />
          ))}
        </div>
        <div className="h-96 bg-slate-900/50 rounded-3xl animate-pulse border border-slate-800" />
      </div>
    );
  }

  if (error) {
    return (
      <div className="p-6 text-center max-w-md mx-auto space-y-4">
        <AlertCircle className="w-12 h-12 text-rose-500 mx-auto" />
        <h3 className="text-lg font-black text-white uppercase tracking-wider">Failed to load Early Hours predictions</h3>
        <p className="text-slate-400 text-xs">{error.message}</p>
        <button 
          onClick={() => refetch()}
          className="px-4 py-2 bg-blue-600 hover:bg-blue-700 text-white font-bold rounded-xl transition-all flex items-center gap-2 mx-auto"
        >
          <RefreshCw className="w-4 h-4" /> Retry
        </button>
      </div>
    );
  }

  const items = candidates || [];

  // Summary Metrics
  const avgScore = items.length ? Math.round(items.reduce((acc, c) => acc + c.score, 0) / items.length) : 0;
  const topGainer = items.length ? [...items].sort((a, b) => b.iepGapPct - a.iepGapPct)[0] : null;
  const topDelSpike = items.length ? [...items].sort((a, b) => b.deliverySpikePct - a.deliverySpikePct)[0] : null;
  const hasNewsCount = items.filter(c => c.hasCorporateAction).length;

  return (
    <div className="p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 bg-slate-900/40 border border-slate-800 rounded-3xl p-6 relative overflow-hidden backdrop-blur-md">
        <div className="absolute inset-0 bg-gradient-to-r from-amber-500/5 to-transparent pointer-events-none" />
        <div className="space-y-1 relative">
          <h1 className="text-3xl font-black text-white tracking-tighter uppercase italic flex items-center gap-3">
            <Zap className="w-8 h-8 text-amber-500 fill-amber-500/20 animate-pulse" />
            Early Hours Spotter
          </h1>
          <p className="text-slate-400 text-xs font-medium max-w-xl">
            Spotting morning breakout moves right at market open (9:00 AM – 9:20 AM) by screening pre-open buy imbalance, corporate action filings, delivery spikes, and immediate moving average crossovers.
          </p>
        </div>
        <div className="flex items-center gap-3 relative shrink-0">
          <button 
            onClick={handleRefresh}
            disabled={isRefetching || refreshMutation.isPending}
            className="p-3 bg-slate-950 hover:bg-slate-800 text-slate-400 hover:text-white border border-slate-800 rounded-xl transition-all cursor-pointer disabled:opacity-50"
            title="Refresh Pre-Open Predictions"
          >
            <RefreshCw className={cn("w-4 h-4", (isRefetching || refreshMutation.isPending) && "animate-spin")} />
          </button>
          <div className="bg-slate-950 border border-slate-800 rounded-xl px-4 py-2 flex flex-col justify-center">
            <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">Active Session</span>
            <span className="text-xs font-black text-white tabular-nums tracking-wider">{items[0]?.date || 'Market Closed'}</span>
          </div>
        </div>
      </div>

      {/* Summary Cards */}
      {items.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-4 gap-4">
          {/* Average Score */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden backdrop-blur-md">
            <div className="p-3 bg-amber-500/10 rounded-xl text-amber-500 border border-amber-500/10">
              <Sparkles className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Avg spot score</p>
              <p className="text-xl font-black text-white italic mt-0.5">{avgScore} <span className="text-xs text-slate-500 font-bold uppercase tracking-widest italic">/ 100</span></p>
            </div>
          </div>

          {/* Top Gap Up */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden backdrop-blur-md">
            <div className="p-3 bg-emerald-500/10 rounded-xl text-emerald-500 border border-emerald-500/10">
              <TrendingUp className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Top opening gap</p>
              {topGainer && (
                <p className="text-sm font-black text-white italic mt-0.5 uppercase tracking-wider group cursor-pointer hover:text-blue-400" onClick={() => onSelectStock(topGainer.symbol)}>
                  {topGainer.symbol} <span className="text-emerald-400">+{topGainer.iepGapPct.toFixed(1)}%</span>
                </p>
              )}
            </div>
          </div>

          {/* Top Delivery Spike */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden backdrop-blur-md">
            <div className="p-3 bg-blue-500/10 rounded-xl text-blue-500 border border-blue-500/10">
              <Volume2 className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Top delivery spike</p>
              {topDelSpike && (
                <p className="text-sm font-black text-white italic mt-0.5 uppercase tracking-wider cursor-pointer hover:text-blue-400" onClick={() => onSelectStock(topDelSpike.symbol)}>
                  {topDelSpike.symbol} <span className="text-blue-400">+{topDelSpike.deliverySpikePct.toFixed(0)}%</span>
                </p>
              )}
            </div>
          </div>

          {/* Corporate Action Confluence */}
          <div className="bg-slate-900/40 border border-slate-800 rounded-2xl p-4 flex items-center gap-4 relative overflow-hidden backdrop-blur-md">
            <div className="p-3 bg-purple-500/10 rounded-xl text-purple-500 border border-purple-500/10">
              <FileText className="w-5 h-5" />
            </div>
            <div>
              <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest">Event confluence</p>
              <p className="text-xl font-black text-white italic mt-0.5">{hasNewsCount} <span className="text-xs text-slate-500 font-bold uppercase tracking-widest italic">stocks</span></p>
            </div>
          </div>
        </div>
      )}

      {/* Main Table Panel */}
      <div className="bg-slate-900/40 border border-slate-800 rounded-3xl p-6 relative overflow-hidden backdrop-blur-md">
        {items.length === 0 ? (
          <div className="py-20 text-center space-y-4">
            <Sparkles className="w-12 h-12 text-slate-700 mx-auto" />
            <p className="text-slate-500 text-sm font-bold uppercase tracking-widest italic">No candidates met the morning breakout filters today</p>
            <p className="text-slate-600 text-xs max-w-sm mx-auto">Candidates qualify when they show combined scores exceeding 35 points, factoring pre-open imbalance, gaps, and previous evening delivery volumes.</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="border-b border-slate-800 text-[10px] font-black text-slate-500 uppercase tracking-widest">
                  <th className="pb-4">Candidate Stock</th>
                  <th className="pb-4 text-center">Spot Score</th>
                  <th className="pb-4">Pre-Open Imbalance</th>
                  <th className="pb-4 text-center">Opening Gap</th>
                  <th className="pb-4 text-center">Delivery Spike</th>
                  <th className="pb-4">MA Breakout Signals</th>
                  <th className="pb-4 text-right">Actions</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/50">
                {items.map((row: any) => {
                  const imbalanceMeta = getImbalanceLabel(row.preopenImbalance);
                  return (
                    <tr 
                      key={row.symbol}
                      className="group hover:bg-slate-800/10 transition-colors"
                    >
                      {/* Candidate Stock */}
                      <td className="py-4">
                        <div className="flex flex-col">
                          <span 
                            onClick={() => onSelectStock(row.symbol)}
                            className="text-sm font-black text-white italic uppercase tracking-wider group-hover:text-blue-400 cursor-pointer transition-colors flex items-center gap-1.5"
                          >
                            {row.symbol}
                            {row.hasCorporateAction && (
                              <span className="w-2 h-2 rounded-full bg-purple-500 animate-ping inline-block" title="Corporate Filings Active" />
                            )}
                          </span>
                        </div>
                      </td>

                      {/* Spot Score */}
                      <td className="py-4">
                        <div className="flex flex-col items-center justify-center">
                          <span className={cn(
                            "px-2.5 py-1 rounded-full text-xs font-black italic border tracking-wide min-w-[50px] text-center",
                            getScoreColor(row.score)
                          )}>
                            {row.score.toFixed(0)}
                          </span>
                        </div>
                      </td>

                      {/* Pre-Open Imbalance */}
                      <td className="py-4">
                        <div className="space-y-1.5 max-w-[150px]">
                          <div className="flex justify-between items-center text-[10px] font-bold">
                            <span className={imbalanceMeta.color}>{imbalanceMeta.text}</span>
                            <span className="text-slate-400 tabular-nums">{row.preopenImbalance ? (row.preopenImbalance > 0 ? '+' : '') + row.preopenImbalance.toFixed(2) : '0.00'}</span>
                          </div>
                          <div className="h-1.5 bg-slate-850 rounded-full overflow-hidden flex">
                            <div 
                              className={cn(
                                "h-full rounded-full transition-all",
                                row.preopenImbalance > 0 ? "bg-emerald-500" : "bg-rose-500"
                              )} 
                              style={{ width: `${imbalanceMeta.pct}%` }} 
                            />
                          </div>
                        </div>
                      </td>

                      {/* Opening Gap */}
                      <td className="py-4 text-center">
                        <span className={cn(
                          "inline-flex items-center gap-1 text-xs font-black px-2.5 py-0.5 rounded-md border",
                          row.iepGapPct >= 0 
                            ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400" 
                            : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                        )}>
                          {row.iepGapPct >= 0 ? '+' : ''}{row.iepGapPct.toFixed(2)}%
                        </span>
                      </td>

                      {/* Delivery Spike */}
                      <td className="py-4 text-center">
                        <div className="flex flex-col items-center">
                          <span className={cn(
                            "text-xs font-black tabular-nums tracking-tighter",
                            row.deliverySpikePct > 30 ? "text-blue-400" : "text-slate-400"
                          )}>
                            {row.deliverySpikePct >= 0 ? '+' : ''}{row.deliverySpikePct.toFixed(0)}%
                          </span>
                          <span className="text-[7px] text-slate-500 uppercase tracking-widest font-black mt-0.5">vs 5d avg</span>
                        </div>
                      </td>

                      {/* MA Breakout Signals */}
                      <td className="py-4">
                        <div className="flex flex-wrap gap-1.5 max-w-[280px]">
                          {row.breakoutSignals.length === 0 ? (
                            <span className="text-slate-600 text-[10px] font-bold italic uppercase tracking-wider">No breakouts triggered</span>
                          ) : (
                            row.breakoutSignals.map((sig: string) => {
                              const isBreakout = sig.includes('Breakout');
                              return (
                                <span 
                                  key={sig}
                                  className={cn(
                                    "px-1.5 py-0.5 rounded border text-[9px] font-black uppercase tracking-wider shrink-0",
                                    isBreakout 
                                      ? "bg-amber-500/10 border-amber-500/25 text-amber-500" 
                                      : "bg-slate-800/30 border-slate-700/30 text-slate-400"
                                  )}
                                >
                                  {sig}
                                </span>
                              );
                            })
                          )}
                        </div>
                      </td>

                      {/* Actions / Triggers */}
                      <td className="py-4 text-right">
                        <div className="flex items-center justify-end gap-2">
                          {/* Tooltip trigger or Details */}
                          <div className="relative group/reasons">
                            <button className="p-2 bg-slate-950 border border-slate-800 rounded-lg text-slate-500 hover:text-white hover:border-slate-700 transition-all cursor-pointer">
                              <Info className="w-3.5 h-3.5" />
                            </button>
                            <div className="absolute right-0 bottom-full mb-2 w-72 bg-slate-950 border border-slate-800 rounded-xl p-4 shadow-xl opacity-0 scale-90 translate-y-2 pointer-events-none group-hover/reasons:opacity-100 group-hover/reasons:scale-100 group-hover/reasons:translate-y-0 transition-all duration-150 z-50 text-left">
                              <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest mb-2 flex items-center gap-1.5 border-b border-slate-850 pb-1.5">
                                <Sparkles className="w-3 h-3 text-amber-500" /> Spot Analysis
                              </p>
                              <ul className="space-y-1.5">
                                {row.reasons.map((reason: string, idx: number) => (
                                  <li key={idx} className="text-[10px] text-slate-300 font-bold leading-relaxed flex items-start gap-1.5">
                                    <span className="text-amber-500 shrink-0 mt-0.5">•</span>
                                    {reason}
                                  </li>
                                ))}
                              </ul>
                              {row.corporateActionTitle && (
                                <div className="mt-3 pt-2 border-t border-slate-850">
                                  <p className="text-[8px] font-black text-purple-400 uppercase tracking-widest mb-1 flex items-center gap-1.5">
                                    <FileText className="w-3 h-3 text-purple-400" /> Corporate Event
                                  </p>
                                  <p className="text-[9px] text-slate-400 font-bold leading-relaxed">{row.corporateActionTitle}</p>
                                </div>
                              )}
                            </div>
                          </div>
                          
                          <button 
                            onClick={() => onSelectStock(row.symbol)}
                            className="px-3 py-1.5 bg-slate-950 border border-slate-800 rounded-lg text-xs font-black text-white hover:border-slate-700 hover:text-blue-400 transition-all cursor-pointer flex items-center gap-1"
                          >
                            Trade <ArrowUpRight className="w-3 h-3" />
                          </button>
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
