import { useMemo, useState } from 'react';
import { ArrowRight, Crosshair, Layers, Zap } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { DASH, frac, n0, num, parseJson, pct, price } from '../lib/format';
import { Chip, Meter, Panel, Stat, SymbolLink } from '../components/Primitives';
import { BarRow } from '../components/Charts';
import { DataTable } from '../components/DataTable';

const TABS = [
  { k: 'rotation', label: 'Sector rotation', icon: Layers },
  { k: 'early', label: 'Pre-open setups', icon: Zap },
  { k: 'flyers', label: 'Multipliers', icon: Crosshair },
  { k: 'signals', label: 'Breakouts', icon: ArrowRight },
] as const;

type TabKey = (typeof TABS)[number]['k'];

/**
 * Market internals: where money is rotating, what is set up before the open, and
 * what the high-flyer retrospective has actually learned from past runs.
 */
export default function MarketPage() {
  const [tab, setTab] = useState<TabKey>('rotation');

  return (
    <div className="tala-rise space-y-3 p-3">
      <div className="flex flex-wrap items-center gap-2">
        {TABS.map(({ k, label, icon: Icon }) => (
          <button
            key={k}
            onClick={() => setTab(k)}
            className={cn(
              'flex items-center gap-1.5 rounded border px-2.5 py-1 font-mono text-[10px] tracking-wide uppercase transition-colors',
              tab === k
                ? 'border-marigold/40 bg-marigold/10 text-marigold'
                : 'border-line-2 text-mark-3 hover:border-line-3 hover:text-mark-2',
            )}
          >
            <Icon size={11} />
            {label}
          </button>
        ))}
      </div>

      {tab === 'rotation' && <Rotation />}
      {tab === 'early' && <EarlySetups />}
      {tab === 'flyers' && <Flyers />}
      {tab === 'signals' && <Breakouts />}
    </div>
  );
}

/**
 * Sector rotation scored on the platform's own bull/bear screener balance.
 * The read matters: `net_score` counts appearances across every screen in the
 * sector, so a large sector mechanically produces a bigger absolute number — which
 * is why this panel sorts and colours on `breadth_score` (per-stock normalised)
 * and shows raw counts beside it rather than instead of it.
 */
function Rotation() {
  const { data, isLoading, error, refetch } = trpc.getScreenerSectorRotation.useQuery(
    { days: 7 },
    { staleTime: 5 * 60_000 },
  );
  const rows: any[] = useMemo(
    () =>
      [...(Array.isArray(data) ? data : [])].sort(
        (a, b) => (num(b.breadth_score) ?? 0) - (num(a.breadth_score) ?? 0),
      ),
    [data],
  );
  const maxBreadth = Math.max(1, ...rows.map((r) => num(r.breadth_score) ?? 0));
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="grid gap-3 lg:grid-cols-2">
      <Panel accent eyebrow="ROTATION" title="Sector breadth" action={<Chip tone="neutral">{String(rows[0]?.date ?? '')}</Chip>}>
        <p className="mb-2.5 text-[10px] leading-relaxed text-mark-3">
          Bull minus bear screen appearances per stock in each sector, normalised by sector size. High =
          capital rotating in; negative = rotating out.
        </p>
        <div className="space-y-0.5">
          {rows.slice(0, 22).map((r) => (
            <BarRow
              key={r.sector}
              label={r.sector}
              value={num(r.breadth_score)}
              max={maxBreadth}
              tone={
                (num(r.breadth_score) ?? 0) >= 5
                  ? 'bg-up/70'
                  : (num(r.breadth_score) ?? 0) >= 0
                    ? 'bg-marigold/60'
                    : 'bg-down/50'
              }
              right={num(r.breadth_score)?.toFixed(1) ?? DASH}
              sub={n0(r.stock_count)}
            />
          ))}
        </div>
      </Panel>

      <Panel dense eyebrow="LEADERS" title="Who is leading each sector">
        <DataTable
          rows={rows}
          getKey={(r: any) => r.sector}
          isLoading={isLoading}
          error={error}
          onRetry={retry}
          maxHeight="calc(100vh - 200px)"
          initialSort={{ key: 'breadth', dir: 'desc' }}
          dense
          columns={ROTATION_COLUMNS}
        />
      </Panel>
    </div>
  );
}

const ROTATION_COLUMNS = [
  { key: 'sector', header: 'Sector', sort: (r: any) => r.sector, cell: (r: any) => (
    <span className="text-[12px] text-mark">{r.sector}</span>
  ) },
  { key: 'bull', header: 'Bull', align: 'right' as const, sort: (r: any) => num(r.bull_count), cell: (r: any) => (
    <span className="tnum font-mono text-up">{n0(r.bull_count)}</span>
  ) },
  { key: 'bear', header: 'Bear', align: 'right' as const, sort: (r: any) => num(r.bear_count), cell: (r: any) => (
    <span className="tnum font-mono text-down">{n0(r.bear_count)}</span>
  ) },
  {
    key: 'breadth',
    header: 'Breadth',
    align: 'right' as const,
    sort: (r: any) => num(r.breadth_score),
    cell: (r: any) => (
      <span className={cn('tnum font-mono font-semibold', (num(r.breadth_score) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
        {num(r.breadth_score)?.toFixed(1) ?? DASH}
      </span>
    ),
  },
  {
    key: 'moms',
    header: 'Δ breadth',
    align: 'right' as const,
    hideBelow: 'lg' as const,
    sort: (r: any) => num(r.momentum_change),
    cell: (r: any) => (
      <span className={cn('tnum font-mono', (num(r.momentum_change) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
        {pct(r.momentum_change, 0)}
      </span>
    ),
  },
  {
    key: 'top',
    header: 'Leaders',
    hideBelow: 'xl' as const,
    cell: (r: any) => {
      const list: string[] = parseJson<string[]>(r.top_stocks, String(r.top_stocks ?? '').split(',').filter(Boolean));
      return (
        <span className="flex gap-1.5">
          {list.slice(0, 4).map((s) => (
            <SymbolLink key={s} symbol={s} />
          ))}
        </span>
      );
    },
  },
];

/**
 * Pre-open / early-hours setups - the highest-value table on the desk for an
 * opening-bell trader. It combines the indicative opening price, the order-book
 * imbalance and the delivery spike the pre-open fetcher computes before 09:15.
 */
function EarlySetups() {
  const { data, isLoading, error, refetch } = trpc.getEarlyHoursPredictions.useQuery(undefined, {
    staleTime: 10 * 60_000,
  });
  const rows: any[] = Array.isArray(data) ? data : [];
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <Panel
      accent
      eyebrow="PRE-OPEN"
      title="Opening-bell setups"
      action={<Chip tone="warn">{String(rows[0]?.date ?? 'no snapshot')}</Chip>}
      dense
    >
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Scored before the open from the indicative price gap, order-book imbalance, delivery spike and
        technical breakouts. Corporate-action names carry a flag rather than being trusted - a split or bonus
        issue moves the price without carrying any information.
      </p>
      <DataTable
        rows={rows}
        getKey={(r: any) => r.symbol}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        initialSort={{ key: 'score', dir: 'desc' }}
        maxHeight="calc(100vh - 210px)"
        emptyLabel="No pre-open setups for the latest session"
        columns={EARLY_COLUMNS}
      />
    </Panel>
  );
}

const EARLY_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'score',
    header: 'Score',
    align: 'right' as const,
    sort: (r: any) => num(r.score),
    cell: (r: any) => <span className="tnum font-mono font-bold text-marigold">{num(r.score)?.toFixed(0) ?? DASH}</span>,
  },
  {
    key: 'gap',
    header: 'Gap',
    align: 'right' as const,
    sort: (r: any) => num(r.iepGapPct),
    cell: (r: any) => (
      <span className={cn('tnum font-mono', (num(r.iepGapPct) ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.iepGapPct)}</span>
    ),
  },
  {
    key: 'imb',
    header: 'Imbalance',
    align: 'right' as const,
    hideBelow: 'md' as const,
    sort: (r: any) => num(r.preopenImbalance),
    cell: (r: any) => (
      <span className={cn('tnum font-mono', (num(r.preopenImbalance) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
        {num(r.preopenImbalance)?.toFixed(2) ?? DASH}
      </span>
    ),
  },
  {
    key: 'del',
    header: 'Delivery delta',
    align: 'right' as const,
    hideBelow: 'lg' as const,
    sort: (r: any) => num(r.deliverySpikePct),
    cell: (r: any) => <span className="tnum font-mono text-warn">{pct(r.deliverySpikePct, 0)}</span>,
  },
  {
    key: 'sig',
    header: 'Breakouts',
    hideBelow: 'xl' as const,
    cell: (r: any) => (
      <span className="flex gap-1">
        {(r.breakoutSignals ?? []).slice(0, 2).map((s: string, i: number) => (
          <Chip key={i} tone="marigold">{s}</Chip>
        ))}
      </span>
    ),
  },
  {
    key: 'why',
    header: 'Why',
    hideBelow: 'xl' as const,
    cell: (r: any) => (
      <span className="block max-w-[360px] truncate text-[10px] text-mark-3" title={(r.reasons ?? []).join(' | ')}>
        {(r.reasons ?? []).join(' | ') || DASH}
      </span>
    ),
  },
];

/** The high-flyer retrospective: what actually became a multiplier, and which
 *  precursor patterns preceded it. Framed as research, not as a recommendation —
 *  which is how the upstream job itself describes it. */
function Flyers() {
  const { data, isLoading, error, refetch } = trpc.getHighFlyerReport.useQuery(undefined, { staleTime: 30 * 60_000 });
  const flyers: any[] = (data as any)?.flyers ?? [];
  const candidates: any[] = (data as any)?.candidates ?? [];
  const uni = num((data as any)?.universeN);
  const fly = num((data as any)?.flyerN);
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <Panel dense>
          <Stat label="Universe scanned" value={n0(uni)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat label="Became multipliers" value={n0(fly)} size="lg" tone="text-up" />
        </Panel>
        <Panel dense>
          <Stat label="Base rate" value={frac(uni && fly ? fly / uni : null, 2)} size="lg" />
        </Panel>
        <Panel dense>
          <Stat label="As of" value={String((data as any)?.date ?? DASH)} size="md" mono={false} />
        </Panel>
      </div>

      <div className="grid gap-3 lg:grid-cols-2">
        <Panel dense eyebrow="REALISED" title="What actually moved">
          <DataTable
            rows={flyers}
            getKey={(r: any) => r.symbol}
            isLoading={isLoading}
            error={error}
            onRetry={retry}
            dense
            maxHeight="340px"
            initialSort={{ key: 'ret', dir: 'desc' }}
            columns={FLYER_COLUMNS}
            emptyLabel="No realised flyers recorded"
          />
        </Panel>

        <Panel dense eyebrow="WATCH" title="Fresh candidates today">
          <DataTable
            rows={candidates}
            getKey={(r: any) => r.symbol}
            isLoading={isLoading}
            dense
            maxHeight="340px"
            initialSort={{ key: 'score', dir: 'desc' }}
            columns={CANDIDATE_COLUMNS}
            emptyLabel="No candidates in today's run"
          />
        </Panel>
      </div>
    </div>
  );
}

const FLYER_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'ret',
    header: 'Return',
    align: 'right' as const,
    sort: (r: any) => num(r.return_pct),
    cell: (r: any) => (
      <span className={cn('tnum font-mono font-semibold', (num(r.return_pct) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
        {pct(r.return_pct)}
      </span>
    ),
  },
  { key: 'vol', header: 'Vol x', align: 'right' as const, hideBelow: 'md' as const, sort: (r: any) => num(r.volume_ratio), cell: (r: any) => (
    <span className="tnum font-mono text-mark-2">{num(r.volume_ratio)?.toFixed(1) ?? DASH}</span>
  ) },
  { key: 'hi', header: '52w high', align: 'center' as const, hideBelow: 'lg' as const, cell: (r: any) => (
    r.new_52w_high ? <Chip tone="marigold">NEW HIGH</Chip> : null
  ) },
  { key: 'pred', header: 'Flagged by', hideBelow: 'xl' as const, cell: (r: any) => (
    <span className="text-[10px] text-mark-4">{r.predicted_by ?? DASH}</span>
  ) },
];

const CANDIDATE_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'score',
    header: 'Score',
    align: 'right' as const,
    sort: (r: any) => num(r.score),
    cell: (r: any) => <span className="tnum font-mono font-semibold text-marigold">{num(r.score)?.toFixed(1) ?? DASH}</span>,
  },
  {
    key: 'prec',
    header: 'Precursors',
    hideBelow: 'md' as const,
    cell: (r: any) => {
      const p: string[] = parseJson<string[]>(r.precursors, String(r.precursors ?? '').split(',').filter(Boolean));
      return (
        <span className="flex gap-1">
          {p.slice(0, 3).map((x, i) => (
            <Chip key={i} tone="info">{x}</Chip>
          ))}
        </span>
      );
    },
  },
];

function Breakouts() {
  const { data, isLoading, error, refetch } = trpc.getBreakouts.useQuery(undefined, { staleTime: 60_000 });

  // "Closing strength" - where the close landed inside the day's range - is a far
  // better breakout signal than merely touching the high, because it measures
  // whether the level actually held through the session.
  const rows: any[] = useMemo(() => {
    const d: any = data;
    const list: any[] = d?.data ?? [];
    if (!Array.isArray(list)) return [];
    return list
      .map((b: any) => {
        const o = num(b.open);
        const c = num(b.close ?? b.last_trade_price);
        const hi = num(b.high);
        const lo = num(b.low);
        return {
          symbol: String(b.symbol_name ?? ''),
          open: o,
          close: c,
          high: hi,
          low: lo,
          vol: num(b.volume),
          chg: o && c ? ((c - o) / o) * 100 : null,
          closePos: c !== null && lo !== null && hi !== null && hi > lo ? ((c - lo) / (hi - lo)) * 100 : null,
        };
      })
      .filter((r) => r.symbol)
      .sort((a, b) => (b.closePos ?? -1) - (a.closePos ?? -1));
  }, [data]);

  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <Panel
      accent
      eyebrow="STRUCTURE"
      title="Breakout quality - closing strength in the day's range"
      action={<Chip tone="neutral">{n0(rows.length)} scanned</Chip>}
      dense
    >
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Sorted by where the close landed inside the day's range. A stock closing at 95% of its range is
        holding its breakout; one closing at 10% handed the whole move back in the same session.
      </p>
      <DataTable
        rows={rows.slice(0, 200)}
        getKey={(r: any) => r.symbol}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        maxHeight="calc(100vh - 210px)"
        initialSort={{ key: 'pos', dir: 'desc' }}
        emptyLabel="No breakout scan available"
        columns={BREAKOUT_COLUMNS}
      />
    </Panel>
  );
}

const BREAKOUT_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'pos',
    header: 'Close in range',
    align: 'right' as const,
    sort: (r: any) => r.closePos,
    cell: (r: any) => {
      const p = r.closePos;
      return (
        <div className="flex items-center justify-end gap-2">
          <div className="w-16">
            <Meter
              value={p}
              height="h-1"
              tone={(p ?? 0) >= 80 ? 'bg-up/75' : (p ?? 0) >= 50 ? 'bg-marigold/60' : 'bg-down/50'}
            />
          </div>
          <span className="tnum w-9 font-mono text-[11px] text-mark-2">
            {p === null ? DASH : p.toFixed(0) + '%'}
          </span>
        </div>
      );
    },
  },
  { key: 'close', header: 'Close', align: 'right' as const, sort: (r: any) => r.close, cell: (r: any) => (
    <span className="tnum font-mono">{price(r.close)}</span>
  ) },
  {
    key: 'chg',
    header: 'Chg',
    align: 'right' as const,
    sort: (r: any) => r.chg,
    cell: (r: any) => <span className={cn('tnum font-mono', (r.chg ?? 0) >= 0 ? 'text-up' : 'text-down')}>{pct(r.chg)}</span>,
  },
  { key: 'high', header: 'High', align: 'right' as const, hideBelow: 'lg' as const, sort: (r: any) => r.high, cell: (r: any) => (
    <span className="tnum font-mono text-mark-3">{price(r.high)}</span>
  ) },
  { key: 'low', header: 'Low', align: 'right' as const, hideBelow: 'lg' as const, sort: (r: any) => r.low, cell: (r: any) => (
    <span className="tnum font-mono text-mark-3">{price(r.low)}</span>
  ) },
  { key: 'vol', header: 'Volume', align: 'right' as const, hideBelow: 'xl' as const, sort: (r: any) => r.vol, cell: (r: any) => (
    <span className="tnum font-mono text-[10px] text-mark-4">{n0(r.vol)}</span>
  ) },
];
