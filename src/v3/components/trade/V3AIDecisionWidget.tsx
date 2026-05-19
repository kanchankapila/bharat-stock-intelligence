import React from 'react';
import { trpc } from '../../../lib/trpc';
import { Brain, Target, Shield, TrendingUp, TrendingDown, Activity, ActivitySquare } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion } from 'framer-motion';

interface SignalRow {
  status: string;
  type: string;
  confidence?: number;
  target?: number;
  stopLoss?: number;
  reasoning?: string;
}

interface V3AIDecisionWidgetProps {
  symbol: string;
}

export const V3AIDecisionWidget: React.FC<V3AIDecisionWidgetProps> = ({ symbol }) => {
  const { data: quantScore, isLoading: loadingScore } = trpc.getQuantScore.useQuery({ symbol }, { refetchInterval: 30000 });
  const { data: rawSignals, isLoading: loadingSignals } = trpc.getSignalHistory.useQuery({ symbol });
  const { data: liveQuote } = trpc.getLiveStockQuote.useQuery({ symbol }, { refetchInterval: 10000 });

  const signals = rawSignals as SignalRow[] | undefined;

  const activeSignal = React.useMemo(() => {
    if (!signals || !Array.isArray(signals)) return null;
    return signals.find(s => s.status === 'ACTIVE') ?? signals[0] ?? null;
  }, [signals]);

  if (loadingScore || loadingSignals) {
    return (
      <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-xl p-6 h-[400px] flex items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <div className="w-10 h-10 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
          <p className="text-slate-400 font-medium text-sm animate-pulse">Running Neural Analysis...</p>
        </div>
      </div>
    );
  }

  const score = quantScore?.rank_composite ?? 50;
  const price = liveQuote?.price || 0;

  let recommendation = 'HOLD';
  let isBuy = false;
  let isSell = false;

  if (activeSignal) {
    recommendation = activeSignal.type;
    isBuy = recommendation.includes('BUY');
    isSell = recommendation.includes('SELL');
  } else {
    if (score >= 70) { recommendation = 'STRONG BUY'; isBuy = true; }
    else if (score >= 60) { recommendation = 'BUY'; isBuy = true; }
    else if (score <= 30) { recommendation = 'SELL'; isSell = true; }
  }

  const confidence = activeSignal
    ? Math.round(activeSignal.confidence ?? 75)
    : isBuy ? 50 + (score - 60) * 1.5 : isSell ? 50 + (30 - score) * 1.6 : 50;
  const target = activeSignal?.target ?? (price > 0 ? price * (isBuy ? 1.12 : isSell ? 0.88 : 1.05) : 0);
  const stopLoss = activeSignal?.stopLoss ?? (price > 0 ? price * (isBuy ? 0.94 : isSell ? 1.05 : 0.95) : 0);

  return (
    <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl overflow-hidden relative shadow-2xl">
      {/* Decorative gradient */}
      <div className="absolute top-0 right-0 w-64 h-64 bg-indigo-500/10 rounded-full blur-[80px] pointer-events-none" />
      <div className="absolute bottom-0 left-0 w-64 h-64 bg-cyan-500/10 rounded-full blur-[80px] pointer-events-none" />

      <div className="p-6 relative z-10">
        <div className="flex justify-between items-start mb-8">
          <div>
             <div className="flex items-center gap-2 text-indigo-400 mb-1">
                <Brain className="w-5 h-5" />
                <h3 className="font-bold text-sm uppercase tracking-widest">AI Decision Core</h3>
             </div>
             <p className="text-slate-400 text-xs">Deep Neural Strategy & Execution Metrics</p>
          </div>
          <div className="text-right">
             <div className="text-3xl font-black text-white tabular-nums tracking-tight">
               ₹{price.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
             </div>
             <p className="text-xs text-slate-500 font-medium mt-1">Live Price</p>
          </div>
        </div>

        {/* Primary Action Box */}
        <div className={cn(
          "rounded-xl p-5 border flex items-center justify-between mb-8 shadow-inner transition-all duration-500",
          isBuy ? "bg-emerald-500/10 border-emerald-500/30" : isSell ? "bg-rose-500/10 border-rose-500/30" : "bg-slate-800/50 border-slate-700"
        )}>
          <div className="flex items-center gap-4">
            <div className={cn(
              "w-12 h-12 rounded-full flex items-center justify-center shadow-lg",
              isBuy ? "bg-emerald-500 text-white shadow-emerald-500/20" : isSell ? "bg-rose-500 text-white shadow-rose-500/20" : "bg-slate-700 text-slate-300"
            )}>
              {isBuy ? <TrendingUp className="w-6 h-6" /> : isSell ? <TrendingDown className="w-6 h-6" /> : <Activity className="w-6 h-6" />}
            </div>
            <div>
              <p className={cn(
                "text-2xl font-black uppercase tracking-widest",
                isBuy ? "text-emerald-400" : isSell ? "text-rose-400" : "text-slate-300"
              )}>
                {recommendation}
              </p>
              <div className="flex items-center gap-2 mt-1">
                <p className="text-xs text-slate-400 font-medium">Confidence Matrix</p>
                <div className="w-24 h-1.5 bg-slate-900 rounded-full overflow-hidden">
                  <motion.div 
                    initial={{ width: 0 }}
                    animate={{ width: `${Math.min(100, Math.max(0, confidence))}%` }}
                    transition={{ duration: 1, ease: "easeOut" }}
                    className={cn(
                      "h-full rounded-full",
                      isBuy ? "bg-emerald-500" : isSell ? "bg-rose-500" : "bg-slate-500"
                    )}
                  />
                </div>
                <span className="text-xs font-bold text-white tabular-nums">{confidence.toFixed(0)}%</span>
              </div>
            </div>
          </div>

          {/* Quant Score Badge */}
          <div className="text-center bg-slate-950/50 px-4 py-2 rounded-lg border border-slate-800">
            <p className="text-[10px] uppercase text-slate-500 font-bold tracking-wider mb-1">Composite Score</p>
            <p className="text-xl font-black text-white tabular-nums">{score.toFixed(1)}</p>
          </div>
        </div>

        {/* Execution Levels */}
        <div className="grid grid-cols-2 gap-4">
           <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 flex flex-col justify-center items-center group hover:bg-slate-800/60 transition-colors">
              <Target className="w-6 h-6 text-cyan-400 mb-2 group-hover:scale-110 transition-transform" />
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold mb-1">Target Exit</p>
              <p className="text-xl font-black text-cyan-400 tabular-nums tracking-tight">₹{target.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</p>
           </div>
           <div className="bg-slate-800/40 rounded-xl p-4 border border-slate-700/50 flex flex-col justify-center items-center group hover:bg-slate-800/60 transition-colors">
              <Shield className="w-6 h-6 text-rose-400 mb-2 group-hover:scale-110 transition-transform" />
              <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold mb-1">Stop Loss</p>
              <p className="text-xl font-black text-rose-400 tabular-nums tracking-tight">₹{stopLoss.toLocaleString('en-IN', { maximumFractionDigits: 1 })}</p>
           </div>
        </div>

        {/* Reasoning */}
        {activeSignal?.reasoning && (
          <div className="mt-6 pt-6 border-t border-slate-800/60">
            <div className="flex gap-2">
              <ActivitySquare className="w-4 h-4 text-indigo-400 shrink-0 mt-0.5" />
              <p className="text-sm text-slate-300 leading-relaxed font-medium">
                {activeSignal.reasoning}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
