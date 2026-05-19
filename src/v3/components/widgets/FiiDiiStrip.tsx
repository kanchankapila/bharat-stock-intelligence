import React from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { TrendingUp, TrendingDown, Users, Building2 } from 'lucide-react';

function fmt(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 1000) return `₹${(n / 1000).toFixed(2)}K Cr`;
  return `₹${n.toFixed(2)} Cr`;
}

export const FiiDiiStrip: React.FC = () => {
  const { data: flows, isLoading } = trpc.getFiiDiiFlow.useQuery(
    { days: 10 },
    { refetchInterval: 5 * 60 * 1000 }
  );

  if (isLoading) {
    return (
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => (
          <div key={i} className="h-20 rounded-xl bg-slate-800/50 animate-pulse" />
        ))}
      </div>
    );
  }

  const rows = (flows as any[]) ?? [];
  const latest = rows[0];
  const prev = rows[1];

  if (!latest) {
    return (
      <div className="bg-slate-900/50 border border-slate-800 rounded-xl px-5 py-4 text-sm text-slate-500">
        FII/DII flow data not yet available — run the FII/DII fetcher to populate.
      </div>
    );
  }

  const fiiNet: number = latest.fii_net ?? 0;
  const diiNet: number = latest.dii_net ?? 0;
  const prevFiiNet: number = prev?.fii_net ?? 0;
  const prevDiiNet: number = prev?.dii_net ?? 0;

  const stats = [
    {
      label: 'FII Net (Today)',
      value: fiiNet,
      prev: prevFiiNet,
      icon: Building2,
      date: latest.date,
    },
    {
      label: 'DII Net (Today)',
      value: diiNet,
      prev: prevDiiNet,
      icon: Users,
      date: latest.date,
    },
    {
      label: 'FII Buy',
      value: latest.fii_buy ?? 0,
      isAbsolute: true,
      icon: TrendingUp,
      date: latest.date,
    },
    {
      label: 'DII Buy',
      value: latest.dii_buy ?? 0,
      isAbsolute: true,
      icon: TrendingUp,
      date: latest.date,
    },
  ];

  return (
    <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
      {stats.map(({ label, value, prev: prevVal, isAbsolute, icon: Icon, date }) => {
        const isPositive = value >= 0;
        const delta = prevVal !== undefined ? value - prevVal : null;

        return (
          <div
            key={label}
            className={cn(
              'relative rounded-xl p-4 border bg-slate-900/50 backdrop-blur-md overflow-hidden',
              isAbsolute
                ? 'border-slate-800'
                : isPositive
                ? 'border-emerald-500/20'
                : 'border-rose-500/20'
            )}
          >
            <div className={cn(
              'absolute top-0 left-0 right-0 h-0.5',
              isAbsolute
                ? 'bg-slate-700'
                : isPositive
                ? 'bg-gradient-to-r from-emerald-500/80 to-emerald-500/10'
                : 'bg-gradient-to-r from-rose-500/80 to-rose-500/10'
            )} />

            <div className="flex items-center justify-between mb-2">
              <span className="text-xs font-semibold text-slate-400 uppercase tracking-wider">{label}</span>
              <Icon className={cn(
                'w-3.5 h-3.5',
                isAbsolute ? 'text-slate-500' : isPositive ? 'text-emerald-500' : 'text-rose-500'
              )} />
            </div>

            <p className={cn(
              'text-lg font-bold tabular-nums',
              isAbsolute ? 'text-slate-200' : isPositive ? 'text-emerald-400' : 'text-rose-400'
            )}>
              {isAbsolute ? fmt(value) : (isPositive ? '+' : '') + fmt(value)}
            </p>

            <div className="flex items-center justify-between mt-1">
              {delta !== null && !isAbsolute ? (
                <span className={cn(
                  'text-[11px] font-medium',
                  delta >= 0 ? 'text-emerald-500' : 'text-rose-500'
                )}>
                  {delta >= 0 ? '▲' : '▼'} vs prev day
                </span>
              ) : (
                <span />
              )}
              <span className="text-[10px] text-slate-600">{date}</span>
            </div>
          </div>
        );
      })}
    </div>
  );
};
