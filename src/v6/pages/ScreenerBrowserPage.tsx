import React, { useMemo, useState } from 'react';
import { Search, Filter, Layers3, TrendingUp, TrendingDown, Minus, ChevronLeft, ChevronRight, ListFilter } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { LegacyScoreBanner } from '../../components/CanonicalSourceNote';
import { cn } from '../../lib/utils';

type SearchMode = 'screeners' | 'stocks';
type SourceFilter = 'all' | 'trendlyne' | 'moneycontrol' | 'etnow';
type TierFilter = 'ALL' | 'A' | 'B' | 'C' | 'D' | 'Unranked';
type Horizon = '5d' | '10d' | '20d' | '60d' | '120d';

const SOURCE_LABEL: Record<string, string> = {
  trendlyne: 'Trendlyne', moneycontrol: 'MoneyControl', etnow: 'ETnow',
  et_marketstats: 'ET Marketstats', ETnow: 'ETnow', MoneyControl: 'MoneyControl',
};

const SENTIMENT_STYLE: Record<string, string> = {
  bullish: 'bg-emerald-500/15 text-emerald-400 border-emerald-500/30',
  bearish: 'bg-rose-500/15 text-rose-400 border-rose-500/30',
  neutral: 'bg-slate-800/60 text-slate-400 border-slate-700/50',
};

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

// RETRACTED 2026-08-12 (see measurement.md's top banner) -- both factors read as significant
// before factor_backtest.py's exit-pricing bug was fixed; neither survives with the corrected
// harness. Kept as paper screens for visibility, not as validated edges (AF-20260818-37).
const FACTOR_META: Record<string, { title: string; scoreLabel: string; blurb: string }> = {
  value_book_to_price: {
    title: 'Book-to-Price Value Screen',
    scoreLabel: 'B/P',
    blurb: 'Fama-French HML book-to-market. +0.78%/mo excess, t=1.99 (post exit-pricing-bug fix) -- not significant. No factor in this harness currently clears significance; treat as a paper screen, not a validated edge.',
  },
  momentum_12_1: {
    title: '12-1 Momentum Paper Screen',
    scoreLabel: '12-1 Return',
    blurb: 'Twelve-month return skipping the last month. +0.53%/mo excess, t=1.10 (post exit-pricing-bug fix) -- not significant.',
  },
};

const FactorCard: React.FC<{
  snap: { factor: string; asOf?: string; validatedTopKMin?: number; picks: any[];
          entryStatus?: string; entrySession?: string | null };
  onSelectStock?: (symbol: string) => void;
}> = ({ snap, onSelectStock }) => {
  const meta = FACTOR_META[snap.factor] ?? { title: snap.factor, scoreLabel: 'Score', blurb: '' };
  // A list whose entry open has already traded is a record, not a trade. Say so instead of
  // showing an `asOf` that reads identically to a fresh one. Evaluated PER CARD: the two
  // factors have different asOf dates (value lags momentum, its vendor history settles
  // later), so one can be actionable while the other has expired.
  const expired = snap.entryStatus === 'entry_passed';
  return (
    <Card dense title={meta.title} icon={TrendingUp} action={
      <span className={`text-[10px] font-data ${expired ? 'text-slate-500' : 'text-amber-400'}`}>
        {expired ? 'EXPIRED' : 'PAPER TRADE'} · AS OF {snap.asOf}
      </span>
    }>
      {expired ? (
        <p className="text-[11px] text-rose-400 mb-3">
          Not actionable — the entry open for this list{snap.entrySession ? ` (${snap.entrySession})` : ''} has already traded. Shown as a record of the last generated signal; wait for the next refresh.
        </p>
      ) : (
        <p className="text-[11px] text-slate-400 mb-1">{meta.blurb} Entry is the next session's open.</p>
      )}
      <p className="text-[11px] text-amber-400/90 mb-3">
        Decaying: excess has fallen toward zero through 2025-26, and neither clears a
        multiple-testing bar across the 18 factors tested. Not the canonical Alpha score, and
        not a buy recommendation.
      </p>
      <div className={`overflow-x-auto ${expired ? 'opacity-50' : ''}`}>
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] text-slate-400 font-display uppercase tracking-wider border-b border-white/10">
            <th className="text-left py-2">Rank</th><th className="text-left py-2">Symbol</th>
            <th className="text-right py-2">{meta.scoreLabel}</th>
            <th className="text-right py-2">20D ADT</th><th className="text-right py-2">Close</th>
          </tr></thead>
          <tbody>{snap.picks.slice(0, 10).map((pick, index) => {
            const thin = pick.adt20 != null && pick.adt20 < 50_000_000;
            return (
              <tr key={pick.symbol} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                <td className="py-2 text-slate-500 font-data">{index + 1}</td>
                <td className="py-2">
                  <button onClick={() => onSelectStock?.(pick.symbol)}
                          className="font-bold text-slate-100 hover:text-indigo-300 font-display">{pick.symbol}</button>
                  {thin && <span className="ml-1.5 text-[9px] font-data text-amber-400" title="Below Rs 5cr ADT: real slippage will exceed the 25bps/side the backtest assumed">THIN</span>}
                </td>
                <td className="py-2 text-right font-data text-emerald-400">
                  {snap.factor === 'momentum_12_1' ? fmtPct(pick.r12_1 ?? pick.score) : fmtNum(pick.score)}
                </td>
                <td className="py-2 text-right font-data text-slate-400">
                  {pick.adt20 == null ? '—' : `₹${(pick.adt20 / 10_000_000).toFixed(1)}cr`}
                </td>
                <td className="py-2 text-right font-data text-slate-200">{fmtNum(pick.close)}</td>
              </tr>
            );
          })}</tbody>
        </table>
      </div>
    </Card>
  );
};

const FactorPaperScreen: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const { data, isLoading } = trpc.getFactorPaperPicks.useQuery(undefined, { staleTime: 5 * 60_000 });
  if (isLoading) return <Card dense title="Factor Paper Screens" icon={TrendingUp}><p className="text-xs text-slate-400 font-data">Loading scheduled factor snapshots…</p></Card>;
  const snaps = data?.factors?.length
    ? data.factors
    // Fallback for a snapshot written before the multi-factor key split.
    : (data?.picks?.length ? [{ factor: 'momentum_12_1', ...data }] : []);
  if (!snaps.length) return null;
  return (
    <div className="space-y-4">
      {snaps.map(snap => (
        <FactorCard key={snap.factor} snap={snap as any} onSelectStock={onSelectStock} />
      ))}
    </div>
  );
};

// ─── Stock symbol search (mirrors StockIntelligencePage's SymbolSearch) ───────
const StockSearchBox: React.FC<{ onSelect: (symbol: string) => void }> = ({ onSelect }) => {
  const [q, setQ] = useState('');
  const { data } = trpc.searchNSEStocks.useQuery({ query: q }, { enabled: q.length >= 1 });
  const results = data?.stocks ?? [];
  return (
    <div className="relative max-w-md">
      <div className="flex items-center gap-2 glass rounded-xl px-3 py-2.5 border border-white/10">
        <Search className="w-4 h-4 text-slate-400" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a stock to see every screener it currently appears in…"
          className="bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-500 w-full"
        />
      </div>
      {q.length >= 1 && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto glass-strong rounded-xl border border-white/10 terminal-scrollbar">
          {results.map((s: any) => (
            <button
              key={s.symbol}
              onClick={() => { onSelect(s.symbol); setQ(''); }}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-indigo-500/20 hover:text-white flex justify-between"
            >
              <span className="font-bold font-display">{s.symbol}</span>
              <span className="text-slate-400 truncate ml-2 font-sans">{s.name}</span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

// ─── Stocks mode: every screener a given stock currently belongs to ───────────
const StockScreenerMembership: React.FC<{ symbol: string; onSelectStock?: (symbol: string) => void }> = ({ symbol, onSelectStock }) => {
  const { data, isLoading } = trpc.getStockScreeners.useQuery({ stockId: symbol }, { staleTime: 5 * 60_000 });
  const screeners = data ?? [];

  const bySource = useMemo(() => {
    const groups = new Map<string, typeof screeners>();
    for (const s of screeners) {
      const key = s.source ?? 'unknown';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key)!.push(s);
    }
    return Array.from(groups.entries());
  }, [screeners]);

  if (isLoading) return <p className="text-xs text-slate-400 font-data">Checking every screener source for {symbol}…</p>;
  if (screeners.length === 0) {
    return <p className="text-xs text-slate-400 font-data">{symbol} does not currently appear in any tracked screener.</p>;
  }

  const bullish = screeners.filter((s: any) => (s.sentiment ?? 'neutral') === 'bullish').length;
  const bearish = screeners.filter((s: any) => (s.sentiment ?? 'neutral') === 'bearish').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        {onSelectStock ? (
          <button onClick={() => onSelectStock(symbol)} className="text-sm font-bold font-display text-white hover:text-indigo-400" title={`Open ${symbol}'s full profile`}>
            {symbol}
          </button>
        ) : (
          <h3 className="text-sm font-bold font-display text-white">{symbol}</h3>
        )}
        <span className="text-[11px] text-slate-400 font-data">{screeners.length} screener{screeners.length === 1 ? '' : 's'} right now</span>
        {bullish > 0 && <span className="flex items-center gap-1 text-[11px] text-emerald-400 font-data"><TrendingUp className="w-3 h-3" /> {bullish} bullish</span>}
        {bearish > 0 && <span className="flex items-center gap-1 text-[11px] text-rose-400 font-data"><TrendingDown className="w-3 h-3" /> {bearish} bearish</span>}
      </div>
      {bySource.map(([source, rows]) => (
        <div key={source}>
          <p className="text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest mb-2">{SOURCE_LABEL[source] ?? source} ({rows.length})</p>
          <div className="flex flex-wrap gap-2">
            {rows.map((s: any, i: number) => {
              const sentiment = s.sentiment ?? 'neutral';
              return (
                <span
                  key={`${s.id}-${i}`}
                  title={s.description || s.name}
                  className={cn('px-2.5 py-1 rounded-lg text-[11px] font-semibold border flex items-center gap-1', SENTIMENT_STYLE[sentiment])}
                >
                  {sentiment === 'bullish' ? <TrendingUp className="w-3 h-3" /> : sentiment === 'bearish' ? <TrendingDown className="w-3 h-3" /> : <Minus className="w-3 h-3" />}
                  {s.name}
                </span>
              );
            })}
          </div>
        </div>
      ))}
    </div>
  );
};

// ─── Screeners mode: full multi-provider browser with filters ────────────────
const HORIZONS: Horizon[] = ['5d', '10d', '20d', '60d', '120d'];
const LIMIT = 30;

const TIER_COLOR: Record<string, string> = {
  A: 'var(--v6-positive)', B: 'var(--v5-sky)', C: 'var(--v6-highlight)', D: 'var(--v6-negative)',
};

const StatTile: React.FC<{ label: string; value: string; sub?: string }> = ({ label, value, sub }) => (
  <div className="v1-card px-4 py-3">
    <p className="text-[10px] font-bold text-slate-400 font-display uppercase tracking-widest mb-1">{label}</p>
    <p className="text-lg font-bold font-data text-slate-100">{value}</p>
    {sub && <p className="text-[10px] text-slate-500 mt-0.5 truncate">{sub}</p>}
  </div>
);

const FilterField: React.FC<{ label: string; className?: string; children: React.ReactNode }> = ({ label, className, children }) => (
  <div className={className}>
    <label className="block text-[9px] font-bold text-slate-400 font-display uppercase tracking-wider mb-1">{label}</label>
    {children}
  </div>
);

const ScreenerBrowser: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [source, setSource] = useState<SourceFilter>('all');
  const [category, setCategory] = useState<string>('');
  const [tier, setTier] = useState<TierFilter>('ALL');
  const [horizon, setHorizon] = useState<Horizon>('20d');
  const [nameQuery, setNameQuery] = useState('');
  const [offset, setOffset] = useState(0);

  const categoryStatsQ = trpc.getScreenerCategoryStats.useQuery({ horizon });
  const categories = categoryStatsQ.data ?? [];

  const leaderboardQ = trpc.getScreenerLeaderboard.useQuery({
    category: category || undefined,
    source: source === 'all' ? undefined : source,
    tier: tier === 'ALL' ? undefined : tier,
    horizon,
    limit: LIMIT,
    offset,
  }, { refetchInterval: 5 * 60_000 });

  const rows = leaderboardQ.data ?? [];
  const filteredRows = useMemo(() => {
    if (!nameQuery.trim()) return rows;
    const q = nameQuery.trim().toLowerCase();
    return rows.filter((r: any) => (r.name ?? '').toLowerCase().includes(q));
  }, [rows, nameQuery]);

  const resetPage = () => setOffset(0);

  // Honest aggregates only: derived from the same category-stats fetch the chips/table below
  // already read (screener_performance_v2, see LegacyScoreBanner) -- not a fabricated global
  // count, and not computed from the current 30-row page.
  const totalScreeners = categories.reduce((sum: number, c: any) => sum + (c.screener_count ?? 0), 0);
  const weightedWinRate = totalScreeners > 0
    ? categories.reduce((sum: number, c: any) => sum + (c.avg_win_rate ?? 0) * (c.screener_count ?? 0), 0) / totalScreeners
    : null;
  const categoryCount = new Set(categories.map((c: any) => c.category).filter(Boolean)).size;
  const bestCategory = categories.length
    ? [...categories].filter((c: any) => c.avg_win_rate != null).sort((a: any, b: any) => b.avg_win_rate - a.avg_win_rate)[0]
    : null;

  return (
    <div className="space-y-4">
      <FactorPaperScreen onSelectStock={onSelectStock} />
      {/* Tier/Win Rate/Alpha below are precomputed in screener_performance_v2, not the
          canonical model -- see measurement.md and the canonical-read-audit finding this
          banner exists to fix. */}
      <LegacyScoreBanner note="Tier, Win Rate, Avg Return, and Alpha are precomputed per-screener in screener_performance_v2. A from-scratch remeasurement of this same table found its win-rate figures didn't reproduce (one screener read 100%, remeasured at 65%), and 0 of 1,563 individual screeners tested clear a false-discovery correction -- treat this as a browse of what a screener currently flags, not a graded prediction. Check Alpha / Buy Recs for the canonical, regime-aware view." />

      {!categoryStatsQ.isLoading && categories.length > 0 && (
        <div className="v1-grid-4">
          <StatTile label="Categories" value={String(categoryCount)} sub={`${horizon} horizon`} />
          <StatTile label="Screeners Tracked" value={totalScreeners.toLocaleString('en-IN')} sub="across all categories" />
          <StatTile label="Weighted Avg Win Rate" value={fmtPct(weightedWinRate)} sub="screener_performance_v2" />
          <StatTile label="Top Category" value={bestCategory?.category ?? '—'} sub={bestCategory ? `${fmtPct(bestCategory.avg_win_rate)} avg WR` : undefined} />
        </div>
      )}

      {/* Filter bar */}
      <div className="v1-card p-4 space-y-3">
        <div className="flex items-center gap-2">
          <Filter className="w-4 h-4 text-indigo-400" />
          <h3 className="v1-data-label">Filters</h3>
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <FilterField label="Search" className="flex-1 min-w-[220px]">
            <div className="flex items-center gap-2 bg-slate-950/60 border border-white/10 rounded-lg px-3 py-2">
              <Search className="w-3.5 h-3.5 text-slate-400 shrink-0" />
              <input
                value={nameQuery}
                onChange={(e) => setNameQuery(e.target.value)}
                placeholder="Filter screener names on this page…"
                className="bg-transparent outline-none text-xs text-white placeholder:text-slate-500 w-full"
              />
            </div>
          </FilterField>
          <FilterField label="Source">
            <select
              value={source}
              onChange={(e) => { setSource(e.target.value as SourceFilter); resetPage(); }}
              className="bg-slate-950/60 border border-white/10 text-slate-200 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
            >
              <option value="all" className="bg-slate-900 text-slate-200">All Sources</option>
              <option value="trendlyne" className="bg-slate-900 text-slate-200">Trendlyne</option>
              <option value="moneycontrol" className="bg-slate-900 text-slate-200">MoneyControl</option>
              <option value="etnow" className="bg-slate-900 text-slate-200">ETnow</option>
            </select>
          </FilterField>
          <FilterField label="Category">
            <select
              value={category}
              onChange={(e) => { setCategory(e.target.value); resetPage(); }}
              className="bg-slate-950/60 border border-white/10 text-slate-200 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none max-w-[180px]"
            >
              <option value="" className="bg-slate-900 text-slate-200">All Categories</option>
              {Array.from(new Set(categories.map((c: any) => c.category).filter(Boolean))).map((c: any) => (
                <option key={c} value={c} className="bg-slate-900 text-slate-200">{c}</option>
              ))}
            </select>
          </FilterField>
          <FilterField label="Tier">
            <select
              value={tier}
              onChange={(e) => { setTier(e.target.value as TierFilter); resetPage(); }}
              className="bg-slate-950/60 border border-white/10 text-slate-200 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
            >
              <option value="ALL" className="bg-slate-900 text-slate-200">All Tiers</option>
              <option value="A" className="bg-slate-900 text-slate-200">Tier A</option>
              <option value="B" className="bg-slate-900 text-slate-200">Tier B</option>
              <option value="C" className="bg-slate-900 text-slate-200">Tier C</option>
              <option value="D" className="bg-slate-900 text-slate-200">Tier D</option>
              <option value="Unranked" className="bg-slate-900 text-slate-200">Unranked</option>
            </select>
          </FilterField>
          <FilterField label="Horizon">
            <select
              value={horizon}
              onChange={(e) => { setHorizon(e.target.value as Horizon); resetPage(); }}
              className="bg-slate-950/60 border border-white/10 text-slate-200 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
            >
              {HORIZONS.map((h) => <option key={h} value={h} className="bg-slate-900 text-slate-200">{h} horizon</option>)}
            </select>
          </FilterField>
        </div>
      </div>

      {/* Category overview strip */}
      {categories.length > 0 && (
        <div className="space-y-1.5">
          <p className="text-[10px] font-bold text-[var(--v6-faint)] uppercase tracking-widest">Popular Categories</p>
          <div className="flex gap-2 overflow-x-auto terminal-scrollbar pb-1">
          {categories.slice(0, 10).map((c: any) => (
            <button
              key={`${c.category}-${c.subcategory}`}
              onClick={() => { setCategory(c.category === category ? '' : c.category); resetPage(); }}
              className={cn(
                'shrink-0 px-3 py-2 rounded-xl border text-left transition-colors',
                c.category === category ? 'bg-[var(--v6-accent-soft)] border-[var(--v6-accent)]' : 'bg-[var(--v6-bg-band)] border-[var(--v6-border)] hover:border-[var(--v6-border-strong)]',
              )}
            >
              <p className="text-[10px] font-bold text-[var(--v6-ink-soft)]">{c.category}</p>
              <p className="text-[10px] text-[var(--v6-faint)]">{c.screener_count} screeners · {fmtPct(c.avg_win_rate)} avg WR</p>
            </button>
          ))}
          </div>
        </div>
      )}

      {/* Results table */}
      <Card dense title={`Screeners (${filteredRows.length}${nameQuery ? ` of ${rows.length} on this page` : ''})`} icon={ListFilter}>
        {leaderboardQ.isLoading ? (
          <p className="text-xs text-slate-400 font-data">Loading screener leaderboard…</p>
        ) : filteredRows.length === 0 ? (
          <p className="text-xs text-slate-400 font-data">No screeners match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-slate-400 font-display uppercase tracking-wider border-b border-white/10">
                  <th className="text-left py-2 pr-3">Name</th>
                  <th className="text-left py-2 px-3">Source</th>
                  <th className="text-left py-2 px-3">Category</th>
                  <th className="text-center py-2 px-3">Tier</th>
                  <th className="text-right py-2 px-3">Win Rate</th>
                  <th className="text-right py-2 px-3">Avg Return</th>
                  <th className="text-right py-2 px-3">Alpha</th>
                  <th className="text-right py-2 pl-3">Appearances</th>
                </tr>
              </thead>
              <tbody>
                {filteredRows.map((r: any) => {
                  const tierColor = TIER_COLOR[r.tier as string] ?? '#94a3b8';
                  return (
                  <tr key={`${r.source}-${r.screener_id}`} className="border-b border-white/5 hover:bg-white/5 transition-colors">
                    <td className="py-2.5 pr-3 font-bold text-slate-100 font-display max-w-[220px] truncate" title={r.name}>{r.name}</td>
                    <td className="py-2.5 px-3 text-slate-300 font-sans">{SOURCE_LABEL[r.source] ?? r.source}</td>
                    <td className="py-2.5 px-3 text-slate-400 font-sans truncate max-w-[140px]" title={r.subcategory}>{r.category ?? '—'}</td>
                    <td className="py-2.5 px-3 text-center">
                      <span className="inline-flex items-center gap-1.5 text-[10px] font-bold font-data" style={{ color: tierColor }}>
                        <span
                          className="w-1.5 h-1.5 rounded-full shrink-0"
                          style={{ background: tierColor, boxShadow: r.tier ? `0 0 4px ${tierColor}` : 'none' }}
                        />
                        {r.tier ?? '—'}
                      </span>
                    </td>
                    <td className="text-right py-2.5 px-3 font-data text-slate-200">{fmtPct(r.win_rate)}</td>
                    <td className={cn('text-right py-2.5 px-3 font-data', r.avg_return == null ? 'text-slate-400' : r.avg_return >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtNum(r.avg_return)}%</td>
                    <td className={cn('text-right py-2.5 px-3 font-data', r.alpha == null ? 'text-slate-400' : r.alpha >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtNum(r.alpha)}%</td>
                    <td className="text-right py-2.5 pl-3 font-data text-slate-400">{r.total_appearances ?? '—'}</td>
                  </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-white/10">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
          ><ChevronLeft className="w-3.5 h-3.5" /> Prev</button>
          <span className="text-[11px] text-slate-400 font-data">Showing {offset + 1}–{offset + rows.length}</span>
          <button
            disabled={rows.length < LIMIT}
            onClick={() => setOffset(offset + LIMIT)}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-white disabled:opacity-30 transition-colors"
          >Next <ChevronRight className="w-3.5 h-3.5" /></button>
        </div>
      </Card>
    </div>
  );
};

// ─── Page ───────────────────────────────────────────────────────────────────

export const ScreenerBrowserPage: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [mode, setMode] = useState<SearchMode>('screeners');
  const [stockSymbol, setStockSymbol] = useState<string | null>(null);

  return (
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <Layers3 className="w-6 h-6 text-indigo-400" /> Screener Browser
          </h1>
          <p className="text-sm text-slate-400 mt-1">Explore 1,600+ screeners across 4 providers or look up which screeners a stock belongs to</p>
        </div>
        <div className="v1-header-actions">
          <div className="flex gap-1 p-1 bg-slate-900/80 rounded-xl border border-white/10">
            <button
              onClick={() => setMode('screeners')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-colors', mode === 'screeners' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white')}
            ><Layers3 className="w-3.5 h-3.5" /> Browse Screeners</button>
            <button
              onClick={() => setMode('stocks')}
              className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-semibold font-display transition-colors', mode === 'stocks' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-white')}
            ><Search className="w-3.5 h-3.5" /> Stock Lookup</button>
          </div>
        </div>
      </div>

      {mode === 'screeners' ? (
        <ScreenerBrowser onSelectStock={onSelectStock} />
      ) : (
        <div className="space-y-4">
          <StockSearchBox onSelect={setStockSymbol} />
          {stockSymbol ? (
            <Card icon={Search}>
              <StockScreenerMembership symbol={stockSymbol} onSelectStock={onSelectStock} />
            </Card>
          ) : (
            <div className="v1-card flex flex-col items-center justify-center py-12 text-center gap-3">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center bg-indigo-500/10 border border-indigo-500/20">
                <Search className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-200">Search a stock above</p>
                <p className="text-xs text-slate-400 mt-1">See every Trendlyne, MoneyControl, ETnow, and ET Marketstats<br />screener that stock currently belongs to, with bullish/bearish tagging.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScreenerBrowserPage;
