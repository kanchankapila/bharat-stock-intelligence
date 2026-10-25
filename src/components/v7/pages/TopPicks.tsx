import React, { useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import {
  ShieldAlert, TrendingUp, TrendingDown, Search, Filter, RefreshCw,
  Activity, BookOpen, AlertTriangle,
} from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatINR, formatPct, DASH, mlRankLabel, convictionBadge } from '../lib';
import { KpiCard } from '../components/KpiCard';
import { AsOfBanner } from '../components/AsOfBanner';
import { DataTable, DataTableColumn } from '../components/DataTable';
import { SignalBadge, ConvictionBadge } from '../components/SignalBadge';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';

export const TopPicksPage: React.FC = () => {
  const [timeframe, setTimeframe] = useState<'long_term' | 'intraday'>('long_term');
  const navigate = useNavigate();
  const { data: picks, isLoading, isError } = trpc.getTopRatedStocks.useQuery(
    { limit: 50, timeframe },
    { staleTime: 5 * 60 * 1000, refetchInterval: 5 * 60 * 1000 },
  );

  const rows = (picks as any[]) ?? [];
  const asOf = rows.length > 0 ? rows[0]?.last_updated ?? null : null;

  const columns: DataTableColumn<any>[] = [
    { key: 'symbol', label: 'Symbol', width: 110, sortable: true },
    { key: 'classification', label: 'Signal', width: 110, sortable: false, format: (v) => <SignalBadge type={v} /> },
    { key: 'score', label: 'Score', width: 90, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(1) },
    { key: 'confidence', label: 'Confidence', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : `${Number(v).toFixed(0)}%` },
    { key: 'conviction_level', label: 'Conviction', width: 110, sortable: false, format: (v) => <ConvictionBadge level={v} /> },
    { key: 'position_size_pct', label: 'Position %', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : `${Number(v).toFixed(1)}%` },
    { key: 'adt_cr', label: 'ADT (₹ Cr)', width: 110, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(1) },
    { key: 'last_updated', label: 'Updated', width: 140, sortable: true, format: (v) => v ? new Date(v).toLocaleString('en-IN', { dateStyle: 'short', timeStyle: 'short' }) : DASH },
  ];

  if (isError) return <QueryError />;
  return (
    <div className="v7-page">
      <div className="v7-page-header">
        <div className="v7-page-title-wrap">
          <div className="v7-page-icon"><ShieldAlert size={20} strokeWidth={2} /></div>
          <div>
            <h1 className="v7-page-title">Top Picks — Canonical Ranking</h1>
            <p className="v7-page-kicker">Cross-engine unified recommendations (unified_recommendations) · not a single model</p>
          </div>
        </div>
        <div className="v7-page-actions">
          <div className="flex items-center gap-2">
            <button onClick={() => setTimeframe('long_term')} className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border', timeframe === 'long_term' ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'border-slate-700/40 text-slate-400')}>
              Positional
            </button>
            <button onClick={() => setTimeframe('intraday')} className={cn('px-3 py-1.5 rounded-lg text-xs font-semibold transition-colors border', timeframe === 'intraday' ? 'bg-indigo-500/20 text-indigo-400 border-indigo-500/30' : 'border-slate-700/40 text-slate-400')}>
              Intraday
            </button>
          </div>
          <AsOfBanner asOf={asOf} label="Ranking computed" stale={isLoading} />
          <button className="v7-btn v7-btn-ghost" onClick={() => window.location.reload()}>
            <RefreshCw className="w-4 h-4" size={16} strokeWidth={1.6} /> Refresh
          </button>
        </div>
      </div>

      {/* ─── Honesty banner ─── */}
      <div className="v7-card">
        <div className="v7-honesty-banner">
          <AlertTriangle size={14} strokeWidth={1.5} />
          <span className="font-medium">Read this first</span>
          <span className="ml-auto text-slate-300">The canonical rank is an evidence-weighted blend, not a probability of profit. ML rank is a percentile among today's stocks — out-of-sample, no recalibration beat a constant base rate. Treat every row as decision support, never as a guaranteed return.</span>
        </div>
        <p className="text-[11px] text-slate-500 mt-3">Nulls render as "—" deliberately: missing data is never shown as zero. Scores and classifications come from the latest computed batch only — no stale fallbacks are substituted.</p>
      </div>

      {/* ─── Table ─── */}
      <div className="v7-card">
        <DataTable
          columns={columns}
          data={rows}
          pageSize={25}
          loading={isLoading}
          onRowClick={(row) => navigate(`/v7-stock/${row.symbol}`)}
          emptyTitle={rows.length === 0 ? 'No top picks available' : 'No matching picks'}
          emptyText={rows.length === 0
            ? 'The latest unified_recommendations batch returned no ranked stocks. This can happen intraday before the first batch computes, or after a market holiday.'
            : 'Try clearing the filter or switching timeframe.'}
          getRowId={(row) => row.symbol}
        />
      </div>
    </div>
  );
};

export default TopPicksPage;
