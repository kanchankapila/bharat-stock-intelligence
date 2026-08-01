import React from 'react';
import { motion } from 'motion/react';
import { X, Bookmark, CheckCircle2, History, TrendingUp, Activity, Award, ShieldAlert, Maximize2, Minimize2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';
import { MCStockInfoPanel } from './MCStockInfoPanel';

interface SlideOutDrawerProps {
  symbol: string | null;
  isOpen: boolean;
  onClose: () => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
  onSelectStock?: (symbol: string) => void;
}

export const SlideOutDrawer: React.FC<SlideOutDrawerProps> = ({
  symbol,
  isOpen,
  onClose,
  watchlist,
  onToggleWatchlist,
  onSelectStock,
}) => {
  const [isMaximized, setIsMaximized] = React.useState(false);
  const isWatchlisted = symbol ? watchlist.includes(symbol) : false;

  React.useEffect(() => {
    setIsMaximized(false);
  }, [symbol]);

  // Fetch deep quant scores (incorporating fundamentals)
  const { data: quantScore, isLoading: loadingQuant } = trpc.getQuantScore.useQuery(
    { symbol: symbol ?? '' },
    { enabled: !!symbol }
  );

  // Fetch historical signal logs
  const { data: signalHistory, isLoading: loadingHistory } = trpc.getSignalHistory.useQuery(
    { symbol: symbol ?? '' },
    { enabled: !!symbol }
  );

  // Resolve MC symbol mapping
  const stockMapping = React.useMemo(() => {
    if (!symbol) return null;
    return stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
  }, [symbol]);

  const mcScId = stockMapping?.mcsymbol || symbol || '';

  if (!isOpen || !symbol) return null;

  const hasScore = quantScore?.rank_composite != null;
  const scoreValue = quantScore?.rank_composite ?? 0;
  const scoreClass = hasScore ? (quantScore?.composite_class ?? 'Hold') : 'Not Scored';

  const scoreColors = {
    'Strong Buy': { bg: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/20', fill: 'bg-emerald-500' },
    'Buy': { bg: 'bg-teal-500/10 text-teal-400 border-teal-500/20', fill: 'bg-teal-500' },
    'Hold': { bg: 'bg-amber-500/10 text-amber-400 border-amber-500/20', fill: 'bg-amber-500' },
    'Avoid': { bg: 'bg-orange-500/10 text-orange-400 border-orange-500/20', fill: 'bg-orange-500' },
    'Sell': { bg: 'bg-rose-500/10 text-rose-400 border-rose-500/20', fill: 'bg-rose-500' },
    'Not Scored': { bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20', fill: 'bg-slate-600' },
  }[scoreClass as 'Strong Buy' | 'Buy' | 'Hold' | 'Avoid' | 'Sell' | 'Not Scored'] || { bg: 'bg-slate-500/10 text-slate-400 border-slate-500/20', fill: 'bg-slate-500' };

  return (
    <div className="fixed inset-0 z-[100] flex justify-end overflow-hidden">
      {/* Backdrop overlay */}
      <motion.div
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm"
      />

      {/* Slide-out Drawer Panel */}
      <motion.div
        initial={{ x: '100%' }}
        animate={{ x: 0 }}
        exit={{ x: '100%' }}
        transition={{ type: 'spring', damping: 26, stiffness: 220 }}
        className={cn(
          "relative h-full glass-strong border-l border-white/[0.08] flex flex-col shadow-2xl z-10 transition-all duration-300",
          isMaximized ? "w-full max-w-full" : "w-full max-w-4xl"
        )}
      >
        {/* Header Bar */}
        <div className="px-6 py-4 border-b border-white/[0.08] flex items-center justify-between bg-slate-950/60 backdrop-blur-md shrink-0">
          <div className="flex items-center gap-3 min-w-0">
            <div className="w-10 h-10 bg-indigo-500/10 border border-indigo-500/20 rounded-xl flex items-center justify-center shrink-0">
              <TrendingUp className="w-5 h-5 text-indigo-600" />
            </div>
            <div className="min-w-0">
              <h2 className="text-base font-black text-white tracking-wider flex items-center gap-2">
                {symbol}
                {stockMapping?.name && (
                  <span className="text-xs font-semibold text-slate-400 truncate max-w-[200px] sm:max-w-xs">
                    {stockMapping.name}
                  </span>
                )}
              </h2>
              {quantScore?.sector && (
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5">
                  {quantScore.sector}
                </p>
              )}
            </div>
          </div>

          <div className="flex items-center gap-2">
            <button
              onClick={() => {
                const currentPrice = quantScore?.pricecurrent || undefined;
                const name = stockMapping?.name || undefined;
                onToggleWatchlist(symbol, { price: currentPrice, name, source: 'drawer' });
              }}
              className={cn(
                "p-2 rounded-lg border transition-all flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider",
                isWatchlisted
                  ? "bg-indigo-600 border-indigo-600 text-white shadow-sm"
                  : "bg-slate-900 border-white/[0.08] text-slate-300 hover:text-white hover:bg-slate-800"
              )}
            >
              <Bookmark className={cn("w-3.5 h-3.5", isWatchlisted ? "fill-indigo-600 stroke-indigo-600" : "")} />
              <span className="hidden sm:inline">{isWatchlisted ? 'Watchlisted' : 'Watchlist'}</span>
            </button>
            <button
              onClick={() => setIsMaximized(!isMaximized)}
              className="p-2 rounded-lg border border-white/[0.08] bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800 transition-all flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wider"
              title={isMaximized ? "Restore Size" : "Maximize View"}
            >
              {isMaximized ? <Minimize2 className="w-3.5 h-3.5" /> : <Maximize2 className="w-3.5 h-3.5" />}
              <span className="hidden sm:inline">{isMaximized ? 'Restore' : 'Maximize'}</span>
            </button>
            <button
              onClick={onClose}
              className="p-2 rounded-lg border border-white/[0.08] bg-slate-900 text-slate-400 hover:text-white hover:bg-slate-800 transition-all"
            >
              <X className="w-4 h-4" />
            </button>
          </div>
        </div>

        {/* Scrollable Intelligence Body */}
        <div className="flex-1 overflow-y-auto p-6 space-y-6 hide-scrollbar bg-slate-950/50">
          
          {/* Top Summary Grid (Quant score and Piotroski breakdown) */}
          <div className="grid grid-cols-1 md:grid-cols-12 gap-4">
            
            {/* Quant Score Circular / Banner details */}
            <div className="md:col-span-7 glass border border-white/[0.08] rounded-2xl p-4 flex flex-col justify-between">
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="text-[10px] font-black text-indigo-600 uppercase tracking-widest flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5" /> AlphaQuant Core Rating
                  </span>
                  <span className={cn("text-[9px] font-black px-2 py-0.5 rounded border uppercase tracking-wider", scoreColors.bg)}>
                    {scoreClass}
                  </span>
                </div>
                <div className="flex items-baseline gap-2 mb-3">
                  <span className="text-3xl font-black text-white tabular-nums">{hasScore ? scoreValue.toFixed(0) : '—'}</span>
                  <span className="text-xs font-bold text-slate-400">{hasScore ? '/ 100 percentile rank' : 'awaiting next scoring run'}</span>
                </div>
                <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden border border-white/[0.05]">
                  <div className={cn("h-full rounded-full transition-all duration-500", scoreColors.fill)} style={{ width: `${scoreValue}%` }} />
                </div>
              </div>
              
              <div className="grid grid-cols-4 gap-2 border-t border-white/[0.08] pt-3 mt-4">
                {[
                  { label: 'Momentum', val: quantScore?.rank_momentum, suffix: '%' },
                  { label: 'Value', val: quantScore?.rank_value, suffix: '%' },
                  { label: 'Quality', val: quantScore?.rank_quality, suffix: '%' },
                  { label: 'Confluence', val: quantScore?.confluence_rank, suffix: '%' }
                ].map((item, idx) => (
                  <div key={idx} className="text-center">
                    <p className="text-[8px] font-bold text-slate-400 uppercase tracking-wider">{item.label}</p>
                    <p className="text-xs font-black text-slate-100 mt-0.5 tabular-nums">
                      {item.val != null ? `${Math.round(item.val)}${item.suffix}` : '—'}
                    </p>
                  </div>
                ))}
              </div>
            </div>

            {/* Hidden Deep Fundamentals (Piotroski, DE, ROE) */}
            <div className="md:col-span-5 glass border border-white/[0.08] rounded-2xl p-4 flex flex-col justify-between">
              <div>
                <span className="text-[10px] font-black text-slate-400 uppercase tracking-widest flex items-center gap-1.5 mb-3">
                  <Activity className="w-3.5 h-3.5 text-indigo-500" /> Deep Fundamentals
                </span>
                
                <div className="space-y-2">
                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-slate-400">Piotroski F-Score</span>
                    <span className={cn(
                      "font-black tabular-nums px-2 py-0.5 rounded",
                      (quantScore?.piotroski_f_score ?? 0) >= 7 ? "bg-emerald-500/10 text-emerald-400" :
                      (quantScore?.piotroski_f_score ?? 0) >= 5 ? "bg-amber-500/10 text-amber-400" :
                      "bg-rose-500/10 text-rose-400"
                    )}>
                      {quantScore?.piotroski_f_score ?? '—'} / 9
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-slate-400">Debt to Equity</span>
                    <span className={cn(
                      "font-black tabular-nums",
                      quantScore?.debt_to_equity != null && quantScore.debt_to_equity > 150 ? "text-rose-400" : "text-slate-700"
                    )}>
                      {quantScore?.debt_to_equity != null ? `${(quantScore.debt_to_equity / 100).toFixed(2)}x` : '—'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-slate-400">Return on Equity (ROE)</span>
                    <span className="font-black text-slate-200 tabular-nums">
                      {quantScore?.return_on_equity != null ? `${(quantScore.return_on_equity * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>

                  <div className="flex justify-between items-center text-xs">
                    <span className="font-semibold text-slate-400">Revenue Growth (QoQ)</span>
                    <span className="font-black text-slate-200 tabular-nums">
                      {quantScore?.revenue_growth != null ? `${(quantScore.revenue_growth * 100).toFixed(1)}%` : '—'}
                    </span>
                  </div>
                </div>
              </div>
            </div>

          </div>

          {/* Moneycontrol Embedded Details Panel */}
          {mcScId && (
            <div className="border-t border-white/[0.08] pt-4">
              <MCStockInfoPanel
                symbol={symbol}
                scId={mcScId}
                section="all"
                watchlist={watchlist}
                onToggleWatchlist={onToggleWatchlist}
                onSelectStock={onSelectStock}
              />
            </div>
          )}

          {/* Historical Signal Audit Logs */}
          <div className="glass border border-white/[0.08] rounded-2xl overflow-hidden shadow-[0_2px_12px_rgba(0,0,0,0.01)]">
            <div className="px-4 py-3 border-b border-white/[0.08] bg-slate-900/40 flex items-center justify-between">
              <h3 className="text-[11px] font-black text-slate-350 flex items-center gap-2 italic uppercase tracking-widest">
                <History className="w-3.5 h-3.5 text-indigo-600" /> System Signal Logs
              </h3>
            </div>
            <div className="p-4 space-y-3">
              {loadingHistory ? (
                <div className="py-8 flex flex-col items-center justify-center">
                  <div className="w-6 h-6 border-2 border-indigo-600 border-t-transparent rounded-full animate-spin mb-2" />
                  <p className="text-[10px] text-slate-400 uppercase tracking-wider">Syncing historical outcomes...</p>
                </div>
              ) : signalHistory && signalHistory.length > 0 ? (
                <div className="max-h-60 overflow-y-auto pr-1 space-y-2.5">
                  {signalHistory.map((sig: any) => {
                    const isCompleted = sig.status === 'COMPLETED';
                    const isFailed = sig.status === 'FAILED';
                    const sigColor = sig.type === 'BUY' 
                      ? 'text-emerald-400 bg-emerald-500/10 border-emerald-500/20' 
                      : 'text-rose-400 bg-rose-500/10 border-rose-500/20';
                    return (
                      <div key={sig.id} className="p-3 bg-slate-900/60 border border-white/[0.06] rounded-xl flex flex-col justify-between hover:bg-slate-900/80 transition-colors shadow-inner">
                        <div className="flex items-center justify-between">
                          <div className="flex items-center gap-2">
                            <span className={cn("text-[11px] font-black px-2 py-0.5 rounded border uppercase", sigColor)}>
                              {sig.type}
                            </span>
                            <span className="text-[11px] text-slate-400 font-bold">
                              {sig.createdAt?.seconds
                                ? new Date(sig.createdAt.seconds * 1000).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })
                                : new Date(sig.createdAt || Date.now()).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })}
                            </span>
                          </div>
                          {sig.status && (
                            <span className={cn(
                              "text-[11px] font-black uppercase px-2 py-0.5 rounded",
                              isCompleted ? "bg-emerald-500/10 text-emerald-400" :
                              isFailed ? "bg-rose-500/10 text-rose-400" : "bg-slate-800 text-slate-300"
                            )}>
                              {sig.status}
                            </span>
                          )}
                        </div>
                        {sig.reasoning && (
                          <p className="text-[12px] text-slate-200 font-semibold mt-2.5 leading-relaxed">
                            {sig.reasoning}
                          </p>
                        )}
                        <div className="flex items-center gap-4 mt-3 border-t border-white/[0.05] pt-2.5 text-[11.5px] text-slate-400">
                          <div>Entry: <span className="font-bold text-slate-100 tabular-nums">₹{sig.entry}</span></div>
                          <div>Target: <span className="font-bold text-emerald-400 tabular-nums">₹{sig.target}</span></div>
                          <div>Stop-loss: <span className="font-bold text-rose-400 tabular-nums">₹{sig.stopLoss}</span></div>
                        </div>
                      </div>
                    );
                  })}
                </div>
              ) : (
                <div className="py-8 flex flex-col items-center justify-center text-slate-400">
                  <ShieldAlert className="w-8 h-8 text-slate-300 mb-2" />
                  <p className="text-[10px] uppercase tracking-wider font-semibold">No active signal records found</p>
                </div>
              )}
            </div>
          </div>

        </div>
      </motion.div>
    </div>
  );
};
