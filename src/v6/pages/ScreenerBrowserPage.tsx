import React, { useMemo, useState } from 'react';
import { Search, Filter, Layers3, TrendingUp, TrendingDown, Minus, ChevronLeft, ChevronRight, ListFilter } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
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
  bullish: 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25',
  bearish: 'bg-rose-500/10 text-rose-400 border-rose-500/25',
  neutral: 'bg-slate-700/30 text-slate-400 border-slate-700/60',
};

function fmtPct(n: number | null | undefined): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return `${(n * 100).toFixed(1)}%`;
}
function fmtNum(n: number | null | undefined, digits = 2): string {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

// Both validated standalone paper screens. value_book_to_price is rendered FIRST because it
// is the stronger of the two on every measured axis (t 2.67 vs 2.08, Sharpe 1.47 vs 1.10,
// turnover 0.28 vs 0.35, max DD -17.9% vs -19.5%) -- it was validated but unwired until
// 2026-08-10, so this panel could previously only show the weaker factor.
const FACTOR_META: Record<string, { title: string; scoreLabel: string; blurb: string }> = {
  value_book_to_price: {
    title: 'Book-to-Price Value Screen',
    scoreLabel: 'B/P',
    blurb: 'Fama-French HML book-to-market. Strongest factor measured here: +0.93%/mo excess over 65 monthly rebalances (t=2.67), Sharpe 1.47, lowest turnover of anything that works. Valuation history is a vendor backfill, so treat the t-stat as provisional.',
  },
  momentum_12_1: {
    title: '12-1 Momentum Paper Screen',
    scoreLabel: '12-1 Return',
    blurb: 'Twelve-month return skipping the last month. +0.86%/mo excess (t=2.08), positive in all 9 cost x size configurations tested.',
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
      <span className={`text-[10px] font-mono ${expired ? 'text-slate-500' : 'text-amber-400'}`}>
        {expired ? 'EXPIRED' : 'PAPER TRADE'} · AS OF {snap.asOf}
      </span>
    }>
      {expired ? (
        <p className="text-[11px] text-rose-300/90 mb-3">
          Not actionable — the entry open for this list{snap.entrySession ? ` (${snap.entrySession})` : ''} has already traded. Shown as a record of the last generated signal; wait for the next refresh.
        </p>
      ) : (
        <p className="text-[11px] text-slate-500 mb-1">{meta.blurb} Entry is the next session's open.</p>
      )}
      {/* The decay caveat travels with the picks on purpose -- both factors fade to ~zero in
          2026 and that is the single most important thing about them. */}
      <p className="text-[11px] text-amber-500/80 mb-3">
        Decaying: excess has fallen toward zero through 2025-26, and neither clears a
        multiple-testing bar across the 18 factors tested. Not the canonical Alpha score, and
        not a buy recommendation.
      </p>
      <div className={`overflow-x-auto ${expired ? 'opacity-50' : ''}`}>
        <table className="w-full text-xs">
          <thead><tr className="text-[10px] text-slate-500 uppercase border-b border-slate-800">
            <th className="text-left py-2">Rank</th><th className="text-left py-2">Symbol</th>
            <th className="text-right py-2">{meta.scoreLabel}</th>
            <th className="text-right py-2">20D ADT</th><th className="text-right py-2">Close</th>
          </tr></thead>
          <tbody>{snap.picks.slice(0, 10).map((pick, index) => {
            // Below ~Rs 5cr ADT the backtest's 25bps/side cost assumption is optimistic, so
            // flag it on the row rather than presenting every name as equally tradeable.
            const thin = pick.adt20 != null && pick.adt20 < 50_000_000;
            return (
              <tr key={pick.symbol} className="border-b border-slate-900">
                <td className="py-2 text-slate-600 font-mono">{index + 1}</td>
                <td className="py-2">
                  <button onClick={() => onSelectStock?.(pick.symbol)}
                          className="font-bold text-slate-100 hover:text-indigo-300">{pick.symbol}</button>
                  {thin && <span className="ml-1.5 text-[9px] font-mono text-amber-500/70" title="Below Rs 5cr ADT: real slippage will exceed the 25bps/side the backtest assumed">THIN</span>}
                </td>
                <td className="py-2 text-right font-mono text-emerald-400">
                  {snap.factor === 'momentum_12_1' ? fmtPct(pick.r12_1 ?? pick.score) : fmtNum(pick.score)}
                </td>
                <td className="py-2 text-right font-mono text-slate-400">
                  {pick.adt20 == null ? '—' : `₹${(pick.adt20 / 10_000_000).toFixed(1)}cr`}
                </td>
                <td className="py-2 text-right font-mono text-slate-300">{fmtNum(pick.close)}</td>
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
  if (isLoading) return <Card dense title="Factor Paper Screens" icon={TrendingUp}><p className="text-xs text-slate-500 font-mono">Loading scheduled factor snapshots…</p></Card>;
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
      <div className="flex items-center gap-2 glass rounded-xl px-3 py-2.5">
        <Search className="w-4 h-4 text-slate-500" />
        <input
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder="Search a stock to see every screener it currently appears in…"
          className="bg-transparent outline-none text-sm text-slate-200 placeholder:text-slate-600 w-full"
        />
      </div>
      {q.length >= 1 && results.length > 0 && (
        <div className="absolute z-20 mt-1 w-full max-h-80 overflow-y-auto glass-strong rounded-xl border border-slate-800 terminal-scrollbar">
          {results.map((s: any) => (
            <button
              key={s.symbol}
              onClick={() => { onSelect(s.symbol); setQ(''); }}
              className="w-full text-left px-3 py-2 text-xs text-slate-300 hover:bg-indigo-500/10 hover:text-white flex justify-between"
            >
              <span className="font-bold">{s.symbol}</span>
              <span className="text-slate-500 truncate ml-2">{s.name}</span>
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

  if (isLoading) return <p className="text-xs text-slate-500 font-mono">Checking every screener source for {symbol}…</p>;
  if (screeners.length === 0) {
    return <p className="text-xs text-slate-500 font-mono">{symbol} does not currently appear in any tracked screener.</p>;
  }

  const bullish = screeners.filter((s: any) => (s.sentiment ?? 'neutral') === 'bullish').length;
  const bearish = screeners.filter((s: any) => (s.sentiment ?? 'neutral') === 'bearish').length;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-4">
        {onSelectStock ? (
          <button onClick={() => onSelectStock(symbol)} className="text-sm font-bold text-slate-100 hover:text-indigo-300" title={`Open ${symbol}'s full profile`}>
            {symbol}
          </button>
        ) : (
          <h3 className="text-sm font-bold text-slate-100">{symbol}</h3>
        )}
        <span className="text-[11px] text-slate-500">{screeners.length} screener{screeners.length === 1 ? '' : 's'} right now</span>
        {bullish > 0 && <span className="flex items-center gap-1 text-[11px] text-emerald-400"><TrendingUp className="w-3 h-3" /> {bullish} bullish</span>}
        {bearish > 0 && <span className="flex items-center gap-1 text-[11px] text-rose-400"><TrendingDown className="w-3 h-3" /> {bearish} bearish</span>}
      </div>
      {bySource.map(([source, rows]) => (
        <div key={source}>
          <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest mb-2">{SOURCE_LABEL[source] ?? source} ({rows.length})</p>
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

  return (
    <div className="space-y-4">
      <FactorPaperScreen onSelectStock={onSelectStock} />
      {/* Filter bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex items-center gap-2 glass rounded-xl px-3 py-2 flex-1 min-w-[220px]">
          <Search className="w-3.5 h-3.5 text-slate-500 shrink-0" />
          <input
            value={nameQuery}
            onChange={(e) => setNameQuery(e.target.value)}
            placeholder="Filter screener names on this page…"
            className="bg-transparent outline-none text-xs text-slate-200 placeholder:text-slate-600 w-full"
          />
        </div>
        <select
          value={source}
          onChange={(e) => { setSource(e.target.value as SourceFilter); resetPage(); }}
          className="bg-slate-950 border border-slate-800 text-slate-300 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="all">All Sources</option>
          <option value="trendlyne">Trendlyne</option>
          <option value="moneycontrol">MoneyControl</option>
          <option value="etnow">ETnow</option>
        </select>
        <select
          value={category}
          onChange={(e) => { setCategory(e.target.value); resetPage(); }}
          className="bg-slate-950 border border-slate-800 text-slate-300 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none max-w-[180px]"
        >
          <option value="">All Categories</option>
          {Array.from(new Set(categories.map((c: any) => c.category).filter(Boolean))).map((c: any) => (
            <option key={c} value={c}>{c}</option>
          ))}
        </select>
        <select
          value={tier}
          onChange={(e) => { setTier(e.target.value as TierFilter); resetPage(); }}
          className="bg-slate-950 border border-slate-800 text-slate-300 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
        >
          <option value="ALL">All Tiers</option>
          <option value="A">Tier A</option>
          <option value="B">Tier B</option>
          <option value="C">Tier C</option>
          <option value="D">Tier D</option>
          <option value="Unranked">Unranked</option>
        </select>
        <select
          value={horizon}
          onChange={(e) => { setHorizon(e.target.value as Horizon); resetPage(); }}
          className="bg-slate-950 border border-slate-800 text-slate-300 text-xs font-semibold rounded-lg px-3 py-2 focus:outline-none"
        >
          {HORIZONS.map((h) => <option key={h} value={h}>{h} horizon</option>)}
        </select>
      </div>

      {/* Category overview strip */}
      {categories.length > 0 && (
        <div className="flex gap-2 overflow-x-auto terminal-scrollbar pb-1">
          {categories.slice(0, 10).map((c: any) => (
            <button
              key={`${c.category}-${c.subcategory}`}
              onClick={() => { setCategory(c.category === category ? '' : c.category); resetPage(); }}
              className={cn(
                'shrink-0 px-3 py-2 rounded-xl border text-left transition-colors',
                c.category === category ? 'bg-indigo-500/15 border-indigo-500/40' : 'bg-slate-900/40 border-slate-800 hover:border-slate-700',
              )}
            >
              <p className="text-[10px] font-bold text-slate-300">{c.category}</p>
              <p className="text-[10px] text-slate-500">{c.screener_count} screeners · {fmtPct(c.avg_win_rate)} avg WR</p>
            </button>
          ))}
        </div>
      )}

      {/* Results table */}
      <Card dense title={`Screeners (${filteredRows.length}${nameQuery ? ` of ${rows.length} on this page` : ''})`} icon={ListFilter}>
        {leaderboardQ.isLoading ? (
          <p className="text-xs text-slate-500 font-mono">Loading screener leaderboard…</p>
        ) : filteredRows.length === 0 ? (
          <p className="text-xs text-slate-500 font-mono">No screeners match these filters.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-[10px] text-slate-500 uppercase tracking-wider border-b border-slate-800">
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
                {filteredRows.map((r: any) => (
                  <tr key={`${r.source}-${r.screener_id}`} className="border-b border-slate-900 hover:bg-slate-900/40">
                    <td className="py-2.5 pr-3 font-bold text-slate-100 max-w-[220px] truncate" title={r.name}>{r.name}</td>
                    <td className="py-2.5 px-3 text-slate-400">{SOURCE_LABEL[r.source] ?? r.source}</td>
                    <td className="py-2.5 px-3 text-slate-500 truncate max-w-[140px]" title={r.subcategory}>{r.category ?? '—'}</td>
                    <td className="py-2.5 px-3 text-center">
                      <span className={cn(
                        'px-1.5 py-0.5 rounded text-[10px] font-bold border',
                        r.tier === 'A' ? 'bg-emerald-500/10 text-emerald-400 border-emerald-500/25' :
                        r.tier === 'B' ? 'bg-sky-500/10 text-sky-400 border-sky-500/25' :
                        r.tier === 'C' ? 'bg-amber-500/10 text-amber-400 border-amber-500/25' :
                        r.tier === 'D' ? 'bg-rose-500/10 text-rose-400 border-rose-500/25' :
                        'bg-slate-700/20 text-slate-500 border-slate-700/40',
                      )}>{r.tier ?? '—'}</span>
                    </td>
                    <td className="text-right py-2.5 px-3 font-mono text-slate-300">{fmtPct(r.win_rate)}</td>
                    <td className={cn('text-right py-2.5 px-3 font-mono', (r.avg_return ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtNum(r.avg_return)}%</td>
                    <td className={cn('text-right py-2.5 px-3 font-mono', (r.alpha ?? 0) >= 0 ? 'text-emerald-400' : 'text-rose-400')}>{fmtNum(r.alpha)}%</td>
                    <td className="text-right py-2.5 pl-3 font-mono text-slate-500">{r.total_appearances ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        <div className="flex items-center justify-between mt-3 pt-3 border-t border-slate-800/60">
          <button
            disabled={offset === 0}
            onClick={() => setOffset(Math.max(0, offset - LIMIT))}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-30"
          ><ChevronLeft className="w-3.5 h-3.5" /> Prev</button>
          <span className="text-[11px] text-slate-500">Showing {offset + 1}–{offset + rows.length}</span>
          <button
            disabled={rows.length < LIMIT}
            onClick={() => setOffset(offset + LIMIT)}
            className="flex items-center gap-1 text-xs font-semibold text-slate-400 hover:text-slate-200 disabled:opacity-30"
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
    <div className="space-y-4">
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-base font-bold text-slate-100">Screener Browser</h1>
          <p className="text-[11px] text-slate-500">Explore 1,600+ screeners across 4 providers or look up which screeners a stock belongs to</p>
        </div>
        <div className="flex gap-0.5 p-0.5 bg-slate-900/60 rounded-xl">
          <button
            onClick={() => setMode('screeners')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors', mode === 'screeners' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200')}
          ><Layers3 className="w-3.5 h-3.5" /> Browse Screeners</button>
          <button
            onClick={() => setMode('stocks')}
            className={cn('flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-bold transition-colors', mode === 'stocks' ? 'bg-indigo-600 text-white' : 'text-slate-400 hover:text-slate-200')}
          ><Search className="w-3.5 h-3.5" /> Stock Lookup</button>
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
            <div className="flex flex-col items-center justify-center py-12 text-center gap-3">
              <div className="w-12 h-12 rounded-xl flex items-center justify-center" style={{ background: 'rgba(99,102,241,0.1)', border: '1px solid rgba(99,102,241,0.15)' }}>
                <Search className="w-6 h-6 text-indigo-400" />
              </div>
              <div>
                <p className="text-sm font-semibold text-slate-300">Search a stock above</p>
                <p className="text-xs text-slate-500 mt-1">See every Trendlyne, MoneyControl, ETnow, and ET Marketstats<br />screener that stock currently belongs to, with bullish/bearish tagging.</p>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
};

export default ScreenerBrowserPage;
