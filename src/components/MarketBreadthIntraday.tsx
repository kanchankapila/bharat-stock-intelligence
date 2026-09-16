import React from 'react';
import { Activity } from 'lucide-react';
import {
  LineChart, Line, CartesianGrid, XAxis, YAxis, Tooltip, ResponsiveContainer,
} from 'recharts';
import { trpc } from '../lib/trpc';
import { Card } from './MCCommon';
import { marketHoursRefetchInterval } from '../lib/timeFormat';

// Shared "Market Breadth (Intraday)" widget -- previously duplicated only inside
// MCIndexDetailPanel.tsx (index-detail-page-only). Reused as-is (same query, same
// visual) on Market Command Center's hero and on the Dashboard, so all three
// surfaces agree on one live adv/dec read instead of drifting.
interface MarketBreadthIntradayProps {
  ex?: 'N' | 'B';
  refetchInterval?: number;
  className?: string;
}

export const MarketBreadthIntraday: React.FC<MarketBreadthIntradayProps> = ({
  ex = 'N',
  refetchInterval = 10000,
  className,
}) => {
  const { data: advDec } = trpc.getAdvanceDecline.useQuery({ ex }, { refetchInterval: marketHoursRefetchInterval(refetchInterval) });
  const ad = (advDec as any)?.data;
  if (!ad) return null;

  const latest = ad['0'] || {};
  const advances = latest.advances ?? 0;
  const declines = latest.declines ?? 0;
  const unchanged = latest.unchanged ?? 0;
  const total = advances + declines + unchanged || 1;

  const allPoints = Object.values(ad as Record<string, any>)
    .filter((p: any) => p && typeof p.advances === 'number')
    .reverse();
  const step = Math.max(1, Math.floor(allPoints.length / 40));
  const chartSeries = allPoints
    .filter((_: any, i: number) => i % step === 0)
    .map((p: any, i: number) => ({ t: i, adv: p.advances, dec: p.declines }));

  return (
    <Card title="Market Breadth (Intraday)" icon={Activity} className={className}>
      <div className="space-y-3">
        <div className="flex justify-between items-end">
          <div className="text-center">
            <span className="text-[10px] font-black text-emerald-500 uppercase">Advances</span>
            <p className="text-lg font-black text-emerald-400">{advances}</p>
          </div>
          <div className="text-center">
            <span className="text-[10px] font-black text-slate-400 uppercase">Unchanged</span>
            <p className="text-lg font-black text-slate-400">{unchanged}</p>
          </div>
          <div className="text-center">
            <span className="text-[10px] font-black text-rose-500 uppercase">Declines</span>
            <p className="text-lg font-black text-rose-400">{declines}</p>
          </div>
        </div>
        <div className="h-2 w-full glass rounded-full overflow-hidden flex">
          <div className="h-full bg-emerald-500" style={{ width: `${(advances / total) * 100}%` }} />
          <div className="h-full bg-slate-700" style={{ width: `${(unchanged / total) * 100}%` }} />
          <div className="h-full bg-rose-500" style={{ width: `${(declines / total) * 100}%` }} />
        </div>
        {chartSeries.length > 3 && (
          <div className="h-28">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={chartSeries} margin={{ top: 2, right: 2, bottom: 0, left: -28 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                <XAxis dataKey="t" hide />
                <YAxis tick={{ fontSize: 8, fill: '#64748b' }} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '9px' }}
                  formatter={(v: any, n: string) => [v, n === 'adv' ? 'Advances' : 'Declines']}
                />
                <Line type="monotone" dataKey="adv" stroke="#10b981" strokeWidth={1.5} dot={false} />
                <Line type="monotone" dataKey="dec" stroke="#f43f5e" strokeWidth={1.5} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        )}
        <p className="text-[9.5px] text-center text-slate-300 font-bold font-display uppercase tracking-widest">
          {total} stocks • A/D Ratio: {declines > 0 ? (advances / declines).toFixed(2) : '—'}
        </p>
      </div>
    </Card>
  );
};

export default MarketBreadthIntraday;
