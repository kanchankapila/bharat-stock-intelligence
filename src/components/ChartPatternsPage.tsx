import React, { useCallback, useEffect, useMemo, useState } from 'react';
import {
  ArrowDownRight, ArrowUpRight, Calendar, Clock, Minus, RefreshCw, Search,
  Target, TrendingDown, TrendingUp, ImageOff,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { formatNumber, formatPct } from '../lib/format';
import { formatIST } from '../lib/timeFormat';
import {
  CHART_PATTERN_PAGE_SIZE, fetchChartPatternsPage,
  type ChartPatternsPageData, type ParsedChartPattern,
} from '../lib/chartPatterns';

type StatusFilter = 'all' | 'active' | 'closed';
type DirectionFilter = 'all' | 'buy' | 'sell';

interface ChartPatternsPageProps {
  onSelectStock?: (symbol: string) => void;
}

function StatCell({ label, value, tone }: { label: string; value: string; tone?: 'up' | 'down' }) {
  return (
    <div className="rounded-lg bg-slate-950/40 border border-white/5 px-2 py-1.5">
      <div className="text-[9px] font-semibold uppercase tracking-widest text-slate-500">{label}</div>
      <div className={cn(
        'text-sm font-bold font-data',
        tone === 'up' && 'text-emerald-400',
        tone === 'down' && 'text-rose-400',
        !tone && 'text-slate-200',
      )}>{value}</div>
    </div>
  );
}

function FilterChip({ active, onClick, children }: {
  active: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <button
      onClick={onClick}
      className={cn(
        'px-3 py-1.5 rounded-lg text-[11px] font-semibold border transition-colors whitespace-nowrap',
        active
          ? 'bg-indigo-500/20 border-indigo-500/40 text-white'
          : 'bg-slate-800/30 border-white/5 text-slate-400 hover:text-slate-200',
      )}
    >
      {children}
    </button>
  );
}

function PatternCard({ pattern, onSelectStock }: {
  pattern: ParsedChartPattern;
  onSelectStock?: (symbol: string) => void;
}) {
  const { instrument } = pattern;
  const instrumentLabel = instrument.name
    ?? (instrument.code ? `${instrument.kind === 'index' ? 'Index ' : ''}${instrument.code}` : 'Instrument not identified');
  return (
    <article
      className={cn(
        'v1-card flex flex-col overflow-hidden',
        pattern.direction === 'buy' && 'v1-card-up',
        pattern.direction === 'sell' && 'v1-card-down',
        pattern.direction === null && 'v1-card-neutral',
      )}
    >
      <div className="relative aspect-[2/1] bg-slate-950/60">
        {pattern.imageUrl ? (
          <img
            src={pattern.imageUrl}
            alt={`${pattern.patternName} chart${instrument.name ? ` — ${instrument.name}` : ''}`}
            loading="lazy"
            className="w-full h-full object-cover"
            onError={e => { (e.currentTarget as HTMLImageElement).style.display = 'none'; }}
          />
        ) : (
          <div className="w-full h-full flex flex-col items-center justify-center gap-1 text-slate-600">
            <ImageOff className="w-5 h-5" />
            <span className="text-[10px] uppercase tracking-widest">No chart image</span>
          </div>
        )}
        <div className="absolute top-2 left-2 flex items-center gap-1.5">
          <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-black uppercase tracking-wider glass-strong',
            pattern.direction === 'buy' && 'text-emerald-400',
            pattern.direction === 'sell' && 'text-rose-400',
            pattern.direction === null && 'text-slate-400',
          )}>
            {pattern.direction === 'buy' && <ArrowUpRight className="w-3 h-3" />}
            {pattern.direction === 'sell' && <ArrowDownRight className="w-3 h-3" />}
            {pattern.direction === null && <Minus className="w-3 h-3" />}
            {pattern.direction ?? 'n/a'}
          </span>
          <span className={cn(
            'inline-flex items-center gap-1 px-2 py-0.5 rounded-md text-[10px] font-bold uppercase tracking-wider glass-strong',
            pattern.status === 'Active' ? 'text-sky-300' : 'text-slate-400',
          )}>
            {pattern.status === 'Active' && <span className="w-1.5 h-1.5 rounded-full bg-sky-400 animate-pulse" />}
            {pattern.status}
          </span>
        </div>
      </div>

      <div className="flex flex-col gap-3 p-4 flex-1">
        <div className="min-w-0">
          <h3 className="text-base font-bold text-white font-display leading-tight">{pattern.patternName}</h3>
          <div className="mt-1 flex items-center gap-2 flex-wrap">
            {instrument.symbol && onSelectStock ? (
              <button
                onClick={() => onSelectStock(instrument.symbol!)}
                className="inline-flex items-center gap-1.5 px-2 py-0.5 rounded-md text-[11px] font-bold text-indigo-300 bg-indigo-500/15 border border-indigo-500/30 hover:bg-indigo-500/25 transition-colors"
                title={`Open ${instrument.name ?? instrument.symbol}`}
              >
                {instrument.name ?? instrument.symbol}
                <span className="text-[10px] font-semibold text-indigo-400/80">{instrument.symbol}</span>
              </button>
            ) : (
              <span className="inline-flex items-center px-2 py-0.5 rounded-md text-[11px] font-semibold text-slate-400 bg-slate-800/50 border border-white/5">
                {instrumentLabel}
              </span>
            )}
            {pattern.timeframe && (
              <span className="inline-flex items-center gap-1 text-[11px] text-slate-500">
                <Clock className="w-3 h-3" />{pattern.timeframe}
              </span>
            )}
          </div>
          {pattern.comment && (
            <p className="mt-1.5 text-xs text-slate-400">{pattern.comment}</p>
          )}
        </div>

        <div className="grid grid-cols-3 gap-2">
          <StatCell label="Entry" value={formatNumber(pattern.entryPrice)} />
          <StatCell label="CMP" value={formatNumber(pattern.cmp)} />
          <StatCell label="Target" value={formatNumber(pattern.targetPrice)} />
          <StatCell label="Tgt return" value={formatPct(pattern.targetReturnPct, 2, true)} tone="up" />
          <StatCell label="Stop-loss" value={formatNumber(pattern.stoplossPrice)} />
          <StatCell label="SL risk" value={formatPct(pattern.stoplossPct, 2, true)} tone="down" />
        </div>

        {pattern.rationale && (
          <p className="text-xs text-slate-500 italic line-clamp-3">
            {pattern.latestAction === 'close' ? 'Closed: ' : ''}
            {pattern.rationale}
          </p>
        )}

        <div className="mt-auto pt-2 border-t border-white/5 flex items-center justify-between gap-2 flex-wrap">
          <span className="inline-flex items-center gap-1 text-[10px] text-slate-500">
            <Calendar className="w-3 h-3" />{formatIST(pattern.createdAtMs)}
          </span>
          <span className="inline-flex items-center gap-2 text-[10px] text-slate-500">
            {pattern.validTill && (
              <span className="inline-flex items-center gap-1">
                <Target className="w-3 h-3" />valid till {pattern.validTill}
              </span>
            )}
            {pattern.timelineCount > 1 && <span>{pattern.timelineCount} updates</span>}
          </span>
        </div>
      </div>
    </article>
  );
}

export function ChartPatternsPage({ onSelectStock }: ChartPatternsPageProps) {
  const [page, setPage] = useState<ChartPatternsPageData>({ patterns: [], sourceTotal: null });
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [fetchedAtMs, setFetchedAtMs] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<StatusFilter>('active');
  const [directionFilter, setDirectionFilter] = useState<DirectionFilter>('all');
  const [search, setSearch] = useState('');

  // Fetch every page the source reports (list.total) sequentially so the full list renders with
  // no Load-more step; setPage on each page lets cards appear progressively. The guard bounds
  // the loop if the source's total is missing or lying.
  const load = useCallback(async () => {
    setIsLoading(true);
    setError(null);
    setPage({ patterns: [], sourceTotal: null });
    try {
      let all: ParsedChartPattern[] = [];
      let sourceTotal: number | null = null;
      for (let start = 0, guard = 0; guard < 100; guard++, start += CHART_PATTERN_PAGE_SIZE) {
        const data = await fetchChartPatternsPage(start);
        sourceTotal = data.sourceTotal ?? sourceTotal;
        const seen = new Set(all.map(p => p.id));
        all = [...all, ...data.patterns.filter(p => !seen.has(p.id))];
        setPage({ patterns: all, sourceTotal });
        if (data.patterns.length === 0 || (sourceTotal !== null && all.length >= sourceTotal)) break;
      }
      setFetchedAtMs(Date.now());
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Failed to load chart patterns.');
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    load();
  }, [load]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    return page.patterns.filter(p => {
      if (statusFilter !== 'all' && p.status.toLowerCase() !== statusFilter) return false;
      if (directionFilter !== 'all' && p.direction !== directionFilter) return false;
      if (!q) return true;
      const hay = [
        p.patternName, p.comment, p.instrument.name, p.instrument.symbol, p.instrument.code,
        p.rationale,
      ].filter(Boolean).join(' ').toLowerCase();
      return hay.includes(q);
    });
  }, [page.patterns, statusFilter, directionFilter, search]);

  const activeCount = page.patterns.filter(p => p.status === 'Active').length;
  const closedCount = page.patterns.length - activeCount;

  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <div className="flex items-center gap-3 flex-wrap">
          <span className="v1-data-label">
            {isLoading
              ? <span className="text-indigo-300">loading {page.patterns.length} of {page.sourceTotal ?? '…'}…</span>
              : <>{page.patterns.length} patterns</>}
            <span className="text-slate-600"> · </span>
            <span className="text-emerald-400">{activeCount} active</span>
            <span className="text-slate-600"> · </span>
            <span className="text-slate-400">{closedCount} closed</span>
          </span>
          {fetchedAtMs && (
            <span className="text-[10px] text-slate-500">as of {formatIST(fetchedAtMs)}</span>
          )}
        </div>
        <div className="flex items-center gap-2 flex-wrap">
          <div className="relative">
            <Search className="w-3.5 h-3.5 text-slate-500 absolute left-2.5 top-1/2 -translate-y-1/2" />
            <input
              value={search}
              onChange={e => setSearch(e.target.value)}
              placeholder="Search pattern / stock…"
              className="v1-input !w-52 !py-1.5 pl-8 text-xs"
            />
          </div>
          <button
            onClick={() => load()}
            disabled={isLoading}
            className="v1-btn-icon"
            title="Refresh"
            aria-label="Refresh chart patterns"
          >
            <RefreshCw className={cn('w-4 h-4', isLoading && 'animate-spin')} />
          </button>
        </div>
      </div>

      <div className="flex items-center gap-2 flex-wrap">
        <FilterChip active={statusFilter === 'all'} onClick={() => setStatusFilter('all')}>All</FilterChip>
        <FilterChip active={statusFilter === 'active'} onClick={() => setStatusFilter('active')}>Active</FilterChip>
        <FilterChip active={statusFilter === 'closed'} onClick={() => setStatusFilter('closed')}>Closed</FilterChip>
        <span className="w-px h-5 bg-white/10 mx-1" />
        <FilterChip active={directionFilter === 'all'} onClick={() => setDirectionFilter('all')}>Any side</FilterChip>
        <FilterChip active={directionFilter === 'buy'} onClick={() => setDirectionFilter('buy')}>
          <span className="inline-flex items-center gap-1 text-emerald-400"><TrendingUp className="w-3 h-3" />Buy</span>
        </FilterChip>
        <FilterChip active={directionFilter === 'sell'} onClick={() => setDirectionFilter('sell')}>
          <span className="inline-flex items-center gap-1 text-rose-400"><TrendingDown className="w-3 h-3" />Sell</span>
        </FilterChip>
      </div>

      {error && (
        <div className="flex items-center justify-between gap-3 rounded-[10px] border border-rose-500/30 bg-rose-500/10 px-4 py-3">
          <span className="text-sm text-rose-300">{error}</span>
          <button onClick={() => load()} className="v1-btn-secondary !py-1.5 text-xs">Retry</button>
        </div>
      )}

      {(isLoading && page.patterns.length === 0) ? (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {Array.from({ length: 6 }).map((_, i) => (
            <div key={i} className="v1-card overflow-hidden animate-pulse">
              <div className="aspect-[2/1] bg-slate-800/40" />
              <div className="p-4 space-y-3">
                <div className="h-4 w-2/3 rounded bg-slate-800/60" />
                <div className="h-3 w-1/3 rounded bg-slate-800/60" />
                <div className="grid grid-cols-3 gap-2">
                  {Array.from({ length: 6 }).map((_, j) => (
                    <div key={j} className="h-10 rounded-lg bg-slate-800/40" />
                  ))}
                </div>
              </div>
            </div>
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="v1-empty">
          <TrendingUp className="v1-empty-icon" />
          <div className="v1-empty-title">No chart patterns match</div>
          <div className="v1-empty-text">
            {page.patterns.length === 0
              ? 'Moneycontrol returned no technical picks right now — try refreshing.'
              : 'Try clearing the search or filters.'}
          </div>
        </div>
      ) : (
        <>
          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
            {filtered.map(pattern => (
              <PatternCard key={pattern.id} pattern={pattern} onSelectStock={onSelectStock} />
            ))}
          </div>
          <p className="text-center text-[10px] text-slate-600">
            Source: Moneycontrol MC Pro technical picks · patterns are the provider's analyst-drawn
            chart setups, not this platform's own recommendations
          </p>
        </>
      )}
    </div>
  );
}

export default ChartPatternsPage;
