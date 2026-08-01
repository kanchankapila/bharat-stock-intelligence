import React, { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { Users, ArrowRight } from 'lucide-react';
import { ResponsiveContainer, AreaChart, Area } from 'recharts';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

const crFmt = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}₹${Math.round(v).toLocaleString('en-IN')} Cr`;

// Command Center teaser for the Money Flow page (getFiiDiiFlow) -- today's FII/DII net plus
// a 10-day cumulative sparkline, so institutional flow direction is visible without a
// separate page visit. Same query/semantics as the full Money Flow page.
export const MoneyFlowPulseWidget: React.FC = () => {
  const navigate = useNavigate();
  const { data, isLoading } = trpc.getFiiDiiFlow.useQuery({ days: 10 }, { refetchInterval: 30 * 60_000 });

  const rows = useMemo(() => {
    const list = (data ?? []).slice().reverse(); // ascending
    let cum = 0;
    return list.map((r: any) => { cum += r.fii_net ?? 0; return { ...r, cum }; });
  }, [data]);

  const latest = rows.length > 0 ? rows[rows.length - 1] : null;

  return (
    <Card
      title="Money Flow Pulse"
      icon={Users}
      onClick={() => navigate('/money-flow')}
      action={<ArrowRight className="w-3.5 h-3.5 text-slate-500" />}
    >
      {isLoading ? (
        <div className="text-xs text-slate-500 py-6 text-center animate-pulse">Loading flow data…</div>
      ) : !latest ? (
        <div className="text-xs text-slate-500 py-6 text-center">No FII/DII data available.</div>
      ) : (
        <div className="flex items-center gap-4">
          <div className="flex-1 grid grid-cols-2 gap-3">
            <div>
              <div className={cn('text-sm font-mono font-bold', (latest.fii_net ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {crFmt(latest.fii_net)}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">FII Net (latest)</div>
            </div>
            <div>
              <div className={cn('text-sm font-mono font-bold', (latest.dii_net ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {crFmt(latest.dii_net)}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">DII Net (latest)</div>
            </div>
          </div>
          <div className="w-24 h-12 shrink-0">
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={rows}>
                <defs>
                  <linearGradient id="mfPulseGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#38bdf8" stopOpacity={0.5} />
                    <stop offset="100%" stopColor="#38bdf8" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <Area type="monotone" dataKey="cum" stroke="#38bdf8" strokeWidth={1.5} fill="url(#mfPulseGrad)" />
              </AreaChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </Card>
  );
};

export default MoneyFlowPulseWidget;
