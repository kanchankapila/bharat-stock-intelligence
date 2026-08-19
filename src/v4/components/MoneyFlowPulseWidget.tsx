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
// separate page visit. Same query/semantics as the full Money Flow page. Also folds in
// getInstitutionalFlows' per-category (FII/DII) buy/sell/net cards -- previously a second,
// separate "Institutional Flows" card elsewhere on the page; merged here since both show the
// same institutional-flow concept from two different sources and belong in one place.
export const MoneyFlowPulseWidget: React.FC = () => {
  const navigate = useNavigate();
  const { data, isLoading } = trpc.getFiiDiiFlow.useQuery({ days: 10 }, { refetchInterval: 30 * 60_000 });
  const { data: instData } = trpc.getInstitutionalFlows.useQuery();
  const flows = instData?.data?.institutionalDetails ?? [];

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
              <div className={cn('text-sm font-mono font-bold', latest.fii_net == null ? 'text-slate-400' : latest.fii_net >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                {crFmt(latest.fii_net)}
              </div>
              <div className="text-[9px] text-slate-500 uppercase tracking-widest mt-0.5">FII Net (latest)</div>
            </div>
            <div>
              <div className={cn('text-sm font-mono font-bold', latest.dii_net == null ? 'text-slate-400' : latest.dii_net >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
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

      {flows.length > 0 && (
        <div className="mt-4 pt-4 border-t border-slate-800/50 space-y-2">
          <div className="text-[9px] text-slate-500 uppercase tracking-widest">Institutional Activity</div>
          {flows.slice(0, 2).map((flow: any) => {
            // netBuySell/buyValue/sellValue come back null (not "0.00") when the source row is
            // missing -- render '—' rather than parseFloat(null)-as-zero, which used to be
            // indistinguishable from a genuine flat day (1,908/2,601 fii_dii_flow rows have
            // NULL dii_net, live-checked 2026-08-14).
            const net = flow.netBuySell != null ? parseFloat(flow.netBuySell) : null;
            const buy = flow.buyValue != null ? parseFloat(flow.buyValue) : null;
            const sell = flow.sellValue != null ? parseFloat(flow.sellValue) : null;
            return (
              <div key={flow.category} className="p-3 bg-slate-950 border border-slate-800 rounded-xl flex justify-between items-center">
                <div>
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">{flow.category} Activity</h4>
                  <p className="text-[9px] font-bold text-slate-600 mt-0.5 uppercase tracking-wider">Date: {flow.date}</p>
                </div>
                <div className="text-right">
                  <span className={cn(
                    'text-xs font-black italic tracking-tight px-2.5 py-0.5 rounded-lg block mb-1',
                    net == null ? 'bg-slate-800/50 text-slate-500 border border-slate-700/50'
                      : net >= 0 ? 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/10' : 'bg-rose-500/10 text-rose-400 border border-rose-500/10'
                  )}>
                    {crFmt(net)}
                  </span>
                  <div className="flex gap-2 text-[9px] font-bold text-slate-500 justify-end">
                    <span>B: {buy != null ? `₹${buy.toLocaleString()}` : '—'}</span>
                    <span>•</span>
                    <span>S: {sell != null ? `₹${sell.toLocaleString()}` : '—'}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}
    </Card>
  );
};

export default MoneyFlowPulseWidget;
