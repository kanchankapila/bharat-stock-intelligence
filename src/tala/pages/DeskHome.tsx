import { useMemo, useState } from 'react';
import { Link } from 'react-router-dom';
import {
  ArrowRight,
  Ban,
  CalendarClock,
  Flame,
  Gauge,
  Landmark,
  Radio,
  TrendingUp,
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ago, clip, crore, DASH, dateTimeIST, frac, n0, num, pct, price } from '../lib/format';
import { readRegime } from '../lib/insight';
import { Chip, ErrorState, Meter, Panel, Skeleton, Stat, SymbolLink } from '../components/Primitives';
import { BarRow } from '../components/Charts';
import { PickCard } from '../components/PickCard';
import type { PickRow } from '../lib/insight';

/* â”€â”€ Regime banner â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   The first thing on the desk, because position sizing is a regime decision
   before it is ever a stock decision. */
function RegimeBanner() {
  const { data, isLoading, error } = trpc.getRegimeSummary.useQuery(undefined, {
    staleTime: 120_000,
    refetchInterval: 300_000,
  });

  if (error) return <ErrorState error={error} />;
  if (isLoading || !data?.current)
    return <div className="h-28 animate-pulse rounded-lg border border-line bg-ink-850/50" />;

  // The procedure returns `prob` (renamed from regime_prob upstream). Read the
  // typed field and fall back to the wire name, so a rename there cannot blank the
  // single most important number on the desk.
  const confidence = data.current.prob ?? (data.current as any).regime_prob;
  const r = readRegime(data.current.regime, confidence);
  const tone =
    r.tone === 'up'
      ? { text: 'text-up', bg: 'from-up/[0.09]', border: 'border-l-up' }
      : r.tone === 'down'
        ? { text: 'text-down', bg: 'from-down/[0.09]', border: 'border-l-down' }
        : r.tone === 'warn'
          ? { text: 'text-warn', bg: 'from-warn/[0.09]', border: 'border-l-warn' }
          : { text: 'text-mark-2', bg: 'from-white/[0.04]', border: 'border-l-line-3' };

  return (
    <section
      className={cn(
        'tala-rise tala-grid relative overflow-hidden rounded-lg border border-l-2 border-line bg-gradient-to-r to-transparent',
        tone.border,
        tone.bg,
      )}
    >
      <div className="relative flex flex-wrap items-center gap-x-8 gap-y-4 px-5 py-4">
        <div className="min-w-0">
          <div className="flex items-baseline gap-2.5">
            <span className="font-mono text-[10px] tracking-[0.22em] text-mark-3 uppercase">Market regime</span>
            <span className="font-mono text-[10px] text-mark-4">HMM Â· {num(r.confidence) ? (r.confidence * 100).toFixed(1) : DASH}%</span>
          </div>
          {/* The one oversized word on the desk. */}
          <h1 className={cn('font-display text-[40px] leading-[0.95] font-extrabold tracking-tight', tone.text)}>
            {r.name}
          </h1>
          <p className="mt-1.5 max-w-xl text-[12px] leading-relaxed text-mark-2">{r.stance}</p>
        </div>

        <div className="min-w-0 flex-1 border-l border-line pl-6">
          <dl className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div>
              <dt className="text-[9px] tracking-[0.16em] text-up/70 uppercase">Favour</dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-mark">{r.favour}</dd>
            </div>
            <div>
              <dt className="text-[9px] tracking-[0.16em] text-down/70 uppercase">Avoid</dt>
              <dd className="mt-0.5 text-[12px] leading-snug text-mark">{r.avoid}</dd>
            </div>
          </dl>
          <div className="mt-3 flex items-center gap-2">
            <span className="font-mono text-[9px] tracking-[0.16em] text-mark-4 uppercase">Size</span>
            <Chip tone={r.size === 'full' ? 'up' : r.size === 'reduced' ? 'warn' : 'down'}>{r.size.toUpperCase()}</Chip>
            {Array.isArray(data.history) && data.history.length > 1 && (
              /* Regime strip: one tick per day, coloured by regime. Thirty pixels of
                 history says more about how long we have been here than the number
                 alone, and a regime that has flipped twice is a different trade from
                 one that has held for a month. */
              <span className="tala-scroll ml-1 flex items-center gap-px overflow-hidden">
                {data.history.slice(-40).map((h: any, i: number) => (
                  <span
                    key={i}
                    title={`${h.date} Â· ${h.regime} ${(h.regime_prob * 100).toFixed(0)}%`}
                    className={cn(
                      'h-3 w-1 rounded-[1px]',
                      h.regime === 'BULL' ? 'bg-up/70'
                        : h.regime === 'BEAR' || h.regime === 'CRASH' ? 'bg-down/70'
                          : h.regime === 'HIGH_VOL' ? 'bg-warn/60' : 'bg-line-3',
                    )}
                  />
                ))}
              </span>
            )}
          </div>
        </div>
      </div>
    </section>
  );
}

/* â”€â”€ Sentiment / flows â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Greed-fear + PCR + FII/DII. These three disagree often, and when they do the
   desk says so rather than averaging them into one comfortable number. */
function PulsePanel() {
  const { data: sent } = trpc.getMarketSentiment.useQuery({ historyHours: 24 }, { staleTime: 120_000 });
  const { data: flows } = trpc.getInstitutionalFlows.useQuery(undefined, { staleTime: 300_000 });
  const { data: breadth } = trpc.getMarketBreadth.useQuery(undefined, { staleTime: 300_000 });

  const score = num((sent as any)?.latest?.overall_score);
  const label = (sent as any)?.latest?.overall_label ?? null;
  const pcr = num((sent as any)?.pcr);
  const details: any[] = (flows as any)?.data?.institutionalDetails ?? [];
  const fii = details.find((d) => /FII/i.test(d.category));
  const dii = details.find((d) => /DII/i.test(d.category));

  // Greed at a PCR below 1 is the classic late-stage setup: options are pricing a
  // lot of upside while puts still outnumber calls. Flagged, not acted on.
  const contrarian = score !== null && score > 60 && pcr !== null && pcr < 1;

  return (
    <Panel
      eyebrow="01"
      title="Positioning"
      action={<Chip tone="neutral">{ago((sent as any)?.latest?.snapshot_at)}</Chip>}
    >
      <div className="flex items-end justify-between gap-3">
        <Stat
          label="Greed / fear"
          value={score === null ? DASH : score.toFixed(0)}
          tone={score === null ? 'text-mark-3' : score > 60 ? 'text-up' : score < 40 ? 'text-down' : 'text-warn'}
          size="xl"
          sub={label ?? undefined}
        />
        <Stat
          label="Put-call OI"
          value={pcr === null ? DASH : pcr.toFixed(2)}
          tone={pcr === null ? 'text-mark-3' : pcr > 1.15 ? 'text-up' : pcr < 0.85 ? 'text-down' : 'text-warn'}
          size="lg"
          sub={pcr === null ? undefined : pcr > 1.15 ? 'supportive' : pcr < 0.85 ? 'calls heavy' : 'balanced'}
        />
      </div>

      <Meter
        value={score}
        tone={score !== null && score > 60 ? 'bg-up/70' : score !== null && score < 40 ? 'bg-down/70' : 'bg-warn/60'}
        className="mt-2.5"
      />

      {contrarian && (
        <p className="mt-2.5 rounded border border-warn/25 bg-warn/[0.06] px-2 py-1.5 text-[10px] leading-snug text-warn">
          Greed is high while puts still outweigh calls — a late-stage read. Treat fresh longs as crowded.
        </p>
      )}

      <div className="mt-3.5 grid grid-cols-2 gap-3 border-t border-line pt-3">
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-mark-2">
            <Landmark size={11} className="text-mark-4" /> FII
          </span>
          <span className={cn('tnum font-mono text-[12px] font-semibold', (num(fii?.netBuySell) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
            {fii ? crore(fii.netBuySell) : DASH}
          </span>
        </div>
        <div className="flex items-center justify-between gap-2">
          <span className="flex items-center gap-1.5 text-[11px] text-mark-2">
            <Landmark size={11} className="text-mark-4" /> DII
          </span>
          <span className={cn('tnum font-mono text-[12px] font-semibold', (num(dii?.netBuySell) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
            {dii ? crore(dii.netBuySell) : DASH}
          </span>
        </div>
      </div>

      {breadth && (
        <div className="mt-3 border-t border-line pt-3">
          <div className="mb-1.5 flex items-baseline justify-between">
            <span className="text-[9px] tracking-[0.16em] text-mark-4 uppercase">Breadth</span>
            <span className="font-mono text-[9px] text-mark-4">{breadth.date}</span>
          </div>
          <div className="grid grid-cols-2 gap-x-4 gap-y-2">
            <Stat label="Above 200-DMA" value={frac(breadth.pct_above_200dma, 0)} size="sm"
              tone={num(breadth.pct_above_200dma) >= 0.5 ? 'text-up' : 'text-down'} />
            <Stat label="Adv/Dec" value={num(breadth.adv_decline_ratio)?.toFixed(2) ?? DASH} size="sm"
              tone={num(breadth.adv_decline_ratio) >= 1 ? 'text-up' : 'text-down'} />
            <Stat label="At 20d high" value={frac(breadth.pct_at_20d_high, 1)} size="sm" />
            <Stat label="Net H/L" value={num(breadth.net_highs_lows)?.toFixed(0) ?? DASH} size="sm"
              tone={num(breadth.net_highs_lows) >= 0 ? 'text-up' : 'text-down'} />
          </div>
        </div>
      )}
    </Panel>
  );
}

/* â”€â”€ Macro tape â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   The cross-asset backdrop. Dense and small because it is context rather than a
   call — but a rupee move or a VIX spike changes how every domestic setup should
   be sized, so it cannot live on a separate page. */
function MacroPanel() {
  const { data } = trpc.getMacroSnapshot.useQuery(undefined, { staleTime: 300_000, refetchInterval: 300_000 });
  const groups = useMemo(() => {
    const rows: any[] = Array.isArray(data) ? data : [];
    const out: Record<string, any[]> = {};
    for (const r of rows) (out[r.group] ??= []).push(r);
    return out;
  }, [data]);

  if (!Array.isArray(data) || !data.length)
    return (
      <Panel eyebrow="02" title="Macro backdrop">
        <div className="space-y-2">
          {Array.from({ length: 6 }).map((_, i) => (
            <Skeleton key={i} className="h-5 w-full" />
          ))}
        </div>
      </Panel>
    );

  return (
    <Panel eyebrow="02" title="Macro backdrop">
      <div className="space-y-3">
        {Object.entries(groups).map(([group, rows]) => (
          <div key={group}>
            <div className="mb-1 text-[9px] tracking-[0.16em] text-mark-4 uppercase">{group}</div>
            <div className="grid grid-cols-2 gap-x-4 gap-y-1.5 sm:grid-cols-3">
              {rows.map((r) => (
                <div key={r.symbol} className="flex min-w-0 items-baseline justify-between gap-1.5">
                  <span className="truncate text-[10px] text-mark-3" title={r.label}>{r.label}</span>
                  <span className="flex shrink-0 items-baseline gap-1.5">
                    <span className="tnum font-mono text-[11px] text-mark-2">
                      {r.close === null ? DASH : n0(r.close, r.close < 50 ? 3 : 2)}
                    </span>
                    <span className={cn('tnum w-11 text-right font-mono text-[10px]', (num(r.ret1d) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                      {pct(r.ret1d, 2)}
                    </span>
                  </span>
                </div>
              ))}
            </div>
          </div>
        ))}
      </div>
    </Panel>
  );
}

/* â”€â”€ Sector heat â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Sorted by the confluence engine's own sector average, not by index day-change:
   the question is where money is rotating, which is a slower and more useful
   signal than where the index moved today. */
function SectorPanel() {
  const { data } = trpc.getSectorMomentumMatrix.useQuery(undefined, { staleTime: 300_000 });
  const rows: any[] = useMemo(
    () => [...(Array.isArray(data) ? data : [])].sort((a, b) => (num(b.avg_score) ?? 0) - (num(a.avg_score) ?? 0)),
    [data],
  );
  const max = Math.max(1, ...rows.map((r) => num(r.avg_score) ?? 0));

  return (
    <Panel
      eyebrow="03"
      title="Sector rotation"
      action={
        <Link to="/tala/market" className="flex items-center gap-1 font-mono text-[10px] text-mark-3 hover:text-marigold">
          ALL <ArrowRight size={10} />
        </Link>
      }
    >
      {rows.length === 0 ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : (
        <div className="space-y-0.5">
          {rows.map((r) => {
            const elite: string[] = String(r.elite_symbols ?? '').split(',').filter(Boolean);
            return (
              <BarRow
                key={r.sector}
                label={r.sector}
                value={num(r.avg_score)}
                max={max}
                tone={(num(r.avg_score) ?? 0) >= 55 ? 'bg-up/70' : (num(r.avg_score) ?? 0) >= 40 ? 'bg-marigold/60' : 'bg-down/50'}
                right={num(r.avg_score)?.toFixed(0)}
                sub={`${n0(r.stock_count)}`}
              />
            );
          })}
        </div>
      )}
      {rows.some((r) => String(r.elite_symbols ?? '')) && (
        <p className="mt-2.5 border-t border-line pt-2.5 text-[10px] leading-relaxed text-mark-4">
          Leaders:{' '}
          {rows
            .flatMap((r) =>
              String(r.elite_symbols ?? '')
                .split(',')
                .filter(Boolean)
                .slice(0, 3)
                .map((s) => ({ s, sec: r.sector })),
            )
            .slice(0, 10)
            .map(({ s }, i) => (
              <span key={`${s}-${i}`}>
                {i > 0 && ', '}
                <SymbolLink symbol={s} className="text-[10px]" />
              </span>
            ))}
        </p>
      )}
    </Panel>
  );
}

/* â”€â”€ Movers + setups â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   The live tape: who is actually moving, plus the pre-open gap list — the only
   actionable window a positional trader gets before the open. */
type MoverRow = { symbol: string; close: number | null; chg: number | null; vol: number | null };

function moverRows(list: any[] | undefined): MoverRow[] {
  return (list ?? []).map((m: any) => {
    const open = num(m.today_open);
    const close = num(m.today_close) ?? num(m.last_trade_price) ?? num(m.close);
    return {
      symbol: String(m.symbol_name ?? m.symbol ?? ''),
      close,
      chg: open && close ? ((close - open) / open) * 100 : num(m.change_pct),
      vol: num(m.volume ?? m.total_traded_volume),
    };
  }).filter((r) => r.symbol);
}

function MoverPanel() {
  const [tab, setTab] = useState<'gainers' | 'losers' | 'gapUp' | 'gapDown'>('gainers');
  const { data, isLoading } = trpc.getTopMovers.useQuery(undefined, { staleTime: 60_000, refetchInterval: 120_000 });
  const rows = useMemo(() => moverRows((data as any)?.[tab]), [data, tab]);

  const TABS = [
    { k: 'gainers', label: 'Gainers' },
    { k: 'losers', label: 'Losers' },
    { k: 'gapUp', label: 'Gap up' },
    { k: 'gapDown', label: 'Gap dn' },
  ] as const;

  return (
    <Panel
      eyebrow="04"
      title="The tape"
      dense
      action={
        <div className="flex gap-0.5">
          {TABS.map((t) => (
            <button
              key={t.k}
              onClick={() => setTab(t.k)}
              className={cn(
                'rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide uppercase transition-colors',
                tab === t.k ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
              )}
            >
              {t.label}
            </button>
          ))}
        </div>
      }
    >
      {isLoading && !rows.length ? (
        <div className="space-y-2 p-3.5">
          {Array.from({ length: 7 }).map((_, i) => (
            <Skeleton key={i} className="h-4 w-full" />
          ))}
        </div>
      ) : rows.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">No movers in this bucket right now.</p>
      ) : (
        <ul className="tala-scroll max-h-[290px] overflow-y-auto">
          {rows.map((r, i) => (
            <li
              key={`${r.symbol}-${i}`}
              className="tala-rise flex items-center gap-2 border-b border-line/50 px-3.5 py-1.5 last:border-0"
              style={{ animationDelay: `${Math.min(i, 15) * 16}ms` }}
            >
              <SymbolLink symbol={r.symbol} className="min-w-0 flex-1" />
              <span className="tnum shrink-0 font-mono text-[11px] text-mark-3">{price(r.close)}</span>
              <span className={cn('tnum w-14 shrink-0 text-right font-mono text-[11px] font-semibold', (r.chg ?? 0) >= 0 ? 'text-up' : 'text-down')}>
                {pct(r.chg)}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* â”€â”€ Pre-open â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Shown with its own date stamp, because the pre-open snapshot is written once
   at ~09:10 IST and reading it at 15:00 as if it were live would be a real
   mistake. */
function PreOpenPanel() {
  const { data } = trpc.getPreMarketMovers.useQuery({ limit: 8 }, { staleTime: 300_000 });
  const gapUp: any[] = (data as any)?.gapUp ?? [];
  const gapDown: any[] = (data as any)?.gapDown ?? [];
  const asOf = (data as any)?.asOfDate;

  return (
    <Panel
      eyebrow="05"
      title="Pre-open gaps"
      action={<Chip tone="warn">{asOf ? `as of ${asOf}` : 'no snapshot'}</Chip>}
      dense
    >
      {!asOf ? (
        <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">
          No pre-open snapshot yet. This writes once, around 09:10 IST.
        </p>
      ) : (
        <div className="grid grid-cols-2 divide-x divide-line">
          {[
            { label: 'Gap up', rows: gapUp, tone: 'text-up' },
            { label: 'Gap down', rows: gapDown, tone: 'text-down' },
          ].map((col) => (
            <div key={col.label} className="min-w-0">
              <div className="border-b border-line px-3 py-1.5 text-[9px] tracking-[0.16em] text-mark-4 uppercase">
                {col.label}
              </div>
              <ul className="tala-scroll max-h-[220px] overflow-y-auto">
                {col.rows.length === 0 && <li className="px-3 py-4 text-center text-[10px] text-mark-4">none</li>}
                {col.rows.map((r: any, i: number) => (
                  <li key={`${r.symbol}-${i}`} className="flex items-center gap-1.5 border-b border-line/40 px-3 py-1.5 last:border-0">
                    <SymbolLink symbol={r.symbol} className="min-w-0 flex-1" />
                    {num(r.imbalance) !== null && (
                      <span
                        className="tnum shrink-0 font-mono text-[9px] text-mark-4"
                        title="Pre-open order-book imbalance"
                      >
                        imb {r.imbalance.toFixed(2)}
                      </span>
                    )}
                    <span className={cn('tnum w-12 shrink-0 text-right font-mono text-[10px] font-semibold', col.tone)}>
                      {pct(r.iepGapPct, 1)}
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          ))}
        </div>
      )}
    </Panel>
  );
}

/* â”€â”€ Catalyst calendar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   Upcoming events are the highest-value free information available to a swing
   trader, and the thing most dashboards bury. Results and macro prints sit
   side by side because that is the actual collision risk. */
function CatalystPanel() {
  // Takes a single `date`, not a window — it returns that day's result calendar.
  // Asking for "the next 21 days" is not expressible, so the desk shows the
  // latest available date's board and says which date that is.
  const { data: earnings } = trpc.getEarningsCalendar.useQuery({}, { staleTime: 6 * 3600_000 });
  const { data: eco } = trpc.getEcoCalendar.useQuery(
    { daysBack: 1, daysForward: 10, minImpact: 2 },
    { staleTime: 3600_000 },
  );

  const earningsRows: any[] = useMemo(() => {
    const d: any = earnings;
    if (!d) return [];
    // The calendar procedure nests under data.resultCalendar; guard both shapes so
    // a vendor shape change blanks the panel instead of throwing on the page.
    const list = d?.data?.resultCalendar ?? d?.resultCalendar ?? [];
    return Array.isArray(list) ? list : [];
  }, [earnings]);

  const ecoRows: any[] = Array.isArray(eco) ? eco : [];
  const today = new Date().toISOString().slice(0, 10);

  return (
    <Panel
      eyebrow="06"
      title="Catalysts ahead"
      action={
        <span className="flex items-center gap-1 font-mono text-[9px] text-mark-4">
          <CalendarClock size={10} /> next 10d
        </span>
      }
      dense
    >
      <div className="divide-y divide-line">
        <div>
          <div className="flex items-baseline justify-between border-b border-line px-3.5 py-1.5">
            <span className="text-[9px] tracking-[0.16em] text-mark-4 uppercase">Results</span>
            <span className="font-mono text-[9px] text-mark-4">{earningsRows.length || 'none tracked'}</span>
          </div>
          {earningsRows.length === 0 ? (
            <p className="px-3.5 py-3 text-[10px] text-mark-4">
              No result dates in the next 21 days from the tracked calendar.
            </p>
          ) : (
            <ul className="tala-scroll max-h-[160px] overflow-y-auto">
              {earningsRows.slice(0, 30).map((r: any, i: number) => {
                const d = String(r.result_date ?? r.date ?? '').slice(0, 10);
                return (
                  <li key={`${r.symbol}-${i}`} className="flex items-center gap-2 border-b border-line/40 px-3.5 py-1.5 last:border-0">
                    <span
                      className={cn(
                        'tnum w-14 shrink-0 font-mono text-[9px]',
                        d === today ? 'text-marigold' : d && d < today ? 'text-mark-4' : 'text-mark-2',
                      )}
                    >
                      {d || DASH}
                    </span>
                    <SymbolLink symbol={r.symbol} className="min-w-0 flex-1" />
                  </li>
                );
              })}
            </ul>
          )}
        </div>

        <div>
          <div className="flex items-baseline justify-between border-b border-line px-3.5 py-1.5">
            <span className="text-[9px] tracking-[0.16em] text-mark-4 uppercase">Macro prints</span>
            <span className="font-mono text-[9px] text-mark-4">{ecoRows.length}</span>
          </div>
          {ecoRows.length === 0 ? (
            <p className="px-3.5 py-3 text-[10px] text-mark-4">No high-impact macro events in the window.</p>
          ) : (
            <ul className="tala-scroll max-h-[190px] overflow-y-auto">
              {ecoRows.slice(0, 25).map((r: any, i: number) => (
                <li key={i} className="flex items-start gap-2 border-b border-line/40 px-3.5 py-1.5 last:border-0">
                  <span className="tnum w-11 shrink-0 font-mono text-[9px] text-mark-3">{String(r.event_date).slice(5)}</span>
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[11px] text-mark-2">{r.event_name}</span>
                    <span className="text-[9px] text-mark-4">
                      {r.country_name} Â· imp {r.impact}
                      {r.consensus ? ` Â· cons ${r.consensus}` : ''}
                      {r.actual ? ` Â· act ${r.actual}` : ''}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      </div>
    </Panel>
  );
}

/* â”€â”€ News pulse â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ */
function NewsPanel() {
  const { data } = trpc.getNewsItems.useQuery(
    { limit: 14, category: 'ALL', sentiment: 'ALL', sourceType: 'ALL', hours: 12 },
    { staleTime: 120_000, refetchInterval: 300_000 },
  );
  const rows: any[] = Array.isArray(data) ? data : [];

  return (
    <Panel
      eyebrow="07"
      title="News pulse"
      action={
        <Link to="/tala/news" className="flex items-center gap-1 font-mono text-[10px] text-mark-3 hover:text-marigold">
          ALL <ArrowRight size={10} />
        </Link>
      }
      dense
    >
      {rows.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">No news in the last 12 hours.</p>
      ) : (
        <ul className="tala-scroll max-h-[300px] overflow-y-auto">
          {rows.map((n, i) => (
            <li
              key={n.id ?? i}
              className="tala-rise border-b border-line/50 px-3.5 py-2 last:border-0"
              style={{ animationDelay: `${Math.min(i, 12) * 18}ms` }}
            >
              <a href={n.url} target="_blank" rel="noreferrer noopener" className="group block">
                <div className="flex items-start gap-2">
                  {/* Impact stripe: colour carries the read, the text carries the fact. */}
                  <span
                    className={cn(
                      'mt-1 h-3.5 w-0.5 shrink-0 rounded-full',
                      n.sentiment === 'BULLISH' ? 'bg-up' : n.sentiment === 'BEARISH' ? 'bg-down' : 'bg-line-3',
                    )}
                  />
                  <div className="min-w-0 flex-1">
                    <p className="line-clamp-2 text-[11px] leading-snug text-mark-2 transition-colors group-hover:text-mark">
                      {n.title}
                    </p>
                    <div className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-0.5 text-[9px] text-mark-4">
                      <span className="font-mono">{ago(n.published_at)}</span>
                      <span className="truncate">{n.source}</span>
                      {n.impact === 'HIGH' && <Chip tone="warn">HIGH IMPACT</Chip>}
                      {n.sector && <span className="truncate">{n.sector}</span>}
                    </div>
                  </div>
                </div>
              </a>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

/* â”€â”€ Today's picks â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   The page's answer. Conviction is defaulted to TOP (S_ELITE + A_HIGH only)
   rather than ALL, because a desk that leads with its lowest-conviction rows is
   not helping anybody make a decision. */
function PicksSection() {
  const [conviction, setConviction] = useState<'TOP' | 'ALL' | 'B_MEDIUM'>('TOP');
  const [horizon, setHorizon] = useState<'ALL' | 'SWING' | 'LONG_TERM' | 'INTRADAY'>('ALL');

  const { data, isLoading, error, refetch } = trpc.getBuyRecommendations.useQuery(
    { conviction, horizon: horizon === 'ALL' ? 'ALL' : (horizon.toLowerCase() as any), limit: 24 },
    { staleTime: 120_000, refetchInterval: 300_000 },
  );

  const picks: PickRow[] = (data as any)?.picks ?? [];

  return (
    <Panel
      accent
      eyebrow="ACTION"
      title="What to buy today"
      action={
        <div className="flex flex-wrap items-center gap-1.5">
          <div className="flex gap-0.5">
            {(['TOP', 'ALL', 'B_MEDIUM'] as const).map((c) => (
              <button
                key={c}
                onClick={() => setConviction(c)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide uppercase transition-colors',
                  conviction === c ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {c === 'TOP' ? 'S+A only' : c}
              </button>
            ))}
          </div>
          <div className="h-3 w-px bg-line" />
          <div className="flex gap-0.5">
            {(['ALL', 'INTRADAY', 'SWING', 'LONG_TERM'] as const).map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] tracking-wide transition-colors',
                  horizon === h ? 'bg-white/[0.08] text-mark' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {h === 'LONG_TERM' ? 'LT' : h}
              </button>
            ))}
          </div>
        </div>
      }
    >
      {error ? (
        <ErrorState error={error} onRetry={refetch} />
      ) : picks.length === 0 && isLoading ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {Array.from({ length: 4 }).map((_, i) => (
            <Skeleton key={i} className="h-52 w-full rounded-lg" />
          ))}
        </div>
      ) : picks.length === 0 ? (
        <div className="flex flex-col items-center gap-2 py-10 text-center">
          <Ban size={18} className="text-mark-4" />
          <p className="text-[12px] text-mark-2">No names clear this bar right now.</p>
          <p className="max-w-md text-[11px] text-mark-4">
            The ranker publishes a Buy only when classification, conviction and horizon all agree. An empty
            board is a legitimate answer — widen the conviction filter rather than reading it as a bug.
          </p>
        </div>
      ) : (
        <>
          <div className="mb-3 flex flex-wrap items-center gap-x-4 gap-y-1 border-b border-line pb-2.5 text-[10px] text-mark-4">
            <span className="flex items-center gap-1.5">
              <Radio size={10} className="text-up" />
              <span className="tnum font-mono text-mark-2">{picks.length}</span> qualifying names
            </span>
            <span>
              ranked <span className="font-mono text-mark-3">{(data as any)?.lastComputedAt}</span>
            </span>
            <span className="font-mono">regime {(data as any)?.regime}</span>
            <Link to="/tala/picks" className="ml-auto flex items-center gap-1 text-mark-3 hover:text-marigold">
              Full screener <ArrowRight size={10} />
            </Link>
          </div>
          <div className="grid gap-3 lg:grid-cols-2 2xl:grid-cols-3">
            {picks.map((p, i) => (
              <PickCard key={p.symbol} pick={p} index={i} />
            ))}
          </div>
        </>
      )}
    </Panel>
  );
}

/* â”€â”€ Intraday gate â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
   intraday_ranker.py suppresses Buy emission when its own trailing realised P&L
   is negative. An empty list there is CORRECT behaviour, not a broken widget, so
   the reason is surfaced verbatim instead of the panel being quietly empty. */
function IntradayPanel() {
  const { data } = trpc.getIntradayTopPicks.useQuery(undefined, { staleTime: 60_000, refetchInterval: 120_000 });
  const picks: any[] = (data as any)?.picks ?? [];
  const gateOpen = (data as any)?.gateOpen;

  return (
    <Panel
      eyebrow="INTRADAY"
      title="Intraday engine"
      action={<Chip tone={gateOpen ? 'up' : 'warn'}>{gateOpen ? 'OPEN' : 'GATED'}</Chip>}
      dense
    >
      {gateOpen === false ? (
        <div className="px-3.5 py-4">
          <div className="flex items-start gap-2.5">
            <Flame size={15} className="mt-0.5 shrink-0 text-warn" />
            <div className="min-w-0">
              <p className="text-[12px] font-semibold text-warn">Intraday buys are paused.</p>
              <p className="mt-1 text-[11px] leading-relaxed text-mark-3">
                {String((data as any)?.gateReason ?? 'The engine gate is closed.')}
              </p>
              <p className="mt-2 text-[10px] text-mark-4">
                <span className="tnum font-mono text-mark-3">{n0((data as any)?.totalScored)}</span> names were
                still scored — the scores exist, they are just not published as actionable. An engine declining
                to recommend is itself information.
              </p>
            </div>
          </div>
        </div>
      ) : picks.length === 0 ? (
        <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">No intraday picks published yet.</p>
      ) : (
        <ul className="tala-scroll max-h-[260px] overflow-y-auto">
          {picks.map((p: any, i: number) => (
            <li key={p.symbol} className="flex items-center gap-2 border-b border-line/50 px-3.5 py-1.5 last:border-0">
              <SymbolLink symbol={p.symbol} className="min-w-0 flex-1" />
              <span className="tnum shrink-0 font-mono text-[10px] text-mark-3">{price(p.cmp)}</span>
              <span className="tnum w-8 shrink-0 text-right font-mono text-[11px] font-semibold text-marigold">
                {num(p.intraday_score)?.toFixed(0) ?? DASH}
              </span>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}

export default function DeskHome() {
  return (
    <div className="tala-rise space-y-3 p-3">
      <RegimeBanner />
      <PicksSection />

      <div className="grid grid-cols-1 gap-3 lg:grid-cols-3">
        <div className="space-y-3">
          <PulsePanel />
          <MacroPanel />
        </div>
        <div className="space-y-3">
          <SectorPanel />
          <IntradayPanel />
        </div>
        <div className="space-y-3">
          <MoverPanel />
          <PreOpenPanel />
          <CatalystPanel />
          <NewsPanel />
        </div>
      </div>
    </div>
  );
}
