import React, { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import {
  TrendingUp, BarChart3, Zap, Shield, Star,
  RefreshCw, ChevronUp, ChevronDown, Activity, Target,
  AlertCircle, CheckCircle2, Loader2, SlidersHorizontal, X
} from 'lucide-react';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';
import { ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip } from 'recharts';

type Strategy = 'composite' | 'momentum' | 'quality' | 'value' | 'confluence' | 'investment_picks';

interface Filters {
  minSharpe?: number;
  maxVol?: number;
  maxDrawdown?: number;
  aboveSma200?: boolean;
  maxPE?: number;
  minROE?: number;
  maxDebtToEquity?: number;
  minPiotroski?: number;
  minMarketCapCr?: number;
}

interface StrategyStock {
  symbol: string;
  name?: string;
  composite_class: string;
  rank_composite: number;
  rank_momentum: number;
  rank_quality: number;
  rank_value: number;
  rank_confluence?: number;
  return_12m?: number;
  return_6m?: number;
  return_3m?: number;
  sharpe_ratio?: number;
  annualized_vol?: number;
  max_drawdown_1y?: number;
  above_sma200?: number;
  trailing_pe?: number;
  forward_pe?: number;
  debt_to_equity?: number;
  return_on_equity?: number;
  piotroski_f_score?: number;
  bullish_screener_count?: number;
  bearish_screener_count?: number;
  screener_net_score?: number;
}

const CLASS_COLORS: Record<string, { bg: string; text: string; dot: string; border: string; pill: string }> = {
  'Strong Buy': { bg: 'bg-emerald-500/10', text: 'text-emerald-400', dot: 'bg-emerald-400', border: 'border-emerald-500/30', pill: 'v1-stat-pill-up' },
  'Buy':        { bg: 'bg-teal-500/10',    text: 'text-teal-400',    dot: 'bg-teal-400',    border: 'border-teal-500/30',    pill: 'v1-stat-pill-up' },
  'Hold':       { bg: 'bg-amber-500/10',   text: 'text-amber-400',   dot: 'bg-amber-400',   border: 'border-amber-500/30',   pill: 'v1-stat-pill-neutral' },
  'Avoid':      { bg: 'bg-orange-500/10',  text: 'text-orange-400',  dot: 'bg-orange-400',  border: 'border-orange-500/30',  pill: 'v1-stat-pill-down' },
  'Sell':       { bg: 'bg-rose-500/10',    text: 'text-rose-400',    dot: 'bg-rose-400',    border: 'border-rose-500/30',    pill: 'v1-stat-pill-down' },
};

const STRATEGY_CHART_COLOR: Record<string, string> = {
  indigo: '#6366f1', emerald: '#10b981', sky: '#0ea5e9', amber: '#f59e0b', violet: '#8b5cf6',
};

const STRATEGIES: { id: Strategy; label: string; icon: React.ElementType; desc: string }[] = [
  { id: 'composite', label: 'Composite',  icon: Star,      desc: 'Best overall: momentum + quality + value + screener confluence' },
  { id: 'momentum',  label: 'Momentum',   icon: TrendingUp, desc: '12M/6M/3M price return weighted, above 200-SMA' },
  { id: 'quality',   label: 'Quality',    icon: Shield,    desc: 'Sharpe ratio, ROE, operating margins, Piotroski F-Score' },
  { id: 'value',     label: 'Value',      icon: BarChart3, desc: 'Trailing/forward PE, earnings yield, D/E ratio' },
  { id: 'confluence',label: 'Confluence', icon: Zap,       desc: 'Screener breadth across Trendlyne + MoneyControl' },
  { id: 'investment_picks', label: 'Best Buys', icon: Star, desc: 'Highest conviction buys: positive trend + high quality + high multi-screener confluence' },
];

function ScoreBar({ value, color = 'indigo' }: { value: number; color?: string }) {
  const colorMap: Record<string, string> = {
    indigo: 'bg-indigo-500',
    emerald: 'bg-emerald-500',
    amber: 'bg-amber-500',
    sky: 'bg-sky-500',
    violet: 'bg-violet-500',
  };
  return (
    <div className="flex items-center gap-2">
      <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
        <div className={cn('h-full rounded-full', colorMap[color] || 'bg-indigo-500')} style={{ width: `${Math.max(0, Math.min(100, value))}%` }} />
      </div>
      <span className="text-xs font-bold tabular-nums text-slate-300 w-8 text-right">{value.toFixed(0)}</span>
    </div>
  );
}

function ClassBadge({ cls }: { cls: string }) {
  const c = CLASS_COLORS[cls] ?? CLASS_COLORS['Hold'];
  return (
    <span className={cn('v1-badge text-[10px] font-display uppercase tracking-wider', c.bg, c.border, c.text)}>
      <span className={cn('w-1.5 h-1.5 rounded-full', c.dot)} />
      {cls}
    </span>
  );
}

function fmt(v?: number | null, dec = 1, suffix = '') {
  if (v == null || isNaN(v)) return <span className="text-slate-600">—</span>;
  const s = v.toFixed(dec) + suffix;
  return <span>{s}</span>;
}

function fmtPct(v?: number | null) {
  if (v == null || isNaN(v)) return <span className="text-slate-600">—</span>;
  const cls = v >= 0 ? 'text-emerald-400' : 'text-rose-400';
  return <span className={cls}>{v >= 0 ? '+' : ''}{v.toFixed(1)}%</span>;
}

interface SortState { key: string; dir: 'asc' | 'desc' }

function SortableHeader({ label, sortKey, sort, onSort }: { label: string; sortKey: string; sort: SortState; onSort: (k: string) => void }) {
  const active = sort.key === sortKey;
  return (
    <th
      className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-500 cursor-pointer hover:text-slate-300 select-none whitespace-nowrap"
      onClick={() => onSort(sortKey)}
    >
      <span className="flex items-center gap-1">
        {label}
        {active ? (sort.dir === 'desc' ? <ChevronDown className="w-3 h-3" /> : <ChevronUp className="w-3 h-3" />) : null}
      </span>
    </th>
  );
}

function FilterPanel({ filters, onChange, onClose }: { filters: Filters; onChange: (f: Filters) => void; onClose: () => void }) {
  const [local, setLocal] = useState<Filters>(filters);

  function apply() { onChange(local); onClose(); }
  function reset() { setLocal({}); onChange({}); onClose(); }

  function num(key: keyof Filters, label: string, placeholder: string, min?: number, max?: number) {
    return (
      <div className="flex flex-col gap-1">
        <label className="text-[10px] font-bold font-display uppercase tracking-wider text-slate-400">{label}</label>
        <input
          type="number"
          placeholder={placeholder}
          value={(local[key] as number | undefined) ?? ''}
          min={min}
          max={max}
          step="0.1"
          onChange={e => setLocal(p => ({ ...p, [key]: e.target.value === '' ? undefined : parseFloat(e.target.value) }))}
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder:text-slate-600 focus:outline-none focus:ring-1 focus:ring-indigo-500/40 w-full"
        />
      </div>
    );
  }

  return (
    <div className="bg-slate-900 border border-slate-700 rounded-2xl p-4 space-y-4 w-72 shadow-2xl">
      <div className="flex items-center justify-between">
        <span className="text-sm font-bold text-white">Filters</span>
        <button onClick={onClose} className="v1-btn-ghost"><X className="w-4 h-4" /></button>
      </div>
      <div className="grid grid-cols-2 gap-3">
        {num('minSharpe', 'Min Sharpe', '0.5', 0)}
        {num('maxVol', 'Max Vol %', '40', 0, 200)}
        {num('maxDrawdown', 'Max Drawdown %', '30', 0, 100)}
        {num('maxPE', 'Max Trailing PE', '40', 0)}
        {num('minROE', 'Min ROE %', '10', 0)}
        {num('maxDebtToEquity', 'Max D/E', '100', 0)}
        {num('minPiotroski', 'Min Piotroski', '5', 0, 9)}
        {num('minMarketCapCr', 'Min MCap (Cr)', '500', 0)}
      </div>
      <div className="flex items-center gap-2">
        <input
          id="sma200"
          type="checkbox"
          checked={local.aboveSma200 ?? false}
          onChange={e => setLocal(p => ({ ...p, aboveSma200: e.target.checked || undefined }))}
          className="rounded"
        />
        <label htmlFor="sma200" className="text-sm text-slate-300">Above 200-day SMA only</label>
      </div>
      <div className="flex gap-2">
        <button onClick={apply} className="v1-btn-primary flex-1">Apply</button>
        <button onClick={reset} className="v1-btn-secondary flex-1">Reset</button>
      </div>
    </div>
  );
}


export function StrategyIntelligence({ onSelectStock }: { onSelectStock: (symbol: string) => void }) {
  const [strategy, setStrategy]     = useState<Strategy>('composite');
  const [limit, setLimit]           = useState(50);
  const [filters, setFilters]       = useState<Filters>({});
  const [showFilters, setShowFilters] = useState(false);
  const [sort, setSort]             = useState<SortState>({ key: 'rank_composite', dir: 'desc' });

  const { data: status } = trpc.getQuantScoringStatus.useQuery(undefined, { refetchInterval: 30_000 });
  const { data: raw, isLoading, error, refetch } = trpc.getStrategyStocks.useQuery(
    { strategy, limit, filters: Object.keys(filters).length > 0 ? filters : undefined },
    { refetchInterval: 5 * 60_000, staleTime: 4 * 60_000, refetchOnWindowFocus: false }
  );

  const stocks: StrategyStock[] = (raw as StrategyStock[] | undefined) ?? [];

  const sorted = useMemo(() => {
    const s = [...stocks];
    s.sort((a, b) => {
      const av = ((a as unknown) as Record<string, number | undefined>)[sort.key] ?? 0;
      const bv = ((b as unknown) as Record<string, number | undefined>)[sort.key] ?? 0;
      return sort.dir === 'desc' ? bv - av : av - bv;
    });
    return s;
  }, [stocks, sort.key, sort.dir]);

  // Score-distribution histogram for the active strategy's ranking key -- deciles 0-100.
  const scoreHistogram = useMemo(() => {
    const buckets = ['0-20', '20-40', '40-60', '60-80', '80-100'];
    const counts = new Array(buckets.length).fill(0);
    stocks.forEach((s) => {
      const v = ((s as unknown) as Record<string, number | undefined>)[sort.key];
      if (v == null || Number.isNaN(v)) return;
      const idx = v < 20 ? 0 : v < 40 ? 1 : v < 60 ? 2 : v < 80 ? 3 : 4;
      counts[idx]++;
    });
    return buckets.map((bucket, i) => ({ bucket, count: counts[i] }));
  }, [stocks, sort.key]);

  function toggleSort(key: string) {
    setSort(p => p.key === key ? { key, dir: p.dir === 'desc' ? 'asc' : 'desc' } : { key, dir: 'desc' });
  }

  const activeFiltersCount = Object.values(filters).filter(v => v !== undefined && v !== false).length;

  const stratInfo = STRATEGIES.find(s => s.id === strategy)!;

  const byClass = (status as { summary?: { byClass?: Record<string, number> } } | undefined)?.summary?.byClass ?? {};
  const total   = (status as { summary?: { totalScored?: number } } | undefined)?.summary?.totalScored ?? 0;

  const scoreColByStrategy: Record<Strategy, { key: string; label: string; color: string }> = {
    composite:  { key: 'rank_composite', label: 'Composite',  color: 'indigo' },
    momentum:   { key: 'rank_momentum',  label: 'Momentum',   color: 'emerald' },
    quality:    { key: 'rank_quality',   label: 'Quality',    color: 'sky' },
    value:      { key: 'rank_value',     label: 'Value',      color: 'amber' },
    confluence: { key: 'rank_confluence',label: 'Confluence', color: 'violet' },
    investment_picks: { key: 'strategy_rank', label: 'Buy Score', color: 'emerald' },
  };
  const { key: scoreKey, label: scoreLabel, color: scoreColor } = scoreColByStrategy[strategy];

  return (
    <div className="p-4 md:p-6 space-y-5">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-start md:justify-between gap-4">
        <div>
          <h2 className="v1-title-page flex items-center gap-2">
            <Target className="w-6 h-6 text-indigo-400" />
            Strategy Intelligence
          </h2>
          <p className="text-slate-500 text-sm mt-1">Quantitative scoring across {total.toLocaleString()} NSE stocks</p>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowFilters(p => !p)}
            className={cn(
              'flex items-center gap-2 px-3 py-1.5 rounded-xl text-sm font-bold border transition-colors',
              showFilters || activeFiltersCount > 0
                ? 'bg-indigo-600/20 border-indigo-500/40 text-indigo-300'
                : 'bg-slate-800 border-slate-700 text-slate-400 hover:text-white'
            )}
          >
            <SlidersHorizontal className="w-4 h-4" />
            Filters {activeFiltersCount > 0 && <span className="bg-indigo-500 text-white rounded-full w-4 h-4 flex items-center justify-center text-[10px]">{activeFiltersCount}</span>}
          </button>
          <button onClick={() => refetch()} className="v1-btn-icon">
            <RefreshCw className="w-4 h-4" />
          </button>
        </div>
      </div>

      <LegacyScoreBanner note="Ranked from the quant scoring engine (quant_scores) -- computed separately from the unified cross-engine model -- check Alpha / Buy Recs for the canonical, regime-aware view of the same stocks." />

      {/* Summary strip */}
      <div className="grid grid-cols-2 md:grid-cols-5 gap-3">
        {(['Strong Buy','Buy','Hold','Avoid','Sell'] as const).map(cls => {
          const c = CLASS_COLORS[cls];
          return (
            <div key={cls} className={cn('v1-stat-pill', c.pill)}>
              <span className="v1-data-label">{cls}</span>
              <span className={cn('v1-data-value tabular-nums', c.text)}>{byClass[cls] ?? 0}</span>
            </div>
          );
        })}
      </div>

      {/* Score distribution for the active ranking */}
      <div className="v1-card p-3">
        <div className="v1-title-card mb-1">{scoreLabel} score distribution</div>
        <ResponsiveContainer width="100%" height={100}>
          <BarChart data={scoreHistogram} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
            <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
            <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
            <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
            <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }} />
            <Bar dataKey="count" fill={STRATEGY_CHART_COLOR[scoreColor] ?? '#6366f1'} radius={[3, 3, 0, 0]} />
          </BarChart>
        </ResponsiveContainer>
      </div>

      {/* Strategy selector */}
      <div className="flex flex-wrap gap-2">
        {STRATEGIES.map(s => {
          const Icon = s.icon;
          return (
            <button
              key={s.id}
              onClick={() => { setStrategy(s.id); setSort({ key: `rank_${s.id}`, dir: 'desc' }); }}
              className={cn(
                'flex items-center gap-2 px-3 py-2 rounded-xl text-sm font-bold border transition-all',
                strategy === s.id
                  ? 'bg-indigo-600 border-indigo-500 text-white shadow-[0_0_12px_rgba(99,102,241,0.3)]'
                  : 'bg-slate-900 border-slate-700 text-slate-400 hover:text-white hover:border-slate-500'
              )}
            >
              <Icon className="w-4 h-4" />
              {s.label}
            </button>
          );
        })}
        <div className="ml-auto flex items-center gap-2 text-sm text-slate-500">
          <span className="hidden md:block">{stratInfo.desc}</span>
        </div>
      </div>

      {/* Filter panel (inline) */}
      {showFilters && (
        <FilterPanel filters={filters} onChange={setFilters} onClose={() => setShowFilters(false)} />
      )}

      {/* Error / Loading states */}
      {error && (
        <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex items-center gap-3">
          <AlertCircle className="w-5 h-5 text-rose-400 shrink-0" />
          <div>
            <p className="text-sm font-bold text-rose-400">Failed to load strategy data</p>
            <p className="text-xs text-slate-500 mt-0.5">{(error as { message?: string })?.message ?? String(error)}</p>
          </div>
        </div>
      )}

      {isLoading && !stocks.length && (
        <div className="flex items-center justify-center py-24 gap-3 text-slate-500">
          <Loader2 className="w-5 h-5 animate-spin" />
          <span className="text-sm">Loading strategy data…</span>
        </div>
      )}

      {/* Scores not computed yet */}
      {!isLoading && !error && total === 0 && (
        <div className="flex flex-col items-center py-24 gap-4 text-center">
          <Activity className="w-12 h-12 text-slate-700" />
          <p className="text-white font-bold">Quant scoring not yet computed</p>
          <p className="text-slate-500 text-sm">The engine will run automatically on server start. Check back in a few minutes.</p>
        </div>
      )}

      {/* Main table */}
      {sorted.length > 0 && (
        <div className="v1-card overflow-x-auto">
          <table className="w-full text-sm">
            <thead className="border-b border-slate-800">
              <tr>
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-500 w-8">#</th>
                <SortableHeader label="Symbol" sortKey="symbol" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Class" sortKey="composite_class" sort={sort} onSort={toggleSort} />
                <SortableHeader label={scoreLabel} sortKey={scoreKey} sort={sort} onSort={toggleSort} />
                <SortableHeader label="Comp" sortKey="rank_composite" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Mom" sortKey="rank_momentum" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Quality" sortKey="rank_quality" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Value" sortKey="rank_value" sort={sort} onSort={toggleSort} />
                <SortableHeader label="12M Ret" sortKey="return_12m" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Sharpe" sortKey="sharpe_ratio" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Vol" sortKey="annualized_vol" sort={sort} onSort={toggleSort} />
                <SortableHeader label="MaxDD" sortKey="max_drawdown_1y" sort={sort} onSort={toggleSort} />
                <SortableHeader label="PE" sortKey="trailing_pe" sort={sort} onSort={toggleSort} />
                <SortableHeader label="D/E" sortKey="debt_to_equity" sort={sort} onSort={toggleSort} />
                <SortableHeader label="ROE" sortKey="return_on_equity" sort={sort} onSort={toggleSort} />
                <SortableHeader label="F-Sc" sortKey="piotroski_f_score" sort={sort} onSort={toggleSort} />
                <SortableHeader label="Bull" sortKey="bullish_screener_count" sort={sort} onSort={toggleSort} />
                <th className="text-left py-2 px-3 text-[10px] font-bold font-display uppercase tracking-wider text-slate-500">SMA</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-800/50">
              {sorted.map((s, i) => {
                const score = ((s as unknown) as Record<string, number | undefined>)[scoreKey] ?? 0;
                return (
                  <tr
                    key={s.symbol}
                    className="hover:bg-white/[0.02] cursor-pointer transition-colors"
                    onClick={() => onSelectStock(s.symbol)}
                  >
                    <td className="py-2 px-3 text-slate-600 text-xs">{i + 1}</td>
                    <td className="py-2 px-3">
                      <div className="font-bold text-white">{s.symbol}</div>
                      {s.name && <div className="text-[10px] text-slate-500 truncate max-w-[120px]">{s.name}</div>}
                    </td>
                    <td className="py-2 px-3"><ClassBadge cls={s.composite_class} /></td>
                    <td className="py-2 px-3 w-32"><ScoreBar value={score} color={scoreColor} /></td>
                    <td className="py-2 px-3 text-slate-300 tabular-nums">{s.rank_composite?.toFixed(1)}</td>
                    <td className="py-2 px-3 text-slate-300 tabular-nums">{s.rank_momentum?.toFixed(1)}</td>
                    <td className="py-2 px-3 text-slate-300 tabular-nums">{s.rank_quality?.toFixed(1)}</td>
                    <td className="py-2 px-3 text-slate-300 tabular-nums">{s.rank_value?.toFixed(1)}</td>
                    <td className="py-2 px-3">{fmtPct(s.return_12m)}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.sharpe_ratio, 2)}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.annualized_vol, 1, '%')}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.max_drawdown_1y, 1, '%')}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.trailing_pe, 1, 'x')}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.debt_to_equity, 1)}</td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{fmt(s.return_on_equity, 1, '%')}</td>
                    <td className="py-2 px-3">
                      <span className={cn(
                        'font-bold tabular-nums',
                        s.piotroski_f_score == null ? 'text-slate-500' :
                        s.piotroski_f_score >= 7 ? 'text-emerald-400' :
                        s.piotroski_f_score >= 4 ? 'text-amber-400' : 'text-rose-400'
                      )}>
                        {s.piotroski_f_score ?? '—'}
                      </span>
                    </td>
                    <td className="py-2 px-3 tabular-nums text-slate-300">{s.bullish_screener_count ?? '—'}</td>
                    <td className="py-2 px-3">
                      {s.above_sma200
                        ? <CheckCircle2 className="w-4 h-4 text-emerald-400" />
                        : <span className="text-slate-700">—</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}

      {/* Load more */}
      {sorted.length >= limit && (
        <div className="flex justify-center">
          <button onClick={() => setLimit(l => l + 50)} className="v1-btn-secondary">
            Load more ({limit} shown)
          </button>
        </div>
      )}

      {/* Legend / methodology note */}
      <div className="v1-card p-4">
        <p className="v1-title-card mb-2">Scoring Methodology</p>
        <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px] text-slate-500">
          <span><span className="text-indigo-400 font-bold">Composite</span> = 30% Momentum + 25% Quality + 25% Value + 20% Confluence</span>
          <span><span className="text-emerald-400 font-bold">Momentum</span> = 50%×12M + 30%×6M + 20%×3M return percentile rank</span>
          <span><span className="text-sky-400 font-bold">Quality</span> = Sharpe + ROE + Operating Margins + Piotroski F-Score</span>
          <span><span className="text-amber-400 font-bold">Value</span> = Inverse PE + Earnings Yield + D/E rank</span>
        </div>
      </div>
    </div>
  );
}
