import React from 'react';
import { cn } from '../lib/utils';
import { Info } from 'lucide-react';
import { motion } from 'motion/react';

export const ScoreRing: React.FC<{
  score: number;
  max?: number;
  label: string;
  color: string;
  size?: number;
  sublabel?: string;
}> = ({ score, max = 100, label, color, size = 68, sublabel }) => {
  const r = size / 2 - 7;
  const circumference = 2 * Math.PI * r;
  const pct = Math.min(100, Math.max(0, (score / max) * 100));
  const offset = circumference - (pct / 100) * circumference;

  return (
    <div className="flex flex-col items-center gap-1.5">
      <div style={{ width: size, height: size }} className="relative shrink-0">
        <svg width={size} height={size} className="-rotate-90 absolute inset-0">
          <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="#1e293b" strokeWidth={5} />
          <motion.circle
            cx={size / 2} cy={size / 2} r={r}
            fill="none" stroke={color} strokeWidth={5}
            strokeDasharray={circumference}
            initial={{ strokeDashoffset: circumference }}
            animate={{ strokeDashoffset: offset }}
            transition={{ duration: 1.2, ease: 'easeOut', delay: 0.15 }}
            strokeLinecap="round"
          />
        </svg>
        <div className="absolute inset-0 flex flex-col items-center justify-center">
          <span
            className="text-[13px] font-black leading-none tabular-nums"
            style={{ color, fontFamily: "'DM Mono', monospace" }}
          >
            {typeof score === 'number' ? (max <= 5 ? score.toFixed(1) : Math.round(score)) : score}
          </span>
          {sublabel && (
            <span className="text-[6px] font-black text-slate-600 uppercase mt-0.5">{sublabel}</span>
          )}
        </div>
      </div>
      <p className="text-[7px] font-black text-slate-500 uppercase tracking-[0.1em] text-center leading-tight max-w-[70px]">
        {label}
      </p>
    </div>
  );
};

export const Card: React.FC<{
  children: React.ReactNode;
  className?: string;
  title?: string;
  icon?: any;
  action?: React.ReactNode;
  accent?: string;
}> = ({ children, className, title, icon: Icon, action, accent = '#3b82f6' }) => (
  <div className={cn("bg-slate-900/40 border border-slate-800/70 rounded-2xl overflow-hidden", className)}>
    {title && (
      <div className="px-4 py-3 border-b border-slate-800/60 flex items-center justify-between">
        <h3 className="text-[10px] font-black text-slate-300 flex items-center gap-2 uppercase tracking-[0.12em]">
          {Icon && <Icon className="w-3.5 h-3.5" style={{ color: accent }} />}
          {title}
        </h3>
        {action ?? <Info className="w-3.5 h-3.5 text-slate-700 cursor-help" />}
      </div>
    )}
    <div className="p-4">{children}</div>
  </div>
);

export const SentimentBadge: React.FC<{ sentiment: string; className?: string }> = ({ sentiment, className }) => {
  const s = sentiment?.toLowerCase() || '';
  const isBullish = s.includes('bullish') || s.includes('buy') || s.includes('outperform') || s === 'positive';
  const isBearish = s.includes('bearish') || s.includes('sell') || s.includes('underperform') || s === 'negative';

  return (
    <span className={cn(
      "text-[8px] font-black px-2 py-0.5 rounded-full uppercase tracking-wider whitespace-nowrap border",
      isBullish
        ? "bg-emerald-500/10 text-emerald-400 border-emerald-500/20"
        : isBearish
          ? "bg-rose-500/10 text-rose-400 border-rose-500/20"
          : "bg-slate-800/60 text-slate-400 border-slate-700/40",
      className
    )}>
      {isBullish
        ? s.includes('very') ? 'Strong Bull' : 'Bullish'
        : isBearish
          ? s.includes('very') ? 'Strong Bear' : 'Bearish'
          : sentiment || 'Neutral'}
    </span>
  );
};

export const ValueDisplay: React.FC<{
  label: string;
  value: string | number | undefined;
  sub?: string;
  color?: string;
}> = ({ label, value, sub, color }) => (
  <div className="p-3 bg-slate-950/60 rounded-xl border border-slate-800/40 text-center hover:border-slate-700/50 transition-colors">
    <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.12em] mb-1.5">{label}</p>
    <p
      className={cn("text-[13px] font-black tracking-tight", color || "text-white")}
      style={{ fontFamily: "'DM Mono', monospace" }}
    >
      {value ?? '—'}
    </p>
    {sub && <p className="text-[8px] text-slate-600 font-bold uppercase mt-1">{sub}</p>}
  </div>
);

export const IndicatorRow: React.FC<{
  name: string;
  value: string | number | any[] | undefined;
  sentiment: string;
}> = ({ name, value, sentiment }) => (
  <div className="flex items-center justify-between px-3 py-2.5 bg-slate-950/40 rounded-xl border border-slate-800/40 hover:border-slate-700/50 transition-all">
    <div className="flex-1 min-w-0 mr-3">
      <p className="text-[8px] font-black text-slate-500 uppercase tracking-[0.08em] truncate">{name}</p>
      <p className="text-[11px] font-black text-slate-200 mt-0.5" style={{ fontFamily: "'DM Mono', monospace" }}>
        {Array.isArray(value) ? (
          <span className="text-[9px] text-slate-400">
            UB: {(value as any[]).find((v: any) => v.displayName === 'UB' || v.id === 'upperband')?.value || '-'}{' '}|{' '}
            LB: {(value as any[]).find((v: any) => v.displayName === 'LB' || v.id === 'lowerband')?.value || '-'}
          </span>
        ) : String(value ?? '—')}
      </p>
    </div>
    <SentimentBadge sentiment={sentiment} />
  </div>
);

export const CompactMetricCard: React.FC<{
  label: string;
  value: string | number | undefined;
  sub?: string;
  color?: string;
  icon?: any;
}> = ({ label, value, sub, color, icon: Icon }) => (
  <div className="p-3 bg-slate-950/50 rounded-xl border border-slate-800/40 flex flex-col gap-1.5 hover:bg-slate-900/50 hover:border-slate-700/60 transition-all group cursor-default">
    <div className="flex items-center justify-between">
      <span className="text-[8px] font-black text-slate-500 uppercase tracking-[0.08em] truncate max-w-[75%]">{label}</span>
      {Icon && <Icon className="w-3 h-3 text-slate-700 group-hover:text-slate-500 transition-colors shrink-0" />}
    </div>
    <span
      className={cn("text-[14px] font-black tracking-tight leading-none", color || "text-slate-100")}
      style={{ fontFamily: "'DM Mono', monospace" }}
    >
      {value ?? '—'}
    </span>
    {sub && <span className="text-[7px] text-slate-600 font-black uppercase tracking-tight leading-none">{sub}</span>}
  </div>
);
