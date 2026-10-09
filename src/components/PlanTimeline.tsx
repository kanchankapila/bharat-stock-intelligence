import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';

// Per-stock ranker plan lifecycle: generated -> entry zone -> valid until -> first touch of T1/SL
// (from stock_ohlcv highs/lows) or expiry. A CSS timeline on purpose: no chart library needed.
const rs = (x: number | null | undefined) => (x == null ? '—' : `₹${x.toFixed(2)}`);
const TOUCH: Record<string, { text: (d: string | null) => string; cls: string }> = {
  T1:        { text: d => `T1 hit ${d}`, cls: 'text-emerald-400 border-emerald-500/40' },
  SL:        { text: d => `stop hit ${d}`, cls: 'text-rose-400 border-rose-500/40' },
  EXPIRED:   { text: () => 'expired untouched', cls: 'text-amber-400 border-amber-500/40' },
  OPEN:      { text: () => 'open', cls: 'text-sky-400 border-sky-500/40' },
  NO_LEVELS: { text: () => 'no stop/target', cls: 'text-slate-500 border-slate-600/40' },
};

export function PlanTimeline({ symbol }: { symbol: string }) {
  const { data, isError } = trpc.getPlanTimeline.useQuery({ symbol, limit: 10 }, { staleTime: 30 * 60_000, refetchOnWindowFocus: false });
  if (isError) return <div className="v1-card p-3 text-rose-400 text-sm" role="alert">Could not load the plan history.</div>;
  if (!data || data.plans.length === 0) return null;
  return (
    <section className="v1-card p-4" aria-label="Plan lifecycle">
      <h3 className="v1-title-section">Plan lifecycle (last {data.plans.length} ranker runs)</h3>
      <p className="text-[10px] text-slate-500 mt-1 mb-3">
        Source: unified_recommendations plans; first touch from stock_ohlcv daily high/low after the plan day, assuming a fill in the
        entry zone (a bar touching both counts as the stop). This is not a graded trade and is gross of costs.
        {data.lastBar ? ` Prices through ${data.lastBar.date}.` : ''}
      </p>
      <ol className="space-y-2">
        {data.plans.map((p: any) => {
          const t = TOUCH[p.firstTouch.result] ?? TOUCH.OPEN;
          return (
            <li key={p.computed_at} className="border-l-2 border-slate-700 pl-3">
              <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[11px] text-slate-300">
                <span className="font-semibold text-white">{p.computed_at}</span>
                <span>{p.classification ?? '—'}{p.timeframe ? ` · ${p.timeframe}` : ''} · rank score {p.unified_score?.toFixed?.(0) ?? '—'}</span>
                <span>entry {p.entry_zone_low != null ? `₹${p.entry_zone_low.toFixed(2)}–${p.entry_zone_high?.toFixed(2) ?? '—'}` : '—'}</span>
                <span className="text-rose-300">SL {rs(p.stop_loss)}</span>
                <span className="text-emerald-300">T1 {rs(p.target_1)}</span>
                <span className="text-slate-500">valid until {p.valid_until ? String(p.valid_until).slice(0, 16) : '—'} UTC</span>
                <span className={cn('px-1.5 py-0.5 rounded border', t.cls)}>{t.text(p.firstTouch.date)}</span>
              </div>
              {p.signalOutcomes.length > 0 && (
                <div className="text-[10px] text-slate-500 mt-0.5">
                  Same-day graded signals: {p.signalOutcomes.map((o: any) =>
                    `${o.signal_source} ${o.horizon_days}d: ${o.outcome ?? 'n/a'}${o.return_pct != null ? ` ${o.return_pct >= 0 ? '+' : ''}${o.return_pct.toFixed(2)}%` : ''}${o.exit_reason ? ` (${o.exit_reason})` : ''}`).join(' · ')}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </section>
  );
}
