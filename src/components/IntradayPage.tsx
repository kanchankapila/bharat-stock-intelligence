import React, { useMemo, useState } from 'react';
import {
  Zap, TrendingUp, TrendingDown, Target, ShieldAlert, Gauge,
  ArrowUpDown, Search, Radio, Activity, Flame, ChevronRight,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { FnOIndexInsight } from '../v4/components/FnOIndexInsight';

// ── Types (loosely mirror intraday_recommendations / getIntradayBreadth) ──────
interface IntradayRec {
  symbol: string;
  intraday_regime: string | null;
  intraday_score: number | null;
  conviction_level: string | null;
  classification: string | null;
  screener_score: number | null;
  breakout_score: number | null;
  bullish_count: number | null;
  bearish_count: number | null;
  cmp: number | null;
  entry_price: number | null;
  stop_loss: number | null;
  target_1: number | null;
  risk_reward: number | null;
  position_size_pct: number | null;
  reasoning: string | null;
}
interface BreadthRow {
  adv: number; dec: number; unch: number; total: number;
  adv_decline_ratio: number; pct_positive: number; avg_change_pct: number;
  breadth_score: number; risk_tilt: string;
}
interface EmissionGateSide {
  open: boolean;
  reason: string | null;
  avg_pnl_pct: number | null;
  n_trades: number;
}
interface EmissionGateStatus {
  computed_at: string;
  long: EmissionGateSide;
  short: EmissionGateSide;
}

// ── Regime / tilt visual language ─────────────────────────────────────────────
const TILT = {
  RISK_ON:  { label: 'Risk-On',  ring: 'ring-emerald-400/40', text: 'text-emerald-300', dot: 'bg-emerald-400', grad: 'from-emerald-500/20 via-emerald-500/5 to-transparent', bar: 'bg-emerald-400' },
  NEUTRAL:  { label: 'Neutral',  ring: 'ring-amber-400/40',   text: 'text-amber-300',   dot: 'bg-amber-400',   grad: 'from-amber-500/20 via-amber-500/5 to-transparent',     bar: 'bg-amber-400' },
  RISK_OFF: { label: 'Risk-Off', ring: 'ring-rose-400/40',    text: 'text-rose-300',    dot: 'bg-rose-400',    grad: 'from-rose-500/20 via-rose-500/5 to-transparent',       bar: 'bg-rose-400' },
} as const;
const tiltOf = (t?: string | null) => TILT[(t as keyof typeof TILT)] ?? TILT.NEUTRAL;

const CLS = {
  'Strong Buy': 'text-emerald-300 bg-emerald-500/15 ring-emerald-400/30',
  'Buy':        'text-teal-300 bg-teal-500/15 ring-teal-400/30',
  'Hold':       'text-slate-300 bg-slate-500/15 ring-slate-400/20',
  'Sell':       'text-rose-300 bg-rose-500/15 ring-rose-400/30',
  'Strong Sell':'text-rose-200 bg-rose-600/20 ring-rose-400/40',
} as const;

const n2 = (x: number | null | undefined) => (x == null ? '—' : Number(x).toFixed(2));
const n0 = (x: number | null | undefined) => (x == null ? '—' : Math.round(Number(x)).toString());

type SortKey = 'intraday_score' | 'breakout_score' | 'risk_reward' | 'position_size_pct';

const IntradayPage: React.FC<{ onSelectStock: (symbol: string) => void }> = ({ onSelectStock }) => {
  const recsQ = trpc.getIntradayRecommendations.useQuery({ limit: 100 }, { refetchInterval: 60_000 });
  const breadthQ = trpc.getIntradayBreadth.useQuery(undefined, { refetchInterval: 60_000 });
  const accuracyQ = trpc.getIntradayAccuracy.useQuery({ days: 30 });
  const gateQ = trpc.getIntradayEmissionGateStatus.useQuery(undefined, { refetchInterval: 60_000 });

  const [sortKey, setSortKey] = useState<SortKey>('intraday_score');
  const [query, setQuery] = useState('');
  const [buysOnly, setBuysOnly] = useState(true);

  const rows = (recsQ.data?.rows ?? []) as IntradayRec[];
  const breadth = (breadthQ.data?.breadth ?? null) as unknown as BreadthRow | null;
  const dailyRegime = breadthQ.data?.dailyRegime ?? null;
  const intradayRegime = rows[0]?.intraday_regime ?? breadth?.risk_tilt ?? 'NEUTRAL';
  const tilt = tiltOf(intradayRegime);
  // Both feeds run off intraday capture that can silently go stale (server restart, missed
  // cycle) with no other signal of that — don't badge "live" unless the data backs it up.
  const breadthStale = breadthQ.data ? breadthQ.data.isStale : false;
  const recsStale = recsQ.data ? recsQ.data.isStale : false;
  const isLive = !breadthStale && !recsStale;

  const filtered = useMemo(() => {
    let r = rows;
    if (buysOnly) r = r.filter(x => x.classification === 'Buy' || x.classification === 'Strong Buy');
    if (query.trim()) r = r.filter(x => x.symbol.toLowerCase().includes(query.trim().toLowerCase()));
    return [...r].sort((a, b) => (Number(b[sortKey]) || 0) - (Number(a[sortKey]) || 0));
  }, [rows, buysOnly, query, sortKey]);

  const buyCount = rows.filter(r => r.classification === 'Buy' || r.classification === 'Strong Buy').length;
  const sized = rows.filter(r => (r.position_size_pct ?? 0) > 0);
  const avgRR = sized.length ? sized.reduce((s, r) => s + (r.risk_reward ?? 0), 0) / sized.length : 0;

  return (
    <div className="p-5 md:p-7 space-y-6 min-h-full bg-[#070a12]">
      {/* ── Regime banner ───────────────────────────────────────────────── */}
      <div className={cn('relative overflow-hidden rounded-3xl ring-1 bg-slate-900/60 backdrop-blur-xl', tilt.ring)}>
        <div className={cn('absolute inset-0 bg-gradient-to-br pointer-events-none', tilt.grad)} />
        <div className="relative p-6 md:p-8 flex flex-col lg:flex-row lg:items-center gap-8">
          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-2 text-[11px] font-black uppercase tracking-[0.25em] text-slate-400">
              <Zap className="w-3.5 h-3.5 text-cyan-400" /> Intraday Terminal
              {isLive ? (
                <span className="inline-flex items-center gap-1.5 ml-2 text-slate-500">
                  <span className={cn('w-2 h-2 rounded-full animate-pulse', tilt.dot)} /> live
                </span>
              ) : (
                <span className="inline-flex items-center gap-1.5 ml-2 text-amber-500" title="Breadth or ranking data is older than expected — showing the last available read.">
                  <span className="w-2 h-2 rounded-full bg-amber-500" /> stale
                  {recsQ.data?.ageMinutes != null && ` · rec ${recsQ.data.ageMinutes}m old`}
                </span>
              )}
            </div>
            <div className="mt-3 flex items-end gap-4 flex-wrap">
              <h1 className={cn('text-5xl md:text-6xl font-black tracking-tight leading-none', tilt.text)}>
                {tilt.label}
              </h1>
              <div className="pb-1.5 text-sm text-slate-400">
                intraday regime nowcast
                {dailyRegime && (
                  <span className="ml-2 text-slate-500">· daily HMM <b className="text-slate-300">{dailyRegime}</b></span>
                )}
              </div>
            </div>
            <p className="mt-3 max-w-xl text-sm text-slate-400 leading-relaxed">
              A separate ranker over intraday-classified screeners and the breakout edge, gated by a
              live breadth nowcast. Fully isolated from the positional book.
            </p>
          </div>

          {/* Breadth meter */}
          <div className="w-full lg:w-[340px] shrink-0">
            <div className="flex items-center justify-between text-[11px] font-bold font-display uppercase tracking-wider text-slate-400 mb-2">
              <span className="flex items-center gap-1.5"><Activity className="w-3.5 h-3.5" /> Market Breadth</span>
              {breadth && (
                <span className={breadthStale ? 'text-amber-500' : tilt.text}>
                  {(breadth.breadth_score * 100).toFixed(0)}<span className="text-slate-500">/100</span>
                  {breadthStale && breadthQ.data?.ageMinutes != null && (
                    <span className="ml-1.5 text-[10px] text-amber-500 normal-case tracking-normal">({breadthQ.data.ageMinutes}m old)</span>
                  )}
                </span>
              )}
            </div>
            {breadth ? (
              <>
                <div className="h-3 w-full rounded-full overflow-hidden bg-slate-800 flex">
                  <div className="h-full bg-emerald-500/80" style={{ width: `${(breadth.adv / Math.max(1, breadth.total)) * 100}%` }} />
                  <div className="h-full bg-slate-600" style={{ width: `${(breadth.unch / Math.max(1, breadth.total)) * 100}%` }} />
                  <div className="h-full bg-rose-500/80" style={{ width: `${(breadth.dec / Math.max(1, breadth.total)) * 100}%` }} />
                </div>
                <div className="mt-2 flex justify-between text-xs font-data">
                  <span className="text-emerald-400">▲ {breadth.adv} adv</span>
                  <span className="text-slate-500">{breadth.total} traded</span>
                  <span className="text-rose-400">{breadth.dec} dec ▼</span>
                </div>
                <div className="mt-1 text-xs text-slate-500">
                  avg move <b className={cn('font-data', breadth.avg_change_pct >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                    {breadth.avg_change_pct >= 0 ? '+' : ''}{n2(breadth.avg_change_pct)}%</b>
                </div>
              </>
            ) : (
              <div className="h-3 w-full rounded-full bg-slate-800 grid place-items-center">
                <span className="text-[10px] text-slate-500 -mt-4">no live breadth — market closed</span>
              </div>
            )}
          </div>
        </div>
      </div>

      {/* ── F&O read (NIFTY/BANKNIFTY PCR, max pain, key strikes) — same live positioning
          context Command Center shows, relevant here since intraday regime is index-driven */}
      <FnOIndexInsight />

      {/* ── KPI strip ───────────────────────────────────────────────────── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <Kpi icon={Flame} label="Buy Setups" value={n0(buyCount)} accent="text-cyan-300" sub="ranked long" />
        <Kpi icon={Target} label="Sized Names" value={n0(sized.length)} accent="text-emerald-300" sub="book allocated" />
        <Kpi icon={Gauge} label="Avg R:R" value={avgRR ? avgRR.toFixed(2) : '—'} accent="text-amber-300" sub="target ÷ stop" />
        <Kpi icon={Radio} label="Ranked" value={n0(rows.length)} accent="text-slate-200" sub="intraday universe" />
      </div>

      {/* ── Emission gate status (both directions) ─────────────────────────
          The engine only publishes an actionable Buy/Sell while ITS OWN trailing realised
          PnL over the last 10 sessions is positive on a large-enough sample -- otherwise the
          row is downgraded to Hold. Without this badge, a page full of Hold looks identical
          to "nothing is happening" and "the engine is protecting you from a currently
          unprofitable setup" -- there was no way to tell the two apart. */}
      {(() => {
        const gate = gateQ.data as EmissionGateStatus | null | undefined;
        if (!gate) return null;
        const side = (label: string, s: EmissionGateSide) => (
          <div className={cn('rounded-xl ring-1 p-3 flex items-center justify-between gap-3',
            s.open ? 'ring-emerald-400/25 bg-emerald-500/[0.06]' : 'ring-amber-400/25 bg-amber-500/[0.06]')}>
            <div className="min-w-0">
              <div className="flex items-center gap-1.5 text-[10px] font-black font-display uppercase tracking-widest text-slate-500">
                {label} Gate
                <span className={cn('w-1.5 h-1.5 rounded-full', s.open ? 'bg-emerald-400' : 'bg-amber-400')} />
              </div>
              <div className={cn('text-sm font-bold', s.open ? 'text-emerald-300' : 'text-amber-300')}>
                {s.open ? 'OPEN' : 'CLOSED — Buy/Sell downgraded to Hold'}
              </div>
              <div className="text-[11px] text-slate-500 truncate" title={s.reason ?? undefined}>{s.reason ?? '—'}</div>
            </div>
            {s.avg_pnl_pct != null && (
              <div className="shrink-0 text-right">
                <div className={cn('text-lg font-black tabular-nums', s.avg_pnl_pct >= 0 ? 'text-emerald-300' : 'text-rose-300')}>
                  {s.avg_pnl_pct >= 0 ? '+' : ''}{s.avg_pnl_pct.toFixed(2)}%
                </div>
                <div className="text-[10px] text-slate-600">{s.n_trades} trades / 10d</div>
              </div>
            )}
          </div>
        );
        return (
          <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
            {side('Long', gate.long)}
            {side('Short', gate.short)}
          </div>
        );
      })()}

      {/* ── Backtest accuracy (paper-trade outcomes, last 30d) ──────────── */}
      {(() => {
        const a = accuracyQ.data?.overall as { total?: number; wins?: number; losses?: number; avg_pnl?: number; total_pnl?: number } | undefined;
        const total = Number(a?.total ?? 0);
        if (!total) {
          return (
            <div className="v1-card px-5 py-4 text-sm text-slate-500 flex items-center gap-2">
              <Gauge className="w-4 h-4" /> Paper-trade accuracy accrues after market close — no resolved intraday trades yet.
            </div>
          );
        }
        const wins = Number(a?.wins ?? 0);
        const winRate = (wins / total) * 100;
        const avgPnl = Number(a?.avg_pnl ?? 0);
        const totalPnl = Number(a?.total_pnl ?? 0);
        const pos = avgPnl >= 0;
        return (
          <div className="v1-card p-4 grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <div className="text-[10px] font-display uppercase tracking-widest text-slate-500 font-bold">Win Rate (30d)</div>
              <div className={cn('text-2xl font-black tabular-nums', winRate >= 50 ? 'text-emerald-300' : 'text-amber-300')}>{winRate.toFixed(1)}%</div>
              <div className="text-[10px] text-slate-600">{wins}W / {Number(a?.losses ?? 0)}L of {total}</div>
            </div>
            <div>
              <div className="text-[10px] font-display uppercase tracking-widest text-slate-500 font-bold">Avg P&amp;L / trade</div>
              <div className={cn('text-2xl font-black tabular-nums', pos ? 'text-emerald-300' : 'text-rose-300')}>{pos ? '+' : ''}{avgPnl.toFixed(2)}%</div>
              <div className="text-[10px] text-slate-600">paper, entry→exit</div>
            </div>
            <div>
              <div className="text-[10px] font-display uppercase tracking-widest text-slate-500 font-bold">Cumulative P&amp;L</div>
              <div className={cn('text-2xl font-black tabular-nums', totalPnl >= 0 ? 'text-emerald-300' : 'text-rose-300')}>{totalPnl >= 0 ? '+' : ''}{totalPnl.toFixed(1)}%</div>
              <div className="text-[10px] text-slate-600">sum of resolved trades</div>
            </div>
            <div>
              <div className="text-[10px] font-display uppercase tracking-widest text-slate-500 font-bold">Resolved Trades</div>
              <div className="text-2xl font-black tabular-nums text-slate-200">{total}</div>
              <div className="text-[10px] text-slate-600">EOD paper-traded</div>
            </div>
          </div>
        );
      })()}

      {/* ── Controls ────────────────────────────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[200px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
          <input
            value={query} onChange={e => setQuery(e.target.value)} placeholder="Filter symbol…"
            className="w-full bg-slate-900/70 border border-slate-800 rounded-xl pl-9 pr-3 py-2 text-sm text-slate-200 placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-cyan-500/30"
          />
        </div>
        <button
          onClick={() => setBuysOnly(v => !v)}
          className={cn('px-3.5 py-2 rounded-xl text-xs font-bold font-display uppercase tracking-wider ring-1 transition-colors',
            buysOnly ? 'bg-emerald-500/15 text-emerald-300 ring-emerald-400/30' : 'bg-slate-900/70 text-slate-400 ring-slate-800')}
        >
          {buysOnly ? 'Longs only' : 'All setups'}
        </button>
        <div className="flex items-center gap-1 bg-slate-900/70 border border-slate-800 rounded-xl p-1">
          {([['intraday_score', 'Score'], ['breakout_score', 'Breakout'], ['risk_reward', 'R:R'], ['position_size_pct', 'Size']] as [SortKey, string][]).map(([k, lbl]) => (
            <button key={k} onClick={() => setSortKey(k)}
              className={cn('px-3 py-1.5 rounded-lg text-[11px] font-bold font-display uppercase tracking-wider flex items-center gap-1 transition-colors',
                sortKey === k ? 'bg-cyan-500/15 text-cyan-300' : 'text-slate-500 hover:text-slate-300')}>
              <ArrowUpDown className="w-3 h-3" /> {lbl}
            </button>
          ))}
        </div>
      </div>

      {/* ── Ranking table ───────────────────────────────────────────────── */}
      <div className="v1-card overflow-hidden">
        <div className="overflow-x-auto">
          <table className="w-full text-sm min-w-[880px]">
            <thead>
              <tr className="text-[10px] font-display uppercase tracking-widest text-slate-500 bg-slate-900/70 border-b border-slate-800">
                <th className="text-left font-bold px-4 py-3 w-10">#</th>
                <th className="text-left font-bold px-2 py-3">Symbol</th>
                <th className="text-left font-bold px-2 py-3">Setup</th>
                <th className="text-right font-bold px-2 py-3">Score</th>
                <th className="text-right font-bold px-2 py-3">Breakout</th>
                <th className="text-right font-bold px-2 py-3">LTP</th>
                <th className="text-right font-bold px-2 py-3">Target</th>
                <th className="text-right font-bold px-2 py-3">Stop</th>
                <th className="text-right font-bold px-2 py-3">R:R</th>
                <th className="text-right font-bold px-4 py-3">Size</th>
                <th className="w-8" />
              </tr>
            </thead>
            <tbody>
              {recsQ.isLoading && (
                <tr><td colSpan={11} className="px-4 py-16 text-center text-slate-500">Loading intraday ranking…</td></tr>
              )}
              {!recsQ.isLoading && filtered.length === 0 && (
                <tr><td colSpan={11} className="px-4 py-16 text-center text-slate-500">
                  <ShieldAlert className="w-6 h-6 mx-auto mb-2 text-slate-600" />
                  No intraday setups — the ranker publishes during market hours.
                </td></tr>
              )}
              {filtered.map((r, i) => {
                const clsStyle = CLS[(r.classification as keyof typeof CLS)] ?? CLS.Hold;
                const up = (r.classification ?? '').includes('Buy');
                return (
                  <tr key={r.symbol}
                    onClick={() => onSelectStock(r.symbol)}
                    className="group border-b border-slate-800/60 hover:bg-slate-800/40 cursor-pointer transition-colors">
                    <td className="px-4 py-3 text-slate-600 font-data text-xs">{i + 1}</td>
                    <td className="px-2 py-3">
                      <div className="flex items-center gap-2">
                        <span className="font-bold text-slate-100">{r.symbol}</span>
                        {(r.breakout_score ?? 0) >= 60 && <Flame className="w-3.5 h-3.5 text-orange-400" />}
                      </div>
                      <div className="text-[10px] text-slate-500">
                        {n0(r.bullish_count)}▲ / {n0(r.bearish_count)}▼ signals
                      </div>
                    </td>
                    <td className="px-2 py-3">
                      <span className={cn('inline-flex px-2 py-1 rounded-md text-[10px] font-black font-display uppercase tracking-wide ring-1', clsStyle)}>
                        {r.classification ?? 'Hold'}
                      </span>
                    </td>
                    <td className="px-2 py-3 text-right">
                      <div className="inline-flex items-center gap-2 justify-end">
                        <div className="w-14 h-1.5 rounded-full bg-slate-800 overflow-hidden hidden md:block">
                          <div className={cn('h-full', tilt.bar)} style={{ width: `${Math.min(100, r.intraday_score ?? 0)}%` }} />
                        </div>
                        <span className="font-data font-bold text-slate-100 tabular-nums">{n2(r.intraday_score)}</span>
                      </div>
                    </td>
                    <td className="px-2 py-3 text-right font-data text-slate-300 tabular-nums">{r.breakout_score == null ? '—' : `${Math.round(r.breakout_score)}%`}</td>
                    <td className="px-2 py-3 text-right font-data text-slate-200 tabular-nums">{n2(r.cmp)}</td>
                    <td className="px-2 py-3 text-right font-data text-emerald-400 tabular-nums">{n2(r.target_1)}</td>
                    <td className="px-2 py-3 text-right font-data text-rose-400 tabular-nums">{n2(r.stop_loss)}</td>
                    <td className="px-2 py-3 text-right font-data text-amber-300 tabular-nums">{r.risk_reward == null ? '—' : `${n2(r.risk_reward)}×`}</td>
                    <td className="px-4 py-3 text-right">
                      {(r.position_size_pct ?? 0) > 0
                        ? <span className={cn('font-data font-bold tabular-nums', up ? 'text-emerald-300' : 'text-slate-300')}>{n2(r.position_size_pct)}%</span>
                        : <span className="text-slate-600">—</span>}
                    </td>
                    <td className="pr-3"><ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-slate-400 transition-colors" /></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>

      <p className="text-[11px] text-slate-600 flex items-center gap-1.5">
        <TrendingUp className="w-3 h-3" /> Intraday ranking refreshes every 15&nbsp;min during market hours ·
        entries/stops are intraday-scaled ATR barriers · sized on the validated breakout edge.
      </p>
    </div>
  );
};

const Kpi: React.FC<{ icon: React.ElementType; label: string; value: string; accent: string; sub: string }> =
  ({ icon: Icon, label, value, accent, sub }) => (
  <div className={cn(accent.includes('emerald') ? 'v1-card-up' : accent.includes('rose') ? 'v1-card-down' : 'v1-card-neutral', 'p-4 flex items-center gap-4')}>
    <div className="w-11 h-11 rounded-xl bg-slate-800/70 grid place-items-center shrink-0">
      <Icon className={cn('w-5 h-5', accent)} />
    </div>
    <div className="min-w-0">
      <div className="text-[10px] font-display uppercase tracking-widest text-slate-500 font-bold">{label}</div>
      <div className={cn('text-2xl font-black tabular-nums leading-tight', accent)}>{value}</div>
      <div className="text-[10px] text-slate-600">{sub}</div>
    </div>
  </div>
);

export default IntradayPage;
