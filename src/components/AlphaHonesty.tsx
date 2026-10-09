import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { deriveCallState, publishedTier, type ForwardTestReport } from '../lib/callState';
import { formatCr } from '../lib/format';
import { relativeFromNow } from '../lib/timeFormat';

// Alpha-page honesty surfaces (spec 2026-10-08 section 2.D). Daily-cadence data: no polling.
const DAILY = { staleTime: 30 * 60_000, refetchOnWindowFocus: false } as const;

export function EdgeCallBanner() {
  const { data } = trpc.getEdgeStatus.useQuery(undefined, DAILY);
  const ft = data?.forwardTest as ForwardTestReport | null | undefined;
  const call = deriveCallState(ft, data?.scorecard as Record<string, unknown> | null | undefined);
  const tier = publishedTier(ft);
  const tone = call.state === 'EDGE'
    ? 'border-sky-500/30 bg-sky-500/[0.06] text-sky-100'
    : 'border-amber-500/40 bg-amber-500/[0.08] text-amber-100';
  return (
    <div className={cn('mt-3 rounded-lg border px-3 py-2 text-[11px]', tone)} role="status" aria-live="polite">
      <div className="font-semibold text-[12px]">
        {call.state === 'EDGE' ? 'Measured edge on the published list' : call.state === 'NO_CALL' ? 'No call today' : 'No verified edge yet'}
      </div>
      <p className="mt-0.5">{call.message} Scores are ranks, not probabilities.</p>
      <p className="mt-1 text-[10px] opacity-75">
        Source: frozen forward test{ft?.protocol_hash ? ` (protocol ${ft.protocol_hash.slice(0, 8)})` : ''},
        published tier, 5-session horizon, 0.25% cost per side
        {tier ? ` · ${tier.eff_dates ?? 0} of ${data?.minIndependentWindows ?? 20} independent windows` : ' · no report persisted'}
        {data?.calendarBlockedUntil?.['5'] && call.state === 'UNPROVEN' ? ` · calendar-blocked until about ${data.calendarBlockedUntil['5']}` : ''}
        {data?.forwardTestAsOf ? ` · as of ${relativeFromNow(data.forwardTestAsOf)}` : ''}
      </p>
    </div>
  );
}

function SymList({ title, rows, render }: { title: string; rows: any[]; render: (r: any) => string }) {
  return (
    <div>
      <div className="text-[10px] uppercase tracking-wide text-slate-500 mb-1">{title} ({rows.length})</div>
      {rows.length === 0 ? <div className="text-[11px] text-slate-600">none</div> : (
        <div className="flex flex-wrap gap-1">
          {rows.slice(0, 12).map(r => (
            <span key={r.symbol} className="px-1.5 py-0.5 rounded border border-slate-700 text-[10px] text-slate-300" title={render(r)}>
              {r.symbol}
            </span>
          ))}
          {rows.length > 12 && <span className="text-[10px] text-slate-500">+{rows.length - 12} more</span>}
        </div>
      )}
    </div>
  );
}

export function WhatChangedCard() {
  const { data, isError } = trpc.getWhatChanged.useQuery(undefined, DAILY);
  if (isError) return <div className="v1-card p-3 text-[11px] text-rose-400" role="alert">Could not load what changed.</div>;
  if (!data?.previous) return null;
  return (
    <section className="v1-card p-3" aria-label="What changed since the previous ranker run">
      <div className="flex items-baseline gap-2 mb-2 flex-wrap">
        <h2 className="v1-title-section">What changed since {data.previous}</h2>
        <span className="text-[10px] text-slate-500">
          ranker {data.previous} → {data.latest} · Buy/Strong Buy {data.counts.previousBuys} → {data.counts.latestBuys} · source unified_recommendations
        </span>
      </div>
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
        <SymList title="New Buy / Strong Buy" rows={data.newBuys} render={r => `${r.from ?? 'not ranked'} → ${r.to}`} />
        <SymList title="Dropped from Buy" rows={data.dropped} render={r => `${r.from} → ${r.to ?? 'not ranked'}`} />
        <SymList title="Classification flips" rows={data.flips} render={r => `${r.from} → ${r.to}`} />
        <SymList title="Plans expired" rows={data.expiredPlans} render={r => `valid until ${r.valid_until}`} />
      </div>
      <p className="mt-2 text-[10px] text-slate-500">Changes in rank, not evidence of edge.</p>
    </section>
  );
}

function Pulse({ label, value, sub, title }: { label: string; value: string; sub: string; title?: string }) {
  return (
    <div className="flex flex-col px-2.5 py-1 rounded-md bg-slate-800/60 border border-slate-700/50 min-w-0" title={title}>
      <span className="text-[9px] uppercase tracking-wide text-slate-500">{label}</span>
      <span className="text-[12px] font-semibold text-slate-200 tabular-nums">{value}</span>
      <span className="text-[9px] text-slate-500 truncate">{sub}</span>
    </div>
  );
}

export function MarketPulseStrip() {
  const { data } = trpc.getMarketPulse.useQuery(undefined, DAILY);
  if (!data) return null;
  const b = data.breadth;
  const f = data.fiiDii;
  return (
    <div className="flex flex-wrap gap-2 mt-3" aria-label="Market pulse">
      <Pulse label="Advance / decline" value={b ? `${b.advances} / ${b.declines}` : '—'}
        sub={b ? `NSE equities, close ${b.asOf} vs ${b.vsDate}` : 'no data'} title={b?.source} />
      <Pulse label="India VIX" value={data.vix ? data.vix.value.toFixed(2) : '—'}
        sub={data.vix ? `as of ${relativeFromNow(data.vix.asOf)}` : 'no data'} title={data.vix?.source} />
      <Pulse label="FII / DII net (cash)" value={f ? `${formatCr(f.fii_net * 1e7)} / ${formatCr(f.dii_net * 1e7)}` : '—'}
        sub={f ? `${f.date}` : 'no data'} title="fii_dii_flow, Rs crore" />
      <Pulse label="Nifty 50 vs 200-day mean" value={data.regime ? `${data.regime.label} (${data.regime.distPct >= 0 ? '+' : ''}${data.regime.distPct.toFixed(1)}%)` : '—'}
        sub={data.regime ? `close ${data.regimeAsOf}; objective rule, not the HMM` : `only ${data.regimeSessions} sessions (needs 200)`}
        title="Index close vs mean of its last 200 closes (stock_ohlcv NIFTY50). A description of the tape, not a forecast." />
    </div>
  );
}
