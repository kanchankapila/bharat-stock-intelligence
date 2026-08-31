import React, { useState } from 'react';
import {
  TrendingUp, BarChart2, Zap, Shield, Users, Globe, Star, AlertTriangle,
  Activity, Layers, RefreshCcw, Calendar, BarChart, ChevronDown, ChevronUp,
  ArrowUpRight, Clock, Database
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';

// ── Tier config ───────────────────────────────────────────────────────────────
const TIER_BADGE = {
  A:        'v1-badge-s',
  B:        'v1-badge-a',
  C:        'v1-badge-b',
  D:        'v1-badge-c',
  Unranked: '',
} as const;

function tierBadgeClass(t: string | null) {
  return TIER_BADGE[(t ?? 'Unranked') as keyof typeof TIER_BADGE] ?? '';
}

// ── Category icon map ─────────────────────────────────────────────────────────
const CAT_ICON: Record<string, React.ElementType> = {
  technical_trend:       TrendingUp,
  technical_reversal:    RefreshCcw,
  technical_breakout:    Zap,
  technical_momentum:    BarChart2,
  fundamental_quality:   Shield,
  fundamental_growth:    TrendingUp,
  valuation:             BarChart,
  ownership_institutional: Users,
  sector_theme:          Globe,
  composite_strategy:    Star,
  income_dividend:       ArrowUpRight,
  event_corporate_action: Calendar,
  risk_red_flags:        AlertTriangle,
  analyst_sentiment:     Activity,
  volume_liquidity:      BarChart2,
  volatility:            Activity,
  market_cap_style:      Layers,
  derivatives_positioning: Layers,
  other:                 Database,
};

const SOURCE_COLORS: Record<string, string> = {
  trendlyne:    'v1-text-secondary',
  moneycontrol: 'v1-text-accent',
  etnow:        'v1-text-neutral',
  ETnow:        'v1-text-neutral',
  Trendlyne:    'v1-text-secondary',
  MoneyControl: 'v1-text-accent',
};

function pct(n: number | null | undefined) {
  if (n == null) return '—';
  return `${(n * 100).toFixed(1)}%`;
}

function fmtScore(n: number | null | undefined) {
  if (n == null) return '—';
  return n.toFixed(3);
}

// ── Category stats card ───────────────────────────────────────────────────────
function CategoryCard({ cat, onClick, active }: {
  cat: any;
  onClick: () => void;
  active: boolean;
}) {
  const Icon = CAT_ICON[cat.category] ?? Database;
  const wr = cat.avg_win_rate ? (cat.avg_win_rate * 100).toFixed(1) : null;
  const label = (cat.category as string).replace(/_/g, ' ');

  return (
    <button
      onClick={onClick}
      className={cn('v1-card text-left p-3', active && 'ring-2 ring-indigo-500/60')}
    >
      <div className="flex items-center gap-2 mb-2">
        <Icon className={cn('w-3.5 h-3.5 flex-shrink-0', active ? 'text-indigo-400' : 'text-slate-500')} />
        <span className="text-[11px] font-semibold text-slate-300 capitalize truncate">{label}</span>
      </div>
      <div className="flex items-end justify-between">
        <div>
          {/* ponytail: v1-data-value/label are sized for headline KPI strips (text-lg);
              this grid packs 9 tiles per row, too narrow for that scale -- kept the original
              compact sizing, only the card container (background/border) was unified. */}
          <p className={cn('text-sm font-bold', wr && parseFloat(wr) >= 60 ? 'text-emerald-400' : 'text-slate-300')}>
            {wr ? `${wr}%` : '—'}
          </p>
          <p className="text-[10px] text-slate-500">win rate</p>
        </div>
        <div className="text-right">
          <p className="text-xs font-semibold text-slate-400">{cat.screener_count}</p>
          <p className="text-[10px] text-slate-500">count</p>
        </div>
      </div>
      {cat.tier_ab_count > 0 && (
        <div className="mt-1.5 flex gap-1">
          <span className="text-[9px] bg-indigo-500/20 text-indigo-400 px-1.5 py-0.5 rounded">
            {cat.tier_ab_count} A/B
          </span>
        </div>
      )}
    </button>
  );
}

// ── Screener row ──────────────────────────────────────────────────────────────
function ScreenerRow({ row, selected, onClick }: { row: any; selected: boolean; onClick: () => void }) {
  const sc = SOURCE_COLORS[row.source] ?? 'text-slate-400';

  return (
    <tr
      onClick={onClick}
      className={cn(
        'cursor-pointer transition-colors text-xs',
        selected ? 'bg-indigo-500/10' : 'hover:bg-slate-800/40'
      )}
    >
      <td className="px-3 py-2.5 max-w-[220px]">
        <p className="font-medium text-slate-200 truncate" title={row.name}>{row.name}</p>
        <p className={cn('text-[10px] mt-0.5', sc)}>{row.source}</p>
      </td>
      <td className="px-3 py-2.5">
        <span className={cn('v1-badge text-[10px]', tierBadgeClass(row.tier))}>
          {row.tier ?? 'Unranked'}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-data">
        <span className={cn(row.win_rate >= 0.6 ? 'text-emerald-400' : 'text-slate-300')}>
          {pct(row.win_rate)}
        </span>
      </td>
      <td className="px-3 py-2.5 text-right font-data text-slate-300">{fmtScore(row.bayesian_score)}</td>
      <td className="px-3 py-2.5 text-right text-slate-400">{row.resolved_count}</td>
      <td className="px-3 py-2.5 text-slate-500 capitalize text-[10px]">
        {row.category?.replace(/_/g, ' ')}
      </td>
    </tr>
  );
}

// ── Detail panel ──────────────────────────────────────────────────────────────
function ScreenerDetail({ screenerId }: { screenerId: string }) {
  const { data, isLoading } = trpc.getScreenerDetail.useQuery({ screener_id: screenerId });

  if (isLoading) return <div className="p-4 text-slate-500 text-xs">Loading…</div>;
  if (!data?.perf) return <div className="p-4 text-slate-500 text-xs">No data</div>;

  const p = data.perf as any;

  return (
    <div className="p-4 space-y-4 overflow-y-auto max-h-full">
      <div>
        <p className="text-sm font-semibold text-white leading-tight">{p.name}</p>
        <div className="flex items-center gap-2 mt-1">
          <span className={cn('v1-badge text-[10px]', tierBadgeClass(p.tier))}>
            {p.tier ?? 'Unranked'}
          </span>
          <span className={cn('text-[10px]', SOURCE_COLORS[p.source] ?? 'text-slate-400')}>{p.source}</span>
        </div>
      </div>

      {/* Metrics grid */}
      <div className="grid grid-cols-2 gap-2">
        {[
          ['Win Rate 5D', pct(p.wr_5d)],
          ['Win Rate 20D', pct(p.wr_20d)],
          ['Avg Return 20D', p.avg_ret_20d != null ? `${(p.avg_ret_20d).toFixed(2)}%` : '—'],
          ['Sharpe 20D', p.sharpe_20d?.toFixed(2) ?? '—'],
          ['Alpha 20D', p.alpha_20d != null ? `${p.alpha_20d.toFixed(2)}%` : '—'],
          ['Bayesian', p.bayesian_score?.toFixed(3) ?? '—'],
          ['Appearances', p.total_appearances],
          ['Resolved', p.resolved_count],
        ].map(([label, val]) => (
          <div key={label as string} className="bg-slate-800/40 rounded-lg p-2">
            <p className="text-[10px] text-slate-500">{label}</p>
            <p className="text-sm font-semibold text-slate-200">{val}</p>
          </div>
        ))}
      </div>

      {/* Top stocks */}
      {(data.topStocks as any[]).length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 mb-2">Most frequent stocks</p>
          <div className="flex flex-wrap gap-1.5">
            {(data.topStocks as any[]).slice(0, 12).map((s: any) => (
              <span key={s.symbol} className="text-[10px] bg-slate-800 text-slate-300 px-2 py-0.5 rounded">
                {s.symbol} <span className="text-slate-500">×{s.appearances}</span>
              </span>
            ))}
          </div>
        </div>
      )}

      {/* Recent appearances */}
      {(data.recentAppearances as any[]).length > 0 && (
        <div>
          <p className="text-[11px] font-semibold text-slate-400 mb-2">Recent appearances</p>
          <div className="space-y-1">
            {(data.recentAppearances as any[]).slice(0, 8).map((a: any, i: number) => (
              <div key={i} className="flex items-center justify-between text-[10px] py-1 border-b border-slate-800/50">
                <span className="text-slate-300 font-data">{a.symbol}</span>
                <span className="text-slate-500">{a.appeared_date}</span>
                {a.outcome_20d && (
                  <span className={cn(
                    'px-1.5 py-0.5 rounded text-[9px] font-bold',
                    a.outcome_20d === 'WIN' ? 'bg-emerald-500/20 text-emerald-400' :
                    a.outcome_20d === 'LOSS' ? 'bg-rose-500/20 text-rose-400' :
                    a.outcome_20d === 'PENDING' ? 'bg-amber-500/20 text-amber-400' :
                    'bg-slate-700 text-slate-400'
                  )}>{a.outcome_20d}</span>
                )}
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ── Main page ─────────────────────────────────────────────────────────────────
const HORIZONS = ['5d', '10d', '20d', '60d', '120d'] as const;
const TIERS = ['A', 'B', 'C', 'D', 'Unranked'] as const;
const SOURCES = ['trendlyne', 'moneycontrol', 'etnow'] as const;

export function ScreenerIntelligencePage() {
  const [horizon, setHorizon] = useState<typeof HORIZONS[number]>('20d');
  const [filterTier, setFilterTier] = useState<string>('');
  const [filterCategory, setFilterCategory] = useState<string>('');
  const [filterSource, setFilterSource] = useState<string>('');
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [sortAsc, setSortAsc] = useState(false);

  const { data: categoryStats } = trpc.getScreenerCategoryStats.useQuery({ horizon });
  const { data: leaderboard, isLoading } = trpc.getScreenerLeaderboard.useQuery({
    horizon,
    tier: (filterTier as any) || undefined,
    category: filterCategory || undefined,
    source: (filterSource as any) || undefined,
    limit: 100,
  });

  const { mutate: triggerRecompute, isPending: recomputing } =
    trpc.triggerScreenerPerformanceRecompute.useMutation();

  const rows = (leaderboard ?? []) as any[];
  const sorted = sortAsc ? [...rows].reverse() : rows;

  // Unique categories in current results for filter pill
  const cats = categoryStats as any[] ?? [];
  // Sort categories by avg_win_rate desc
  const topCats = [...cats].sort((a, b) => (b.avg_win_rate ?? 0) - (a.avg_win_rate ?? 0));

  return (
    <div className="flex h-full" style={{ minHeight: 0 }}>
      {/* Main content */}
      <div className="flex-1 flex flex-col overflow-hidden">
        {/* Header */}
        <div className="flex items-center justify-between px-5 py-3 border-b border-slate-800/50 flex-shrink-0">
          <div>
            <h1 className="v1-title-page flex items-center gap-2">
              <BarChart2 className="w-4 h-4 text-indigo-400" />
              Screener Intelligence
            </h1>
            <p className="text-[11px] text-slate-500 mt-0.5">
              {rows.length} screeners · Bayesian tier ranking
            </p>
          </div>
          <div className="flex items-center gap-2">
            {/* Horizon pills */}
            <div className="flex items-center gap-1 bg-slate-800/50 rounded-lg p-1">
              {HORIZONS.map(h => (
                <button
                  key={h}
                  onClick={() => setHorizon(h)}
                  className={cn(
                    'text-[10px] px-2 py-0.5 rounded transition-colors',
                    horizon === h ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200'
                  )}
                >{h}</button>
              ))}
            </div>
            <button
              onClick={() => triggerRecompute({})}
              disabled={recomputing}
              className="text-[10px] px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 text-slate-400 flex items-center gap-1.5 disabled:opacity-50"
            >
              <RefreshCcw className={cn('w-3 h-3', recomputing && 'animate-spin')} />
              Recompute
            </button>
          </div>
        </div>

        {/* shell-parity-audit, 2026-08-14: v5's ScreenerLabPage and v6's ScreenerBrowserPage
            already carry this disclaimer (same screener_performance_v2-backed Win Rate
            leaderboard, same getScreenerLeaderboard query) but this page -- routed at
            /screener-intelligence in v1, v2, v3, AND v6 (the default shell) -- didn't. */}
        <div className="px-5 pt-3 flex-shrink-0">
          <LegacyScoreBanner note="Tier, Win Rate, Avg Return, and Alpha are precomputed per-screener in screener_performance_v2. A from-scratch remeasurement of this same table found its win-rate figures didn't reproduce (one screener read 100%, remeasured at 65%), and 0 of 1,563 individual screeners tested clear a false-discovery correction -- treat this as a browse of what a screener currently flags, not a graded prediction. Check Alpha / Buy Recs for the canonical, regime-aware view." />
        </div>

        {/* Category cards row */}
        <div className="flex-shrink-0 px-5 py-3 border-b border-slate-800/50">
          <div className="grid grid-cols-6 xl:grid-cols-9 gap-2">
            {topCats.slice(0, 9).map(cat => (
              <CategoryCard
                key={`${cat.category}-${cat.subcategory}`}
                cat={cat}
                active={filterCategory === cat.category}
                onClick={() => setFilterCategory(filterCategory === cat.category ? '' : cat.category)}
              />
            ))}
          </div>
        </div>

        {/* Filter row */}
        <div className="flex items-center gap-2 px-5 py-2 border-b border-slate-800/40 flex-shrink-0">
          <span className="text-[10px] text-slate-500">Tier:</span>
          {['', ...TIERS].map(t => (
            <button
              key={t || 'all'}
              onClick={() => setFilterTier(t)}
              className={cn(
                'text-[10px]',
                filterTier === t
                  ? 'v1-btn-primary'
                  : 'v1-btn-secondary'
              )}
            >{t || 'All'}</button>
          ))}
          <div className="ml-2 flex items-center gap-1">
            <span className="text-[10px] text-slate-500">Source:</span>
            {['', ...SOURCES].map(s => (
              <button
                key={s || 'all'}
                onClick={() => setFilterSource(s)}
                className={cn(
                  'text-[10px] px-2 py-0.5 rounded-full transition-colors',
                  filterSource === s
                    ? 'bg-indigo-600 text-white'
                    : 'bg-slate-800 text-slate-400 hover:text-slate-200'
                )}
              >{s || 'All'}</button>
            ))}
          </div>
          {(filterTier || filterCategory || filterSource) && (
            <button
              onClick={() => { setFilterTier(''); setFilterCategory(''); setFilterSource(''); }}
              className="text-[10px] text-rose-400 hover:text-rose-300 ml-auto"
            >Clear filters</button>
          )}
        </div>

        {/* Table */}
        <div className="flex-1 overflow-auto">
          {isLoading ? (
            <div className="flex items-center justify-center h-32 text-slate-500 text-sm">Loading screeners…</div>
          ) : rows.length === 0 ? (
            <div className="flex items-center justify-center h-32 text-slate-500 text-sm">No screeners match filters</div>
          ) : (
            <table className="w-full text-xs">
              <thead className="sticky top-0 bg-slate-900/95 backdrop-blur z-10">
                <tr className="text-[10px] text-slate-500 border-b border-slate-800/50">
                  <th className="px-3 py-2 text-left">Screener</th>
                  <th className="px-3 py-2 text-left">Tier</th>
                  <th
                    className="px-3 py-2 text-right cursor-pointer hover:text-slate-300 select-none"
                    onClick={() => setSortAsc(!sortAsc)}
                  >
                    Win Rate {sortAsc ? <ChevronUp className="inline w-3 h-3" /> : <ChevronDown className="inline w-3 h-3" />}
                  </th>
                  <th className="px-3 py-2 text-right">Score</th>
                  <th className="px-3 py-2 text-right">Signals</th>
                  <th className="px-3 py-2 text-left">Category</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {sorted.map((row: any) => (
                  <ScreenerRow
                    key={row.screener_id}
                    row={row}
                    selected={selectedId === row.screener_id}
                    onClick={() => setSelectedId(selectedId === row.screener_id ? null : row.screener_id)}
                  />
                ))}
              </tbody>
            </table>
          )}
        </div>
      </div>

      {/* Detail panel */}
      {selectedId && (
        <div className="w-72 xl:w-80 border-l border-slate-800/50 flex flex-col flex-shrink-0 overflow-hidden">
          <div className="flex items-center justify-between px-4 py-2.5 border-b border-slate-800/50 flex-shrink-0">
            <span className="text-[11px] font-semibold text-slate-400">Screener Detail</span>
            <button onClick={() => setSelectedId(null)} className="text-slate-500 hover:text-slate-300 text-xs">✕</button>
          </div>
          <div className="flex-1 overflow-y-auto">
            <ScreenerDetail screenerId={selectedId} />
          </div>
        </div>
      )}
    </div>
  );
}

export default ScreenerIntelligencePage;
