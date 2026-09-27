import { useMemo, useState } from 'react';
import { Download, Filter, LayoutGrid, Rows3 } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { DASH, num, pct, price, prob } from '../lib/format';
import { classifyAction, convictionTone, type PickRow } from '../lib/insight';
import { Chip, Panel, SymbolLink } from '../components/Primitives';
import { DataTable } from '../components/DataTable';
import { PickCard } from '../components/PickCard';

const CONVICTIONS = [
  ['TOP', 'S+A only'],
  ['ALL', 'All tiers'],
  ['S_ELITE', 'S elite'],
  ['A_HIGH', 'A high'],
  ['B_MEDIUM', 'B medium'],
] as const;

const HORIZONS = [
  ['ALL', 'All horizons'],
  ['intraday', 'Intraday'],
  ['swing', 'Swing'],
  ['long_term', 'Long term'],
] as const;

/**
 * The full ranked list, filterable client-side.
 *
 * Filters run in the browser rather than as server round-trips: the endpoint
 * already returns the whole ranked batch for a conviction/horizon pair, and a
 * text filter over a few hundred in-memory rows is instant, whereas a round-trip
 * per keystroke on a ranking table makes it feel broken.
 */
export default function PicksPage() {
  const [conviction, setConviction] = useState<string>('ALL');
  const [horizon, setHorizon] = useState<string>('ALL');
  const [sector, setSector] = useState('ALL');
  const [q, setQ] = useState('');
  const [view, setView] = useState<'cards' | 'table'>('cards');

  const { data, isLoading, error, refetch } = trpc.getBuyRecommendations.useQuery(
    { conviction: conviction as any, horizon: horizon as any, limit: 200 },
    { staleTime: 120_000, refetchInterval: 300_000 },
  );

  const all: PickRow[] = (data as any)?.picks ?? [];
  const sectorList: string[] = useMemo(() => {
    const set = new Set<string>();
    for (const p of all) if (p.sector) set.add(p.sector);
    return ['ALL', ...[...set].sort()];
  }, [all]);

  const rows = useMemo(() => {
    const needle = q.trim().toUpperCase();
    return all.filter((p) => {
      if (sector !== 'ALL' && p.sector !== sector) return false;
      if (!needle) return true;
      return (
        p.symbol.toUpperCase().includes(needle) ||
        String(p.trade_reasoning ?? '').toUpperCase().includes(needle)
      );
    });
  }, [all, sector, q]);

  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  /** CSV of exactly what is on screen, so a saved list matches the filters the user
   *  was actually looking at rather than the unfiltered endpoint. */
  const exportCsv = () => {
    const head = [
      'symbol', 'classification', 'conviction', 'unified_score', 'sector', 'timeframe',
      'livePrice', 'changePercent', 'entry_zone_low', 'entry_zone_high',
      'target_1', 'target_2', 'stop_loss', 'risk_reward', 'win_probability',
    ];
    const body = rows.map((r) => head.map((h) => String((r as any)[h] ?? '')).join(','));
    const blob = new Blob([[head.join(','), ...body].join('\n')], { type: 'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `tala-picks-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
  };

  return (
    <div className="tala-rise space-y-3 p-3">
      <Panel
        accent
        eyebrow="RANKER"
        title="Ranked buy list"
        action={
          <div className="flex items-center gap-1.5">
            <span className="tnum font-mono text-[10px] text-mark-3">
              {rows.length} / {all.length}
            </span>
            <button
              onClick={exportCsv}
              disabled={!rows.length}
              className="flex items-center gap-1 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[9px] text-mark-3 transition-colors hover:border-marigold/40 hover:text-marigold disabled:opacity-30"
            >
              <Download size={9} /> CSV
            </button>
            <div className="flex gap-0.5">
              {([['cards', LayoutGrid], ['table', Rows3]] as const).map(([k, Icon]) => (
                <button
                  key={k}
                  onClick={() => setView(k)}
                  className={cn(
                    'grid size-6 place-items-center rounded transition-colors',
                    view === k ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
                  )}
                >
                  <Icon size={12} />
                </button>
              ))}
            </div>
          </div>
        }
      >
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex items-center gap-1.5">
            <Filter size={11} className="text-mark-4" />
            <input
              value={q}
              onChange={(e) => setQ(e.target.value)}
              placeholder="Filter symbol or thesis..."
              className="h-7 w-56 rounded border border-line-2 bg-ink-900 px-2 font-mono text-[11px] text-mark placeholder:text-mark-4 focus:border-marigold/50 focus:outline-none"
            />
          </div>
          <Select value={conviction} onChange={setConviction} options={CONVICTIONS.map((c) => [c[0], c[1]] as [string, string])} />
          <Select value={horizon} onChange={setHorizon} options={HORIZONS.map((h) => [h[0], h[1]] as [string, string])} />
          <Select
            value={sector}
            onChange={setSector}
            options={sectorList.map((s) => [s, s === 'ALL' ? 'All sectors' : s] as [string, string])}
          />
          <Chip tone="neutral">regime {String((data as any)?.regime ?? '-')}</Chip>
        </div>
      </Panel>

      {view === 'cards' ? (
        <div className="grid gap-3 md:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
          {rows.slice(0, 60).map((p, i) => (
            <PickCard key={p.symbol} pick={p} index={i} />
          ))}
        </div>
      ) : (
        <Panel dense>
          <DataTable
            rows={rows}
            getKey={(r: PickRow) => r.symbol}
            isLoading={isLoading}
            error={error}
            onRetry={retry}
            initialSort={{ key: 'score', dir: 'desc' }}
            maxHeight="calc(100vh - 230px)"
            emptyLabel="No names match these filters"
            emptyHint="Try widening the conviction tier or clearing the text filter."
            columns={PICK_COLUMNS}
          />
        </Panel>
      )}
    </div>
  );
}

function Select({
  value,
  onChange,
  options,
}: {
  value: string;
  onChange: (v: string) => void;
  options: [string, string][];
}) {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="h-7 cursor-pointer rounded border border-line-2 bg-ink-900 px-2 font-mono text-[10px] text-mark-2 focus:border-marigold/50 focus:outline-none"
    >
      {options.map(([v, l]) => (
        <option key={v} value={v} className="bg-ink-850">
          {l}
        </option>
      ))}
    </select>
  );
}

/** Declared at module scope so the array identity is stable across renders — an
 *  inline literal would give react-query/DataTable a new `columns` reference every
 *  render and defeat the useMemo sort. */
const PICK_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: PickRow) => r.symbol, cell: (r: PickRow) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'class',
    header: 'Call',
    sort: (r: PickRow) => r.classification ?? '',
    cell: (r: PickRow) => {
      const a = classifyAction(r.classification);
      return (
        <span className={cn('font-mono text-[10px] font-bold', a.tone === 'up' ? 'text-up' : a.tone === 'down' ? 'text-down' : 'text-mark-3')}>
          {a.action}
        </span>
      );
    },
  },
  {
    key: 'conviction',
    header: 'Conv',
    sort: (r: PickRow) => r.conviction_level,
    cell: (r: PickRow) => (
      <span className={cn('font-mono text-[10px]', convictionTone(r.conviction_level).text)}>
        {String(r.conviction_level).replace('_', ' ')}
      </span>
    ),
  },
  {
    key: 'score',
    header: 'Score',
    align: 'right' as const,
    sort: (r: PickRow) => num(r.unified_score),
    cell: (r: PickRow) => (
      <span className="tnum font-mono font-semibold text-marigold">{num(r.unified_score)?.toFixed(1) ?? DASH}</span>
    ),
  },
  { key: 'sector', header: 'Sector', hideBelow: 'lg' as const, sort: (r: PickRow) => r.sector ?? '', cell: (r: PickRow) => (
    <span className="text-mark-3">{r.sector ?? DASH}</span>
  ) },
  { key: 'tf', header: 'Horizon', hideBelow: 'xl' as const, sort: (r: PickRow) => r.timeframe ?? '', cell: (r: PickRow) => (
    <span className="font-mono text-[10px] text-mark-3">{r.timeframe ?? DASH}</span>
  ) },
  { key: 'ltp', header: 'LTP', align: 'right' as const, sort: (r: PickRow) => num(r.livePrice) ?? num(r.cmp), cell: (r: PickRow) => (
    <span className="tnum font-mono">{price(r.livePrice ?? r.cmp)}</span>
  ) },
  {
    key: 'chg',
    header: 'Chg',
    align: 'right' as const,
    sort: (r: PickRow) => num(r.changePercent),
    cell: (r: PickRow) => (
      <span className={cn('tnum font-mono', (num(r.changePercent) ?? 0) >= 0 ? 'text-up' : 'text-down')}>
        {pct(r.changePercent)}
      </span>
    ),
  },
  {
    key: 'entry',
    header: 'Entry zone',
    align: 'right' as const,
    hideBelow: 'lg' as const,
    sort: (r: PickRow) => num(r.entry_zone_low),
    cell: (r: PickRow) => (
      <span className="tnum font-mono text-[11px] text-mark-2">
        {num(r.entry_zone_low) === null ? DASH : price(r.entry_zone_low, 1) + '-' + price(r.entry_zone_high, 1)}
      </span>
    ),
  },
  { key: 't1', header: 'T1', align: 'right' as const, hideBelow: 'xl' as const, sort: (r: PickRow) => num(r.target_1), cell: (r: PickRow) => (
    <span className="tnum font-mono text-up">{price(r.target_1, 1)}</span>
  ) },
  { key: 'stop', header: 'Stop', align: 'right' as const, hideBelow: 'xl' as const, sort: (r: PickRow) => num(r.stop_loss), cell: (r: PickRow) => (
    <span className="tnum font-mono text-down">{price(r.stop_loss, 1)}</span>
  ) },
  {
    key: 'rr',
    header: 'R:R',
    align: 'right' as const,
    sort: (r: PickRow) => num(r.risk_reward),
    cell: (r: PickRow) => (
      <span className={cn('tnum font-mono', (num(r.risk_reward) ?? 0) >= 2 ? 'text-up' : 'text-mark-2')}>
        {num(r.risk_reward)?.toFixed(1) ?? DASH}
      </span>
    ),
  },
  {
    key: 'winp',
    header: 'Win prob',
    align: 'right' as const,
    hideBelow: 'xl' as const,
    sort: (r: PickRow) => num(r.win_probability),
    cell: (r: PickRow) => <span className="tnum font-mono text-mark-2">{prob(r.win_probability)}</span>,
  },
];
