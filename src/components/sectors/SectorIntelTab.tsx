import React from 'react';
import { ScatterChart, Scatter, XAxis, YAxis, ZAxis, Tooltip, ResponsiveContainer, ReferenceLine, Legend } from 'recharts';
import { trpc } from '../../lib/trpc';
import { QueryError } from '../IntelligenceQueryError';
import { DataTable, type Column } from '../DataTable';

type RrgRow = {
  sector: string; week_date: string; rs_ratio: number; rs_momentum: number;
  sector_return: number | null; stocks_count: number | null; quadrant: string | null;
};
type PairRow = { sector_a: string; sector_b: string; correlation: number; pair_type: string };
type StatRow = { sector: string; avg_daily_return: number | null; volatility: number | null; total_return: number | null; data_points: number | null };
type Summary = { data_date: string; avg_pairwise_correlation: number; pct_pairs_above_0_7: number; total_pairs: number; takeaway: string } | null;
type MfRow = { month: string; sector: string; aum_cr: number | null; aum_pct: number | null };

const QUADRANT_COLOR: Record<string, string> = {
  Leading: '#10b981', Improving: '#06b6d4', Weakening: '#f59e0b', Lagging: '#f43f5e',
};

const num = (v: unknown, digits = 2): string =>
  typeof v === 'number' && Number.isFinite(v) ? v.toFixed(digits) : 'â€”';

// Latest vs previous month aum_pct per sector â€” a two-snapshot delta, nothing smoothed.
export function mfDeltas(rows: MfRow[]): { sector: string; latestMonth: string; prevPct: number | null; latestPct: number | null; delta: number | null }[] {
  if (rows.length === 0) return [];
  const months = [...new Set(rows.map((r) => r.month))].sort().reverse();
  const [latest, prev] = months;
  const pick = (month: string) => new Map(rows.filter((r) => r.month === month).map((r) => [r.sector, r]));
  const latestMap = pick(latest);
  const prevMap = prev ? pick(prev) : new Map();
  return [...latestMap.entries()].map(([sector, r]) => {
    const latestPct = typeof r.aum_pct === 'number' ? r.aum_pct : null;
    const prevRow = prevMap.get(sector);
    const prevPct = prevRow && typeof prevRow.aum_pct === 'number' ? prevRow.aum_pct : null;
    const delta = latestPct != null && prevPct != null ? +(latestPct - prevPct).toFixed(2) : null;
    return { sector, latestMonth: latest, prevPct, latestPct, delta };
  }).sort((a, b) => (b.delta ?? -999) - (a.delta ?? -999));
}


export function SectorIntelTab() {
  const intel = trpc.getSectorRotationIntel.useQuery(undefined, { staleTime: 900_000, retry: false });
  const mf = trpc.getSectorMfFlows.useQuery(undefined, { staleTime: 3_600_000, retry: false });
  const data = intel.data as {
    rrg: RrgRow[]; correlationPairs: PairRow[]; sectorStats: StatRow[]; summary: Summary;
  } | undefined;
  const rrg = data?.rrg ?? [];
  const stats = (data?.sectorStats ?? []) as StatRow[];
  const deltas = mfDeltas((mf.data ?? []) as MfRow[]);

  const statColumns: Column<StatRow>[] = [
    { key: 'sector', label: 'Sector' },
    { key: 'total_return', label: 'Total return', sortable: true, render: (r) => num(r.total_return) },
    { key: 'volatility', label: 'Volatility', sortable: true, render: (r) => num(r.volatility) },
    { key: 'avg_daily_return', label: 'Avg daily', sortable: true, render: (r) => num(r.avg_daily_return, 3) },
    { key: 'data_points', label: 'Days', sortable: true },
  ];

  const deltaColumns: Column<ReturnType<typeof mfDeltas>[number]>[] = [
    { key: 'sector', label: 'Sector' },
    { key: 'latestMonth', label: 'Month' },
    { key: 'prevPct', label: 'Prev %', render: (r) => num(r.prevPct) },
    { key: 'latestPct', label: 'Now %', render: (r) => num(r.latestPct) },
    { key: 'delta', label: 'Î” allocation', sortable: true, render: (r) => (
      <span className={r.delta == null ? 'text-slate-500' : r.delta > 0 ? 'text-emerald-300' : r.delta < 0 ? 'text-rose-300' : 'text-slate-400'}>
        {r.delta == null ? 'â€”' : `${r.delta > 0 ? '+' : ''}${r.delta.toFixed(2)}`}
      </span>
    ) },
  ];

  return (
    <div className="space-y-6">
      {intel.isError && <QueryError retry={() => void intel.refetch()} />}
      {intel.isLoading ? (
        <p role="status" className="text-slate-400 text-sm">Loading sector RRG and correlation intelâ€¦</p>
      ) : !data ? (
        <p className="text-slate-400 text-sm">No sector rotation intel stored (investsights sector_rrg_history / sector_correlation_* tables are empty).</p>
      ) : (
        <>
          {data.summary && (
            <div className="grid gap-4 sm:grid-cols-3">
              <div className="bsi-kpi"><span className="bsi-kpi-label">Avg pairwise correlation</span><span className="bsi-kpi-value">{num(data.summary.avg_pairwise_correlation)}</span></div>
              <div className="bsi-kpi"><span className="bsi-kpi-label">Pairs above 0.7</span><span className="bsi-kpi-value">{num(data.summary.pct_pairs_above_0_7, 1)}%</span><span className="bsi-kpi-sub">{data.summary.total_pairs ?? 'â€”'} pairs Â· {data.summary.data_date ?? ''}</span></div>
              <div className="bsi-kpi"><span className="bsi-kpi-label">Service takeaway</span><span className="bsi-kpi-sub normal-case tracking-normal">{data.summary.takeaway ?? 'â€”'}</span></div>
            </div>
          )}

          <div>
            <h3 className="font-display text-sm uppercase tracking-wider text-slate-300 mb-2">RRG â€” relative strength vs momentum (latest week)</h3>
            {rrg.length === 0 ? (
              <p className="bsi-intel-note">No RRG rows for the latest week.</p>
            ) : (
              <div className="h-80">
                <ResponsiveContainer width="100%" height="100%">
                  <ScatterChart margin={{ top: 8, right: 16, bottom: 8, left: 8 }}>
                    <XAxis type="number" dataKey="rs_ratio" name="RS ratio" domain={['dataMin', 'dataMax']}
                      tick={{ fill: '#94a3b8', fontSize: 10 }} label={{ value: 'RS Ratio â†’', position: 'insideBottomRight', fill: '#64748b', fontSize: 10 }} />
                    <YAxis type="number" dataKey="rs_momentum" name="RS momentum" domain={['dataMin', 'dataMax']}
                      tick={{ fill: '#94a3b8', fontSize: 10 }} />
                    <ZAxis type="number" dataKey="stocks_count" range={[40, 160]} />
                    <Tooltip cursor={{ strokeDasharray: '3 3' }} />
                    <ReferenceLine x={100} stroke="rgba(148,163,184,0.4)" />
                    <ReferenceLine y={100} stroke="rgba(148,163,184,0.4)" />
                    <Legend />
                    {['Leading', 'Improving', 'Weakening', 'Lagging'].map((q) => {
                      const points = rrg.filter((r) => (r.quadrant ?? '').toLowerCase() === q.toLowerCase());
                      if (points.length === 0) return null;
                      return <Scatter key={q} name={q} data={points} fill={QUADRANT_COLOR[q]} fillOpacity={0.75} />;
                    })}
                  </ScatterChart>
                </ResponsiveContainer>
              </div>
            )}
            <p className="bsi-intel-note mt-1">Quadrants as stored by the vendor (Leading/Improving/Weakening/Lagging); bubble size = constituent count. Pivot lines at 100 are the RRG convention, drawn for orientation only.</p>
          </div>

          <div className="grid gap-4 lg:grid-cols-2">
            <div>
              <h3 className="font-display text-sm uppercase tracking-wider text-slate-300 mb-2">Notable correlation pairs</h3>
              {(data.correlationPairs ?? []).length === 0 ? (
                <p className="bsi-intel-note">No correlation pairs stored.</p>
              ) : (
                <ul className="space-y-1.5 text-xs">
                  {(data.correlationPairs ?? []).slice(0, 12).map((p, i) => (
                    <li key={`${p.sector_a}-${p.sector_b}-${i}`} className="flex items-center justify-between gap-2 border-b border-white/5 pb-1">
                      <span className="text-slate-300">{p.sector_a} â†” {p.sector_b}</span>
                      <span className="flex items-center gap-2">
                        <span className={p.pair_type.toLowerCase().includes('divers') ? 'text-emerald-300' : 'text-amber-300'}>{p.pair_type}</span>
                        <span className="font-mono text-slate-200">{num(p.correlation)}</span>
                      </span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <h3 className="font-display text-sm uppercase tracking-wider text-slate-300 mb-2">Sector return / volatility stats</h3>
              <DataTable data={stats} columns={statColumns} rowKey={(r) => r.sector} emptyMessage="No sector correlation stats stored." maxHeight="280px" dense />
            </div>
          </div>

          <div>
            <h3 className="font-display text-sm uppercase tracking-wider text-slate-300 mb-2">MF allocation shifts (latest vs previous month)</h3>
            {mf.isLoading ? (
              <p role="status" className="bsi-intel-note">Loading MF allocationsâ€¦</p>
            ) : deltas.length === 0 ? (
              <p className="bsi-intel-note">No MF sector allocation rows stored (mf_sector_allocation).</p>
            ) : (
              <DataTable data={deltas} columns={deltaColumns} rowKey={(r) => r.sector} emptyMessage="No MF allocation rows." maxHeight="300px" dense />
            )}
          </div>
        </>
      )}
      <p className="bsi-intel-note">RRG and correlation data are third-party computed (investsights) and synced â€” context for diversification, not entries. NOT FINANCIAL ADVICE.</p>
    </div>
  );
}