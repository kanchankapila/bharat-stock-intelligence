import React from 'react';
import { trpc } from '../../../lib/trpc';
import { Radar, Compass, TrendingUp, AlertTriangle } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { motion } from 'framer-motion';

interface V3QuantRadarWidgetProps {
  symbol: string;
}

export const V3QuantRadarWidget: React.FC<V3QuantRadarWidgetProps> = ({ symbol }) => {
  const { data: quantScore, isLoading } = trpc.getQuantScore.useQuery({ symbol }, { refetchInterval: 30000 });

  if (isLoading) {
    return (
      <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 h-[400px] flex items-center justify-center">
        <div className="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
      </div>
    );
  }

  const scores = [
    { label: 'Momentum', value: quantScore?.rank_momentum ?? 50, color: 'text-indigo-400', bg: 'bg-indigo-500' },
    { label: 'Quality', value: quantScore?.rank_quality ?? 50, color: 'text-emerald-400', bg: 'bg-emerald-500' },
    { label: 'Value', value: quantScore?.rank_value ?? 50, color: 'text-cyan-400', bg: 'bg-cyan-500' },
    { label: 'Confluence', value: quantScore?.confluence_rank ?? 50, color: 'text-amber-400', bg: 'bg-amber-500' }
  ];

  return (
    <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl p-6 shadow-2xl relative overflow-hidden h-[400px]">
      <div className="flex items-center gap-2 text-indigo-400 mb-6">
         <Radar className="w-5 h-5" />
         <h3 className="font-bold text-sm uppercase tracking-widest">Technical Radar</h3>
      </div>

      <div className="space-y-6">
        {scores.map((score, idx) => (
          <div key={score.label} className="relative">
            <div className="flex justify-between items-end mb-2">
              <span className={cn("text-xs font-bold uppercase tracking-wider", score.color)}>{score.label}</span>
              <span className="text-lg font-black text-white tabular-nums leading-none">{Math.round(score.value)}%</span>
            </div>
            <div className="h-2 w-full bg-slate-800 rounded-full overflow-hidden">
              <motion.div 
                initial={{ width: 0 }}
                animate={{ width: `${Math.min(100, Math.max(0, score.value))}%` }}
                transition={{ duration: 1, delay: idx * 0.1, ease: 'easeOut' }}
                className={cn("h-full rounded-full", score.bg)}
              />
            </div>
          </div>
        ))}
      </div>

      <div className="absolute -bottom-10 -right-10 opacity-5 pointer-events-none">
        <Compass className="w-64 h-64" />
      </div>

      <div className="mt-8 pt-6 border-t border-slate-800/60">
        <div className="flex items-start gap-3">
          {(quantScore?.rank_composite ?? 50) > 60 ? (
             <TrendingUp className="w-5 h-5 text-emerald-500 shrink-0 mt-0.5" />
          ) : (
             <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0 mt-0.5" />
          )}
          <p className="text-xs text-slate-400 leading-relaxed font-medium">
            {(quantScore?.rank_composite ?? 50) > 60 
              ? "Strong confluence across technical factors. Momentum and Quality are aligned, suggesting a robust underlying trend."
              : "Mixed technical signals. Proceed with caution as some vectors show divergence from the primary trend."}
          </p>
        </div>
      </div>
    </div>
  );
};
