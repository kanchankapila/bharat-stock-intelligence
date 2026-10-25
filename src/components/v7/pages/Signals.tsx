import React, { useMemo } from 'react';
import {
  Activity, TrendingUp, TrendingDown, RefreshCw, ShieldAlert,
  Clock, PieChart, AlertTriangle,
} from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatPct, DASH, mlRankLabel } from '../lib';
import { KpiCard } from '../components/KpiCard';
import { AsOfBanner } from '../components/AsOfBanner';
import { DataTable, DataTableColumn } from '../components/DataTable';
import { SignalBadge } from '../components/SignalBadge';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';

export const SignalsPage: React.FC = () => {
  const { data: signals, isLoading: signalsLoading, isError: signalsError } = trpc.getSignals.useQuery(
    { limit: 25 },
    { staleTime: 5 * 60 * 1000, refetchInterval: 5 * 60 * 1000 },
  );
  const { data: tracking, isLoading: trackingLoading, isError: trackingError } = trpc.getSignalTracking.useQuery(
    { days: 30 },
    { staleTime: 5 * 60 * 1000 },
  );
  const { data: accuracy, isLoading: accuracyLoading, isError: accuracyError } = trpc.getAccuracyMetrics.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  });

  const rows = (signals as any[]) ?? [];
  const tracked = (tracking as any[]) ?? [];
  const acc = (accuracy as any) ?? {};

  const asOf = rows.length > 0 ? rows[0]?.createdAt ?? null : null;

  // getSignalTracking rows carry growth_pct/current_price/status but NO outcome grade —
  // WIN/LOSS lives in unified_signal_outcomes and reaches us only via getAccuracyMetrics.
  // Deriving a win-rate from a field that does not exist would render every row PENDING;
  // the measured numbers come from acc instead.
  const overall = useMemo(() => {
    const growths = tracked
      .map((t) => t.growth_pct)
      .filter((g) => g != null && Number.isFinite(Number(g)))
      .map(Number);
    const avgGrowth = growths.length ? growths.reduce((s, g) => s + g, 0) / growths.length : null;
    const pending = acc.totalSignals != null && acc.resolvedSignals != null
      ? Math.max(0, Number(acc.totalSignals) - Number(acc.resolvedSignals))
      : null;
    return { avgGrowth, pending };
  }, [tracked, acc]);
  if (signalsError || trackingError || accuracyError) return <QueryError />;
  return (
    <div className="v7-page">
      <div className="v7-page-header">
        <div className="v7-page-title-wrap">
          <div className="v7-page-icon"><ShieldAlert size={20} strokeWidth={2} /></div>
          <div>
            <h1 className="v7-page-title">Signals & Tracking</h1>
            <p className="v7-page-kicker">Latest signals, outcome tracking, and measured accuracy — never backtested as a guarantee</p>
          </div>
        </div>
        <div className="v7-page-actions">
          <AsOfBanner asOf={asOf} label="Signals" stale={signalsLoading} />
          <button className="v7-btn v7-btn-ghost" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4" size={16} strokeWidth={1.6} /> Refresh
          </button>
        </div>
      </div>

      {/* ─── KPI strip ─── */}
      <div className="v7-kpi-grid">
        <KpiCard title="Signals tracked (30d)" value={tracking == null ? null : tracked.length} change={null} changePct={null} unit="number" />
        <KpiCard title="Avg growth vs entry" value={overall.avgGrowth} change={overall.avgGrowth} changePct={null} unit="pct" decimals={2} />
        <KpiCard title="Precision (15d LONG)" value={acc.precision} change={null} changePct={null} unit="pct" decimals={1} asOf={acc.asOf ?? null} />
        <KpiCard title="Pending resolution" value={overall.pending} change={null} changePct={null} unit="number" />
      </div>

      {/* ─── Accuracy honesty ─── */}
      <div className="v7-card">
        <div className="v7-honesty-banner">
          <AlertTriangle size={14} strokeWidth={1.5} />
          <span className="font-medium">Accuracy ≠ edge</span>
          <span className="ml-auto text-slate-300">Precision is WIN / (WIN + LOSS + STOP_LOSS) on LONG-geometry signals at a 15-day horizon, from unified_signal_outcomes. NEUTRAL rows and PENDING signals are excluded — never counted as wins. A historical hit rate is not a forward-looking edge.</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-3">Only signals with a resolved outcome are graded. Unresolved (PENDING) signals carry no claim until an outcome is recorded.</p>
      </div>

      {/* ─── Latest signals ─── */}
      <div className="v7-section">
        <div className="v7-section-head">
          <div>
            <h2 className="v7-section-title">Latest Signals</h2>
            <p className="v7-section-sub">unified_signals — most recent first</p>
          </div>
        </div>
        <div className="v7-card">
          <div className="v7-table-wrap">
            <table className="v7-table">
              <thead>
                <tr>
                  <th className="w-48">Symbol</th>
                  <th className="text-center w-40">Type</th>
                  <th className="text-right w-48">Entry</th>
                  <th className="text-right w-48">Target</th>
                  <th className="text-right w-48">Stop</th>
                  <th className="text-right w-48">Confidence</th>
                  <th className="text-right w-64">Generated</th>
                  <th className="text-right w-48">Status</th>
                </tr>
              </thead>
              <tbody>
                {rows.length ? rows.map((s: any) => (
                  <tr key={s.id}>
                    <td className="font-data font-bold text-slate-200">{s.symbol}</td>
                    <td className="text-center"><SignalBadge type={s.type ?? null} className="mx-auto" /></td>
                    <td className="text-right font-data text-slate-300">{s.entry == null ? DASH : Number(s.entry).toFixed(2)}</td>
                    <td className="text-right font-data text-slate-300">{s.target == null ? DASH : Number(s.target).toFixed(2)}</td>
                    <td className="text-right font-data text-slate-300">{s.stopLoss == null ? DASH : Number(s.stopLoss).toFixed(2)}</td>
                    <td className="text-right font-data text-slate-300">{s.confidence == null ? DASH : Number(s.confidence).toFixed(0)}%</td>
                    <td className="text-right font-data text-slate-300">{s.createdAt ? new Date(s.createdAt).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : '—'}</td>
                    <td className="text-right text-xs font-medium text-slate-400">{s.status ?? '—'}</td>
                  </tr>
                )) : (
                  <tr><td colSpan={8} className="text-center py-6 text-slate-500">No signals generated yet.</td></tr>
                )}
              </tbody>
            </table>
          </div>
        </div>
      </div>

      {/* ─── Tracking table ─── */}
      <div className="v7-section mt-6">
        <div className="v7-section-head">
          <div>
            <h2 className="v7-section-title">Outcome Tracking (30d)</h2>
            <p className="v7-section-sub">Resolved vs pending signals with current price and growth vs entry</p>
          </div>
        </div>
        <div className="v7-card">
          <DataTable
            columns={[
              { key: 'symbol', label: 'Symbol', width: 120, sortable: true },
              { key: 'signal_type', label: 'Type', width: 90, sortable: true, format: (v) => <SignalBadge type={v} className="mx-auto" /> },
              { key: 'entry_price', label: 'Entry', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(2) },
              { key: 'current_price', label: 'Current', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(2) },
              { key: 'growth_pct', label: 'Growth %', width: 110, sortable: true, align: 'right', format: (v) => v == null ? DASH : formatPct(v, 2, true) },
              { key: 'status', label: 'Status', width: 110, sortable: true, format: (v) => v == null ? DASH : <span className="text-slate-300">{v}</span> },
              { key: 'signal_generated_at', label: 'Generated', width: 150, sortable: true, format: (v) => v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : DASH },
            ]}
            data={tracked}
            pageSize={25}
            loading={trackingLoading}
            emptyTitle={tracked.length === 0 ? 'No tracked signals' : 'No tracked signals in window'}
            emptyText="Signal tracking pulls from unified_signals joined to the latest close per symbol."
            getRowId={(row) => `${row.symbol}-${row.signal_generated_at}`}
          />
        </div>
      </div>

      {/* ─── Model accuracy (server-side measured) ─── */}
      <div className="v7-section mt-6">
        <div className="v7-section-head">
          <div>
            <h2 className="v7-section-title">Model Accuracy (Measured)</h2>
            <p className="v7-section-sub">Resolved outcomes — unified_signal_outcomes, {acc.horizonDays ?? '—'}-session horizon, LONG geometry</p>
          </div>
        </div>
        <div className="v7-card">
          <div className="v7-grid-cols-3">
            <div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Precision (WIN / decisive)</div>
              <div className="font-data font-bold text-slate-200">{acc.precision == null ? DASH : `${Number(acc.precision).toFixed(1)}%`}</div>
              <div className="text-[10px] text-slate-500 mt-1">{acc.wins ?? 0} wins of {acc.decisiveSignals ?? 0} decisive</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Resolved / total signals</div>
              <div className="font-data font-bold text-slate-200">{acc.resolvedSignals ?? DASH} / {acc.totalSignals ?? DASH}</div>
              <div className="text-[10px] text-slate-500 mt-1">{acc.neutralSignals ?? 0} neutral — excluded from precision</div>
            </div>
            <div>
              <div className="text-[10px] font-semibold text-slate-500 uppercase mb-1">Avg gross return</div>
              <div className="font-data font-bold text-slate-200">{acc.avgGrossReturnPct == null ? DASH : formatPct(acc.avgGrossReturnPct, 2, true)}</div>
              <div className="text-[10px] text-slate-500 mt-1">GROSS of transaction costs</div>
            </div>
          </div>
          <p className="text-[11px] text-slate-500 mt-3">
            {`Measured on ${acc.side ?? 'LONG'}-geometry signals only (target > stop, the resolver's own direction rule) at a ${acc.horizonDays ?? '—'}-session horizon`}
            {acc.asOf ? `, resolved as of ${new Date(acc.asOf).toLocaleDateString('en-IN')}` : ''}.
            Precision counts WIN / (WIN + LOSS + STOP_LOSS); NEUTRAL outcomes are reported but excluded from the ratio, and PENDING signals (in `totalSignals`) earn no claim until resolved. Returns are gross of costs — a historical hit rate, not a forward edge.
          </p>
        </div>
      </div>
    </div>
  );
};

export default SignalsPage;
