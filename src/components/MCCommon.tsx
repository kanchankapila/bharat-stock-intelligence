import React from 'react';
import { cn } from '../lib/utils';
import { Info } from 'lucide-react';

export const Card: React.FC<{ children: React.ReactNode; className?: string; title?: string; icon?: any; action?: React.ReactNode }> = ({ children, className, title, icon: Icon, action }) => (
  <div className={cn("bg-slate-900/50 border border-slate-800 rounded-2xl overflow-hidden", className)}>
    {title && (
      <div className="px-4 py-3 border-b border-slate-800 flex items-center justify-between">
        <h3 className="text-[11px] font-black text-slate-300 flex items-center gap-2 italic uppercase tracking-widest">
          {Icon && <Icon className="w-3.5 h-3.5 text-blue-500" />}
          {title}
        </h3>
        {action ? action : <Info className="w-3.5 h-3.5 text-slate-600 cursor-help" />}
      </div>
    )}
    <div className="p-4">{children}</div>
  </div>
);

export const SentimentBadge: React.FC<{ sentiment: string; className?: string }> = ({ sentiment, className }) => {
  const s = sentiment?.toLowerCase() || '';
  const isBullish = s.includes('bullish') || s.includes('buy') || s.includes('outperform') || s === 'positive';
  const isBearish = s.includes('bearish') || s.includes('sell') || s.includes('underperform') || s === 'negative';
  const isNeutral = s.includes('neutral') || s === 'neutral' || s === '- -' || !sentiment;

  return (
    <span className={cn(
      "text-[8px] font-black px-1.5 py-0.5 rounded uppercase tracking-tighter whitespace-nowrap",
      isBullish ? "bg-emerald-500/10 text-emerald-500" :
      isBearish ? "bg-rose-500/10 text-rose-500" :
      "bg-slate-800 text-slate-400",
      className
    )}>
      {isBullish ? (s.includes('very') ? 'Very Bullish' : 'Bullish') :
       isBearish ? (s.includes('very') ? 'Very Bearish' : 'Bearish') :
       sentiment || 'Neutral'}
    </span>
  );
};

export const ValueDisplay: React.FC<{ label: string; value: string | number | undefined; sub?: string; color?: string }> = ({ label, value, sub, color }) => (
  <div className="p-3 bg-slate-950 rounded-xl border border-slate-800/50 text-center">
    <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-1">{label}</p>
    <p className={cn("text-sm font-black italic tracking-tighter", color || "text-white")}>{value ?? '—'}</p>
    {sub && <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">{sub}</p>}
  </div>
);

export const IndicatorRow: React.FC<{ name: string; value: string | number | any[] | undefined; sentiment: string }> = ({ name, value, sentiment }) => (
  <div className="flex items-center justify-between p-2 bg-slate-950 rounded-lg border border-slate-800/50 hover:border-slate-700 transition-all">
    <div className="flex-1 min-w-0">
      <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest truncate">{name}</p>
      <p className="text-[11px] font-bold text-white mt-0.5 tabular-nums">
        {Array.isArray(value) ? (
          <span className="text-[9px] text-slate-400">
            UB: {(value as any[]).find((v: any) => v.displayName === 'UB' || v.id === 'upperband')?.value || '-'} |
            LB: {(value as any[]).find((v: any) => v.displayName === 'LB' || v.id === 'lowerband')?.value || '-'}
          </span>
        ) : String(value ?? '—')}
      </p>
    </div>
    <SentimentBadge sentiment={sentiment} />
  </div>
);

export const CompactMetricCard: React.FC<{ label: string; value: string | number | undefined; sub?: string; color?: string; icon?: any }> = ({ label, value, sub, color, icon: Icon }) => (
  <div className="p-2.5 bg-slate-950/40 rounded-xl border border-slate-800/50 flex flex-col justify-between hover:bg-slate-900/60 transition-colors group">
    <div className="flex items-center justify-between mb-1">
      <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest truncate max-w-[80%]">{label}</span>
      {Icon && <Icon className="w-2.5 h-2.5 text-slate-700 group-hover:text-slate-500 transition-colors" />}
    </div>
    <div className="flex items-baseline gap-1.5 flex-wrap">
      <span className={cn("text-[11px] font-black italic", color || "text-slate-200")}>{value ?? '—'}</span>
      {sub && <span className="text-[7px] text-slate-600 font-bold uppercase tracking-tighter truncate">{sub}</span>}
    </div>
  </div>
);
