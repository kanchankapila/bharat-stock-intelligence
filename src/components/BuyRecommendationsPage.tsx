import { useState, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import {
  ResponsiveContainer, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, Cell,
} from 'recharts';
import {
  TrendingUp, RefreshCw, Shield, Zap, Star, Activity,
  ChevronUp, ChevronDown, AlertTriangle, Users, BarChart2,
  Building2, Percent, Clock,
} from 'lucide-react';
import { formatISTWithLocal, relativeFromNow } from '../lib/timeFormat';
import { CanonicalBadge } from './CanonicalSourceNote';
import { StockTagRow } from './StockTagRow';
import { V4QuickNav } from '../v4/components/V4QuickNav';

// ─── Types ────────────────────────────────────────────────────────────────────

type ConvFilter = 'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM';
type HorizonFilter = 'ALL' | 'intraday' | 'swing' | 'long_term';

// ─── Style maps ───────────────────────────────────────────────────────────────

const CONV = {
  S_ELITE:  { label: 'S', bg: 'bg-emerald-500/20', border: 'border-emerald-500/40', text: 'text-emerald-300', dot: 'bg-emerald-400' },
  A_HIGH:   { label: 'A', bg: 'bg-sky-500/20',     border: 'border-sky-500/40',     text: 'text-sky-300',     dot: 'bg-sky-400'     },
  B_MEDIUM: { label: 'B', bg: 'bg-amber-500/15',   border: 'border-amber-500/35',   text: 'text-amber-300',   dot: 'bg-amber-400'   },
  C_LOW:    { label: 'C', bg: 'bg-slate-700/40',   border: 'border-slate-600/40',   text: 'text-slate-400',   dot: 'bg-slate-500'   },
} as const;

const REGIME_COLOR: Record<string, string> = {
  BULL: 'text-emerald-400', BEAR: 'text-rose-400', HIGH_VOL: 'text-amber-400',
  SIDEWAYS: 'text-sky-400', CRASH: 'text-red-400',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────

const n2 = (v: number | null | undefined) => v == null ? null : +v.toFixed(2);
const pctFmt = (v: number | null | undefined, decimals = 1) =>
  v == null ? '—' : `${v >= 0 ? '+' : ''}${v.toFixed(decimals)}%`;
const pctColor = (v: number | null | undefined) =>
  v == null ? 'text-slate-400' : v >= 0 ? 'text-emerald-400' : 'text-rose-400';
const numFmt = (v: number | null | undefined) => v == null ? '—' : v.toFixed(1);

// ─── Mini score bar ───────────────────────────────────────────────────────────

function ScoreBar({ value, max = 100, color = 'bg-sky-500' }: { value: number | null; max?: number; color?: string }) {
  const w = value == null ? 0 : Math.max(0, Math.min(100, (value / max) * 100));
  return (
    <div className="flex-1 h-1 bg-slate-700/60 rounded-full overflow-hidden">
      <div className={cn('h-full rounded-full', color)} style={{ width: `${w}%` }} />
    </div>
  );
}

// ─── Stock card ───────────────────────────────────────────────────────────────

function StockCard({ p, onSelect }: { p: any; onSelect: (sym: string) => void }) {
  const [expanded, setExpanded] = useState(false);
  const style = CONV[p.conviction_level as keyof typeof CONV] ?? CONV.B_MEDIUM;
  const winPct = p.win_probability != null ? Math.round(p.win_probability * 100) : null;
  const rr = n2(p.risk_reward);

  return (
    <div
      className={cn(
        'rounded-xl border p-4 flex flex-col gap-2 transition-all hover:brightness-110',
        style.bg, style.border,
      )}
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-2">
        <div className="flex-1 min-w-0">
          <button
            onClick={() => onSelect(p.symbol)}
            className="font-bold text-white text-base leading-tight hover:text-sky-300 transition-colors text-left"
          >
            {p.symbol}
          </button>
          {p.sector && <div className="text-[10px] text-slate-400 truncate mt-0.5">{p.sector}</div>}
        </div>

        <div className="flex flex-col items-end gap-1">
          <span className={cn('text-[10px] font-bold px-2 py-0.5 rounded-full border', style.text, style.border)}>
            {style.label}
          </span>
          {p.timeframe && (
            <span className="text-[9px] text-slate-500 uppercase">{p.timeframe.replace('_', ' ')}</span>
          )}
          {p.engine_coverage_count != null && (
            <span
              className="text-[9px] text-slate-500"
              title="How many of the ranker's component engines (screener/ml/confluence/technical/dl/cs/breakout) had data for this stock — higher means the unified_score is backed by more independent sources, not just one"
            >
              {p.engine_coverage_count}/7 engines
            </span>
          )}
        </div>
      </div>

      {/* Price row */}
      <div className="flex items-center gap-3">
        <span className="text-lg font-semibold text-white">
          {p.livePrice != null ? `₹${p.livePrice.toFixed(0)}` : '—'}
        </span>
        <span className={cn('text-xs font-medium', pctColor(p.changePercent))}>
          {pctFmt(p.changePercent)}
        </span>
        {p.iep_gap_pct != null && Math.abs(p.iep_gap_pct) > 0.5 && (
          <span className={cn('text-[10px]', pctColor(p.iep_gap_pct))}>
            IEP {pctFmt(p.iep_gap_pct, 1)}
          </span>
        )}
      </div>

      {/* Score bars */}
      <div className="space-y-1">
        {winPct != null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="w-14 text-slate-400 shrink-0">Win prob</span>
            <ScoreBar value={winPct} color={winPct >= 65 ? 'bg-emerald-500' : winPct >= 50 ? 'bg-sky-500' : 'bg-amber-500'} />
            <span className={cn('w-8 text-right font-semibold', winPct >= 65 ? 'text-emerald-400' : winPct >= 50 ? 'text-sky-400' : 'text-amber-400')}>
              {winPct}%
            </span>
          </div>
        )}
        {p.ml_score != null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="w-14 text-slate-400 shrink-0">ML</span>
            <ScoreBar value={p.ml_score} color="bg-violet-500" />
            <span className="w-8 text-right text-slate-400">{n2(p.ml_score)}</span>
          </div>
        )}
        {p.technical_score != null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="w-14 text-slate-400 shrink-0">Technical</span>
            <ScoreBar value={p.technical_score} color="bg-sky-500" />
            <span className="w-8 text-right text-slate-400">{n2(p.technical_score)}</span>
          </div>
        )}
        {p.confluence_score != null && (
          <div className="flex items-center gap-2 text-[10px]">
            <span className="w-14 text-slate-400 shrink-0">Confluence</span>
            <ScoreBar value={p.confluence_score} color="bg-teal-500" />
            <span className="w-8 text-right text-slate-400">{n2(p.confluence_score)}</span>
          </div>
        )}
      </div>

      {/* Trade levels */}
      {(p.entry_zone_low || p.stop_loss || p.target_1) && (
        <div className="grid grid-cols-3 gap-1 text-[10px] mt-1">
          <div>
            <div className="text-slate-500">Entry</div>
            <div className="text-white font-medium">
              {p.entry_zone_low ? `₹${p.entry_zone_low.toFixed(0)}` : '—'}
              {p.entry_zone_high && p.entry_zone_high !== p.entry_zone_low ? `–${p.entry_zone_high.toFixed(0)}` : ''}
            </div>
          </div>
          <div>
            <div className="text-slate-500">SL</div>
            <div className="text-rose-400 font-medium">{p.stop_loss ? `₹${p.stop_loss.toFixed(0)}` : '—'}</div>
          </div>
          <div>
            <div className="text-slate-500">T1 {rr ? `(${rr}R)` : ''}</div>
            <div className="text-emerald-400 font-medium">{p.target_1 ? `₹${p.target_1.toFixed(0)}` : '—'}</div>
          </div>
        </div>
      )}

      {/* Badges */}
      <StockTagRow p={p} className="mt-2" />

      {/* Expand toggle */}
      <button
        onClick={() => setExpanded(e => !e)}
        className="flex items-center gap-1 text-[10px] text-slate-500 hover:text-slate-300 mt-1 self-start"
      >
        {expanded ? <ChevronUp size={10} /> : <ChevronDown size={10} />}
        {expanded ? 'Less' : 'More detail'}
      </button>

      {expanded && (
        <div className="space-y-2 border-t border-slate-700/50 pt-2">
          {/* RS */}
          {(p.rs_vs_sector_21d != null || p.rs_vs_sector_63d != null) && (
            <div className="grid grid-cols-2 gap-2 text-[10px]">
              <div>
                <span className="text-slate-500">RS vs sector 21d: </span>
                <span className={pctColor(p.rs_vs_sector_21d)}>{pctFmt(p.rs_vs_sector_21d)}</span>
              </div>
              <div>
                <span className="text-slate-500">RS 63d: </span>
                <span className={pctColor(p.rs_vs_sector_63d)}>{pctFmt(p.rs_vs_sector_63d)}</span>
              </div>
            </div>
          )}
          {/* EPS detail */}
          {p.eps_surprise_q1 != null && (
            <div className="text-[10px]">
              <span className="text-slate-500">EPS surprise Q1/Q2: </span>
              <span className={pctColor(p.eps_surprise_q1)}>{pctFmt(p.eps_surprise_q1)}</span>
              {p.eps_surprise_q2 != null && <span className={pctColor(p.eps_surprise_q2)}> / {pctFmt(p.eps_surprise_q2)}</span>}
              {p.eps_beat_streak > 0 && <span className="text-emerald-400 ml-2">Streak: {p.eps_beat_streak}Q</span>}
            </div>
          )}
          {/* Financial quality */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            {p.fcf_yield != null && (
              <div><span className="text-slate-500">FCF yield: </span><span className="text-teal-400">{numFmt(p.fcf_yield)}%</span></div>
            )}
            {p.interest_coverage != null && (
              <div><span className="text-slate-500">Int cov: </span><span className={p.interest_coverage < 2 ? 'text-rose-400' : 'text-emerald-400'}>{numFmt(p.interest_coverage)}×</span></div>
            )}
          </div>
          {/* Delivery + options */}
          <div className="grid grid-cols-2 gap-2 text-[10px]">
            {p.delivery_trend_30d != null && (
              <div><span className="text-slate-500">Delivery trend: </span><span className={pctColor(p.delivery_trend_30d)}>{pctFmt(p.delivery_trend_30d)}</span></div>
            )}
            {p.expected_move_pct != null && (
              <div><span className="text-slate-500">Expected move: </span><span className="text-amber-400">±{numFmt(p.expected_move_pct)}%</span></div>
            )}
          </div>
          {/* Broker reco */}
          {(p.mc_broker_buy_7d != null || p.mc_broker_upside != null) && (
            <div className="text-[10px]">
              <span className="text-slate-500">Broker: </span>
              {p.mc_broker_buy_7d != null && <span className="text-emerald-400">{p.mc_broker_buy_7d}B </span>}
              {p.mc_broker_sell_7d != null && <span className="text-rose-400">{p.mc_broker_sell_7d}S </span>}
              {p.mc_broker_upside != null && <span className="text-slate-300">· upside {pctFmt(p.mc_broker_upside)}</span>}
            </div>
          )}
          {/* Reasoning */}
          {p.trade_reasoning && (
            <p className="text-[10px] text-slate-400 leading-relaxed border-t border-slate-700/40 pt-1.5">
              {p.trade_reasoning}
            </p>
          )}
          {/* Days to results */}
          {p.days_to_next_results != null && p.days_to_next_results <= 30 && (
            <div className="flex items-center gap-1 text-[10px] text-amber-400">
              <Clock size={9} /> Results in {p.days_to_next_results}d
            </div>
          )}
        </div>
      )}
    </div>
  );
}

// ─── Stat pill ────────────────────────────────────────────────────────────────

function StatPill({ label, value, color = 'text-white' }: { label: string; value: string | number; color?: string }) {
  return (
    <div className="bg-slate-800/60 border border-slate-700/50 rounded-lg px-3 py-2 text-center">
      <div className={cn('text-base font-bold', color)}>{value}</div>
      <div className="text-[10px] text-slate-500 mt-0.5">{label}</div>
    </div>
  );
}

// ─── Main page ────────────────────────────────────────────────────────────────

export function BuyRecommendationsPage({ onSelectStock }: { onSelectStock: (sym: string) => void }) {
  const [conviction, setConviction] = useState<ConvFilter>('ALL');
  const [horizon, setHorizon] = useState<HorizonFilter>('ALL');
  const [sector, setSector] = useState<string>('');
  const [search, setSearch] = useState('');

  const { data, isLoading, refetch, isFetching, dataUpdatedAt } = trpc.getBuyRecommendations.useQuery({
    conviction,
    horizon,
    sector: sector || undefined,
    limit: 120,
  }, { staleTime: 2 * 60_000, refetchInterval: 3 * 60_000, refetchOnWindowFocus: true });

  const filtered = useMemo(() => {
    if (!data?.picks) return [];
    if (!search.trim()) return data.picks;
    const q = search.toUpperCase();
    return data.picks.filter((p: any) => p.symbol.includes(q) || (p.sector ?? '').toUpperCase().includes(q));
  }, [data?.picks, search]);

  // conviction breakdown
  const breakdown = useMemo(() => {
    const counts: Record<string, number> = { S_ELITE: 0, A_HIGH: 0, B_MEDIUM: 0, C_LOW: 0 };
    (data?.picks ?? []).forEach((p: any) => { if (p.conviction_level in counts) counts[p.conviction_level]++; });
    return counts;
  }, [data?.picks]);

  const avgWin = useMemo(() => {
    const vals = (filtered).filter((p: any) => p.win_probability != null).map((p: any) => p.win_probability as number);
    return vals.length ? Math.round(vals.reduce((a, b) => a + b, 0) / vals.length * 100) : null;
  }, [filtered]);

  // Sector distribution of the currently-filtered picks -- top 8 sectors by count.
  const sectorChartData = useMemo(() => {
    const counts: Record<string, number> = {};
    filtered.forEach((p: any) => { const s = p.sector || 'Unclassified'; counts[s] = (counts[s] ?? 0) + 1; });
    return Object.entries(counts)
      .map(([sector, count]) => ({ sector, count }))
      .sort((a, b) => b.count - a.count)
      .slice(0, 8);
  }, [filtered]);

  // Win-probability histogram in 10pt buckets, over the currently-filtered picks.
  const winProbHistogram = useMemo(() => {
    const buckets = ['<40%', '40-50%', '50-60%', '60-70%', '70-80%', '80%+'];
    const counts = new Array(buckets.length).fill(0);
    filtered.forEach((p: any) => {
      if (p.win_probability == null) return;
      const pct = p.win_probability * 100;
      const idx = pct < 40 ? 0 : pct < 50 ? 1 : pct < 60 ? 2 : pct < 70 ? 3 : pct < 80 ? 4 : 5;
      counts[idx]++;
    });
    return buckets.map((bucket, i) => ({ bucket, count: counts[i] }));
  }, [filtered]);

  const regimeColor = REGIME_COLOR[data?.regime ?? ''] ?? 'text-slate-400';

  return (
    <div className="min-h-screen bg-slate-900 text-white p-4 space-y-4">
      <V4QuickNav />

      {/* Page header */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-xl font-bold flex items-center gap-2">
            <TrendingUp size={20} className="text-emerald-400" />
            Buy Recommendations
            <CanonicalBadge />
          </h1>
          <p className="text-xs text-slate-400 mt-0.5">
            ML-ranked picks · {data?.picks?.length ?? 0} stocks · Model run {data?.lastComputedAt ? formatISTWithLocal(data.lastComputedAt) : '—'}
            {data?.regime && (
              <span className={cn('ml-2 font-semibold', regimeColor)}>· {data.regime}</span>
            )}
            {dataUpdatedAt > 0 && (
              <span className="ml-2 text-slate-600">· page data fetched {relativeFromNow(dataUpdatedAt)}</span>
            )}
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

      {/* Stats row */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <StatPill label="S — Elite" value={breakdown.S_ELITE} color="text-emerald-400" />
        <StatPill label="A — High" value={breakdown.A_HIGH} color="text-sky-400" />
        <StatPill label="B — Medium" value={breakdown.B_MEDIUM} color="text-amber-400" />
        <StatPill label="Avg win prob" value={avgWin != null ? `${avgWin}%` : '—'} color="text-violet-400" />
      </div>

      {/* At-a-glance charts */}
      {filtered.length > 0 && (
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Win-probability distribution</div>
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={winProbHistogram} margin={{ top: 4, right: 4, left: -20, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" vertical={false} />
                <XAxis dataKey="bucket" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} />
                <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }} />
                <Bar dataKey="count" radius={[3, 3, 0, 0]}>
                  {winProbHistogram.map((entry, i) => (
                    <Cell key={i} fill={i >= 4 ? '#10b981' : i >= 2 ? '#0ea5e9' : '#f59e0b'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-slate-800/40 border border-slate-700/50 rounded-lg p-3">
            <div className="text-[10px] font-semibold text-slate-400 uppercase tracking-wide mb-1">Sector concentration (top 8)</div>
            <ResponsiveContainer width="100%" height={110}>
              <BarChart data={sectorChartData} layout="vertical" margin={{ top: 4, right: 12, left: 4, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#334155" horizontal={false} />
                <XAxis type="number" tick={{ fontSize: 9, fill: '#94a3b8' }} axisLine={false} tickLine={false} allowDecimals={false} />
                <YAxis dataKey="sector" type="category" width={90} tick={{ fontSize: 9, fill: '#cbd5e1' }} axisLine={false} tickLine={false} />
                <Tooltip contentStyle={{ background: '#1e293b', border: '1px solid #334155', fontSize: 11 }} />
                <Bar dataKey="count" fill="#8b5cf6" radius={[0, 3, 3, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-2">
        {/* Search */}
        <input
          value={search}
          onChange={e => setSearch(e.target.value)}
          placeholder="Search symbol / sector…"
          className="bg-slate-800 border border-slate-700 rounded-lg px-3 py-1.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-sky-500 w-48"
        />

        {/* Conviction */}
        <div className="flex bg-slate-800 border border-slate-700 rounded-lg overflow-hidden text-xs">
          {(['ALL', 'S_ELITE', 'A_HIGH', 'B_MEDIUM'] as ConvFilter[]).map(c => (
            <button
              key={c}
              onClick={() => setConviction(c)}
              className={cn('px-3 py-1.5 transition-colors', conviction === c ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white')}
            >
              {c === 'ALL' ? 'All' : c === 'S_ELITE' ? 'S' : c === 'A_HIGH' ? 'A' : 'B'}
            </button>
          ))}
        </div>

        {/* Horizon */}
        <div className="flex bg-slate-800 border border-slate-700 rounded-lg overflow-hidden text-xs">
          {(['ALL', 'intraday', 'swing', 'long_term'] as HorizonFilter[]).map(h => (
            <button
              key={h}
              onClick={() => setHorizon(h)}
              className={cn('px-3 py-1.5 transition-colors', horizon === h ? 'bg-sky-600 text-white' : 'text-slate-400 hover:text-white')}
            >
              {h === 'ALL' ? 'All' : h === 'intraday' ? 'Intraday' : h === 'swing' ? 'Swing' : 'Long'}
            </button>
          ))}
        </div>

        {/* Sector */}
        {data?.sectorList && data.sectorList.length > 0 && (
          <select
            value={sector}
            onChange={e => setSector(e.target.value)}
            className="bg-slate-800 border border-slate-700 rounded-lg px-2 py-1.5 text-xs text-white focus:outline-none focus:ring-1 focus:ring-sky-500"
          >
            <option value="">All sectors</option>
            {(data.sectorList as string[]).map(s => <option key={s} value={s}>{s}</option>)}
          </select>
        )}

        {filtered.length !== data?.picks?.length && (
          <span className="text-xs text-slate-400 self-center">{filtered.length} shown</span>
        )}
      </div>

      {/* Card grid */}
      {isLoading ? (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {Array.from({ length: 12 }).map((_, i) => (
            <div key={i} className="rounded-xl border border-slate-700/40 bg-slate-800/40 h-56 animate-pulse" />
          ))}
        </div>
      ) : filtered.length === 0 ? (
        <div className="text-center py-20 text-slate-500">
          <Activity size={40} className="mx-auto mb-3 opacity-30" />
          <p className="text-sm">No recommendations found.</p>
          <p className="text-xs mt-1">Run the unified ranker to generate picks.</p>
        </div>
      ) : (
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
          {filtered.map((p: any) => (
            <StockCard key={p.symbol} p={p} onSelect={onSelectStock} />
          ))}
        </div>
      )}
    </div>
  );
}
