import { useMemo, useState } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { RefreshCw, TrendingUp, Users, Info } from 'lucide-react';
import {
  ResponsiveContainer, ComposedChart, Line, Bar, XAxis, YAxis,
  CartesianGrid, Tooltip, Legend, ReferenceLine,
} from 'recharts';
import { formatISTWithLocal, relativeFromNow } from '../lib/timeFormat';
import { V4QuickNav } from '../v4/components/V4QuickNav';

// fii_dii_flow was deep-backfilled to 2016-01-01 (fii_dii_history_fetcher.py) -- this page
// is the first place that history gets a real trend view instead of an 8-day snippet.
// fii_net/dii_net are era-normalized cash-equity/DII-aggregate net flows (Cr) by the fetcher
// itself -- see that file's docstring -- so no era-aware re-derivation is needed here.

type RangeKey = '1M' | '3M' | '1Y' | '3Y' | 'ALL';
const RANGE_DAYS: Record<RangeKey, number> = { '1M': 30, '3M': 90, '1Y': 365, '3Y': 1095, ALL: 4000 };

interface FlowRow {
  date: string;
  fii_net: number | null;
  dii_net: number | null;
  mf_total: number | null;
  fii_net_all_segments: number | null;
  source: string | null;
}

const crFmt = (v: number | null | undefined) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}₹${v.toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`;

function StatCard({ label, value, color, sub }: { label: string; value: string; color: string; sub?: string }) {
  return (
    <div className="bg-slate-800/50 border border-slate-700/50 rounded-xl p-3">
      <div className="text-[10px] text-slate-500 uppercase tracking-wide font-semibold">{label}</div>
      <div className={cn('text-lg font-bold mt-0.5', color)}>{value}</div>
      {sub && <div className="text-[10px] text-slate-500 mt-0.5">{sub}</div>}
    </div>
  );
}

export function MoneyFlowPage() {
  const [range, setRange] = useState<RangeKey>('3M');
  const [showMf, setShowMf] = useState(false);

  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = trpc.getFiiDiiFlow.useQuery(
    { days: RANGE_DAYS[range] },
    { staleTime: 15 * 60_000, refetchInterval: 30 * 60_000 }
  );

  const rows = useMemo<FlowRow[]>(() => {
    const list = ((data as FlowRow[] | undefined) ?? []).slice().reverse(); // ascending by date
    let cumFii = 0, cumDii = 0;
    return list.map(r => {
      cumFii += r.fii_net ?? 0;
      cumDii += r.dii_net ?? 0;
      return { ...r, cumFii, cumDii } as FlowRow & { cumFii: number; cumDii: number };
    });
  }, [data]);

  const stats = useMemo(() => {
    if (rows.length === 0) return null;
    const fiiVals = rows.map(r => r.fii_net).filter((v): v is number => v != null);
    const diiVals = rows.map(r => r.dii_net).filter((v): v is number => v != null);
    const sum = (arr: number[]) => arr.reduce((a, b) => a + b, 0);
    const fiiTotal = sum(fiiVals);
    const diiTotal = sum(diiVals);
    // Consecutive-day streak for FII, from the most recent row backward.
    let streak = 0;
    for (let i = rows.length - 1; i >= 0; i--) {
      const v = rows[i].fii_net;
      if (v == null) break;
      if (streak === 0) { streak = v >= 0 ? 1 : -1; continue; }
      const sameSign = streak > 0 ? v >= 0 : v < 0;
      if (!sameSign) break;
      streak += streak > 0 ? 1 : -1;
    }
    return {
      fiiTotal, diiTotal,
      fiiAvg: fiiVals.length ? fiiTotal / fiiVals.length : null,
      diiAvg: diiVals.length ? diiTotal / diiVals.length : null,
      streak,
      days: rows.length,
      latest: rows[rows.length - 1],
    };
  }, [rows]);

  const latestFetchedAt = data && data.length > 0 ? (data[0] as FlowRow & { fetched_at?: string }).fetched_at : null;

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 space-y-4">
      <V4QuickNav />
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <Users size={20} className="text-sky-400" />
            Money Flow — FII / DII / MF
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            Institutional cash-equity flow · {stats?.days ?? 0} trading days
            {latestFetchedAt && <> · latest row {formatISTWithLocal(latestFetchedAt)}</>}
            {dataUpdatedAt > 0 && <span className="ml-2 text-slate-600">· page data fetched {relativeFromNow(dataUpdatedAt)}</span>}
          </p>
        </div>
        <button
          onClick={() => refetch()}
          disabled={isFetching}
          className="flex items-center gap-1.5 px-3 py-1.5 bg-slate-800 hover:bg-slate-700 rounded-lg text-sm transition-colors disabled:opacity-50"
        >
          <RefreshCw size={13} className={isFetching ? 'animate-spin' : ''} />
          Refresh
        </button>
      </div>

      <div className="flex items-start gap-2 rounded-lg border border-sky-500/20 bg-sky-500/[0.05] px-3 py-2 text-xs text-sky-200/90">
        <Info size={14} className="mt-0.5 shrink-0 text-sky-400" />
        <div>
          FII net = cash-equity flow (derivatives excluded). DII net = NSE's full domestic-institution
          aggregate (banks, insurers and mutual funds combined) — mutual funds alone are the separate
          "MF" line. Figures are era-normalized across the full history, so early and recent dates are
          directly comparable.
        </div>
      </div>

      {/* Range + series toggle */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex bg-slate-800 border border-slate-700 rounded-lg overflow-hidden text-xs">
          {(['1M', '3M', '1Y', '3Y', 'ALL'] as RangeKey[]).map(r => (
            <button
              key={r}
              onClick={() => setRange(r)}
              className={cn('px-3 py-1.5 transition-colors', range === r ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white')}
            >
              {r === 'ALL' ? 'Since 2016' : r}
            </button>
          ))}
        </div>
        <button
          onClick={() => setShowMf(v => !v)}
          className={cn(
            'px-3 py-1.5 rounded-lg text-xs font-medium border transition-colors',
            showMf ? 'bg-indigo-600/30 border-indigo-500/50 text-indigo-200' : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
          )}
        >
          {showMf ? 'Hide' : 'Show'} MF-only line
        </button>
      </div>

      {/* Stats row */}
      {stats && (
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
          <StatCard label="FII net (period)" value={crFmt(stats.fiiTotal)} color={stats.fiiTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'} sub={`avg ${crFmt(stats.fiiAvg)}/day`} />
          <StatCard label="DII net (period)" value={crFmt(stats.diiTotal)} color={stats.diiTotal >= 0 ? 'text-emerald-400' : 'text-rose-400'} sub={`avg ${crFmt(stats.diiAvg)}/day`} />
          <StatCard label="Latest FII day" value={crFmt(stats.latest?.fii_net)} color={(stats.latest?.fii_net ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400'} sub={stats.latest?.date} />
          <StatCard
            label="FII streak"
            value={stats.streak === 0 ? '—' : `${Math.abs(stats.streak)}d ${stats.streak > 0 ? 'buying' : 'selling'}`}
            color={stats.streak > 0 ? 'text-emerald-400' : stats.streak < 0 ? 'text-rose-400' : 'text-slate-400'}
          />
        </div>
      )}

      {/* Cumulative flow chart */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">
          Cumulative net flow (₹ Cr) — {range === 'ALL' ? 'since 2016' : range}
        </div>
        {isLoading ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">Loading…</div>
        ) : rows.length === 0 ? (
          <div className="h-64 flex items-center justify-center text-slate-500 text-sm">No FII/DII data available.</div>
        ) : (
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} minTickGap={40} />
              <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={(v) => `${(v / 1000).toFixed(0)}k`} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }}
                formatter={(v: number, name: string) => [crFmt(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <ReferenceLine y={0} stroke="#475569" />
              <Line type="monotone" dataKey="cumFii" name="FII cumulative" stroke="#38bdf8" dot={false} strokeWidth={2} />
              <Line type="monotone" dataKey="cumDii" name="DII cumulative" stroke="#f59e0b" dot={false} strokeWidth={2} />
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Daily net flow bars */}
      <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
        <div className="text-[11px] font-semibold text-slate-400 uppercase tracking-wide mb-2">Daily net flow (₹ Cr)</div>
        {rows.length > 0 && (
          <ResponsiveContainer width="100%" height={220}>
            <ComposedChart data={rows} margin={{ top: 4, right: 8, left: 0, bottom: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke="#334155" />
              <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} minTickGap={40} />
              <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} />
              <Tooltip
                contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }}
                formatter={(v: number, name: string) => [crFmt(v), name]}
              />
              <Legend wrapperStyle={{ fontSize: 10 }} />
              <ReferenceLine y={0} stroke="#475569" />
              <Bar dataKey="fii_net" name="FII net" fill="#38bdf8" radius={[2, 2, 0, 0]} />
              <Bar dataKey="dii_net" name="DII net" fill="#f59e0b" radius={[2, 2, 0, 0]} />
              {showMf && <Bar dataKey="mf_total" name="MF net (subset of DII)" fill="#a78bfa" radius={[2, 2, 0, 0]} />}
            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      <p className="text-[10px] text-slate-600 flex items-center gap-1">
        <TrendingUp size={11} /> Source: NSE (recent) / investsights.in deep history (2016 onward), gap-filled without overwriting existing values.
      </p>
    </div>
  );
}
