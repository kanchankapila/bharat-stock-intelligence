import { useMemo, useState } from 'react';
import { AlertTriangle, Crown, Trophy } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { ago, DASH, frac, n0, num, pct } from '../lib/format';
import { Chip, Meter, Panel, SymbolLink } from '../components/Primitives';
import { DataTable } from '../components/DataTable';
import { BarRow } from '../components/Charts';

const TABS = [
  { k: 'leaderboard', label: 'Measured leaderboard', icon: Trophy },
  { k: 'confluence', label: 'Confluence universe', icon: Crown },
  { k: 'categories', label: 'Category stats', icon: null },
  { k: 'trending', label: 'What others are running', icon: null },
] as const;

type TabKey = (typeof TABS)[number]['k'];

/** Forward-return horizon every performance figure on this page is measured over. */
type Horizon = '5d' | '10d' | '20d' | '60d' | '120d';
const HORIZONS: Horizon[] = ['5d', '10d', '20d', '60d', '120d'];

/** A screener is only meaningfully "measured" once enough of its appearances have
 *  resolved. Below this floor the win rate is noise, and the table says so. */
const MIN_RESOLVED = 30;

/**
 * Screeners, ranked by what they have actually delivered.
 *
 * This page deliberately leads with the LEADERBOARD (measured win rate, alpha and
 * Sharpe per screener) rather than the catalogue. A screener whose measured win
 * rate is below a coin flip is worse than no screen at all, and the only way a
 * trader knows which is which is if the platform publishes it — which it does.
 * Thin samples are marked rather than hidden, because silently dropping them would
 * misrepresent how much evidence actually exists.
 */
export default function ScreenersPage() {
  const [tab, setTab] = useState<TabKey>('leaderboard');
  // The forward-return horizon every performance figure below is measured over.
  // A screener's win rate at 5 days and at 120 days are different claims about
  // different things, so the horizon is a first-class control rather than a
  // hidden default of 20d.
  const [horizon, setHorizon] = useState<Horizon>('20d');

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
            {Icon && <Icon size={11} />}
            {label}
          </button>
        ))}

        {tab !== 'trending' && (
          <div className="ml-auto flex items-center gap-1.5">
            <span className="font-mono text-[9px] tracking-[0.14em] text-mark-4 uppercase">Horizon</span>
            {HORIZONS.map((h) => (
              <button
                key={h}
                onClick={() => setHorizon(h)}
                className={cn(
                  'rounded px-1.5 py-0.5 font-mono text-[9px] transition-colors',
                  horizon === h ? 'bg-marigold/15 text-marigold' : 'text-mark-4 hover:text-mark-2',
                )}
              >
                {h}
              </button>
            ))}
          </div>
        )}
      </div>

      {tab === 'leaderboard' && <Leaderboard horizon={horizon} />}
      {tab === 'confluence' && <ConfluenceUniverse />}
      {tab === 'categories' && <CategoryStats horizon={horizon} />}
      {tab === 'trending' && <Trending />}
    </div>
  );
}

function Leaderboard({ horizon }: { horizon: Horizon }) {
  const { data, isLoading, error, refetch } = trpc.getScreenerLeaderboard.useQuery(
    { horizon, limit: 100 },
    { staleTime: 30 * 60_000 },
  );
  const rows: any[] = Array.isArray(data) ? data : [];
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <Panel
      accent
      eyebrow="EVIDENCE"
      title="Screeners ranked by realised performance"
      action={<Chip tone="neutral">computed {ago(rows[0]?.last_computed)}</Chip>}
      dense
    >
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Win rate, alpha and Sharpe are measured on resolved appearances against the forward return — not
        asserted by the screen's vendor. Rows with fewer than {MIN_RESOLVED} resolved appearances are marked:
        the rate is statistically thin, not wrong.
      </p>
      <DataTable
        rows={rows}
        getKey={(r: any) => r.screener_id}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        initialSort={{ key: 'win', dir: 'desc' }}
        maxHeight="calc(100vh - 230px)"
        emptyLabel="No screener performance computed yet"
        emptyHint="The leaderboard fills in once appearances have had time to resolve against forward prices."
        columns={LEADERBOARD_COLUMNS}
      />
    </Panel>
  );
}

const LEADERBOARD_COLUMNS = [
  {
    key: 'name',
    header: 'Screener',
    sort: (r: any) => r.name,
    cell: (r: any) => (
      <div className="min-w-0 max-w-[320px]">
        <div className="truncate text-[12px] text-mark">{r.name}</div>
        <div className="truncate text-[10px] text-mark-4">
          {r.source} · {r.category}
        </div>
      </div>
    ),
  },
  {
    key: 'tier',
    header: 'Tier',
    align: 'center' as const,
    sort: (r: any) => r.tier,
    cell: (r: any) => (
      <Chip tone={r.tier === 'Tier A' ? 'up' : r.tier === 'Tier AB' ? 'info' : 'neutral'}>{r.tier ?? '-'}</Chip>
    ),
  },
  {
    key: 'win',
    header: 'Win rate',
    align: 'right' as const,
    sort: (r: any) => num(r.win_rate),
    cell: (r: any) => {
      const w = num(r.win_rate);
      const thin = (num(r.resolved_count) ?? 0) < MIN_RESOLVED;
      return (
        <span
          className={cn(
            'tnum font-mono font-semibold',
            thin ? 'text-mark-3' : w !== null && w > 0.55 ? 'text-up' : w !== null && w < 0.45 ? 'text-down' : 'text-mark-2',
          )}
        >
          {frac(w)}
          {thin && <AlertTriangle size={9} className="ml-1 inline text-warn" />}
        </span>
      );
    },
  },
  {
    key: 'alpha',
    header: 'Alpha',
    align: 'right' as const,
    sort: (r: any) => num(r.alpha),
    cell: (r: any) => (
      <span className={cn('tnum font-mono', (num(r.alpha) ?? 0) > 0 ? 'text-up' : 'text-down')}>{pct(r.alpha)}</span>
    ),
  },
  {
    key: 'avg',
    header: 'Avg return',
    align: 'right' as const,
    hideBelow: 'lg' as const,
    sort: (r: any) => num(r.avg_return),
    cell: (r: any) => (
      <span className={cn('tnum font-mono', (num(r.avg_return) ?? 0) > 0 ? 'text-up' : 'text-down')}>
        {pct(r.avg_return)}
      </span>
    ),
  },
  {
    key: 'sharpe',
    header: 'Sharpe',
    align: 'right' as const,
    hideBelow: 'lg' as const,
    sort: (r: any) => num(r.sharpe),
    cell: (r: any) => <span className="tnum font-mono text-mark-2">{num(r.sharpe)?.toFixed(2) ?? DASH}</span>,
  },
  {
    key: 'n',
    header: 'Resolved',
    align: 'right' as const,
    sort: (r: any) => num(r.resolved_count),
    cell: (r: any) => (
      <span className={cn('tnum font-mono text-[10px]', (num(r.resolved_count) ?? 0) < MIN_RESOLVED ? 'text-warn' : 'text-mark-3')}>
        {n0(r.resolved_count)}
      </span>
    ),
  },
  {
    key: 'app',
    header: 'Appearances',
    align: 'right' as const,
    hideBelow: 'xl' as const,
    sort: (r: any) => num(r.total_appearances),
    cell: (r: any) => <span className="tnum font-mono text-[10px] text-mark-4">{n0(r.total_appearances)}</span>,
  },
];

/** Stocks the screener layer AND the independent quant ranker both rate highly. */
function ConfluenceUniverse() {
  const { data, isLoading, error, refetch } = trpc.getScreenerConfluenceUniverse.useQuery(
    {},
    { staleTime: 300_000 },
  );
  const stocks: any[] = (data as any)?.stocks ?? [];
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <Panel
      accent
      eyebrow="CROSS-CHECK"
      title="Screener ∩ ranker agreement"
      action={
        <span className="tnum font-mono text-[10px] text-mark-3">
          {n0(stocks.length)} of {n0((data as any)?.universeSize)} pass
        </span>
      }
      dense
    >
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Names the screener layer and the independent quant ranker both rate highly. Agreement between two
        differently-built systems is the strongest non-price evidence on this desk — but it is still
        correlation, not proof, and past agreement does not guarantee the next one.
      </p>
      <DataTable
        rows={stocks}
        getKey={(r: any) => r.symbol}
        isLoading={isLoading}
        error={error}
        onRetry={retry}
        initialSort={{ key: 'score', dir: 'desc' }}
        maxHeight="calc(100vh - 240px)"
        emptyLabel="No cross-confirmed names in the latest run"
        columns={CONFLUENCE_COLUMNS}
      />
    </Panel>
  );
}

const CONFLUENCE_COLUMNS = [
  { key: 'symbol', header: 'Symbol', sort: (r: any) => r.symbol, cell: (r: any) => <SymbolLink symbol={r.symbol} /> },
  {
    key: 'score',
    header: 'Unified',
    align: 'right' as const,
    sort: (r: any) => num(r.unified_score),
    cell: (r: any) => (
      <span className="tnum font-mono font-semibold text-marigold">{num(r.unified_score)?.toFixed(1) ?? DASH}</span>
    ),
  },
  {
    key: 'conv',
    header: 'Conviction',
    sort: (r: any) => r.conviction_level,
    cell: (r: any) => (
      <span className="font-mono text-[10px] text-mark-2">{String(r.conviction_level ?? '').replace('_', ' ')}</span>
    ),
  },
  {
    key: 'class',
    header: 'Call',
    sort: (r: any) => r.classification,
    cell: (r: any) => (
      <span
        className={cn(
          'text-[11px]',
          /buy/i.test(String(r.classification))
            ? 'text-up'
            : /sell/i.test(String(r.classification))
              ? 'text-down'
              : 'text-mark-3',
        )}
      >
        {r.classification ?? DASH}
      </span>
    ),
  },
  { key: 'sector', header: 'Sector', hideBelow: 'lg' as const, sort: (r: any) => r.sector ?? '', cell: (r: any) => (
    <span className="text-mark-3">{r.sector ?? DASH}</span>
  ) },
  { key: 'horizon', header: 'Horizon', hideBelow: 'xl' as const, sort: (r: any) => r.timeframe ?? '', cell: (r: any) => (
    <span className="font-mono text-[10px] text-mark-3">{r.timeframe ?? DASH}</span>
  ) },
];

function CategoryStats({ horizon }: { horizon: Horizon }) {
  const { data, isLoading } = trpc.getScreenerCategoryStats.useQuery({ horizon }, { staleTime: 30 * 60_000 });
  const rows: any[] = Array.isArray(data) ? data : [];

  // Mean of per-screener averages, not a pooled mean. A category with 40 screens
  // and a category with 2 should contribute one roll-up each - pooling would let
  // the large category silently dominate the chart.
  const byCategory = useMemo(() => {
    const m = new Map<string, { n: number; win: number; alpha: number }>();
    for (const r of rows) {
      const k = r.category ?? 'uncategorised';
      const cur = m.get(k) ?? { n: 0, win: 0, alpha: 0 };
      cur.n += 1;
      cur.win += num(r.avg_win_rate) ?? 0;
      cur.alpha += num(r.avg_alpha) ?? 0;
      m.set(k, cur);
    }
    return [...m.entries()]
      .map(([k, v]) => ({ k, n: v.n, win: v.n ? v.win / v.n : null, alpha: v.n ? v.alpha / v.n : null }))
      .sort((a, b) => (b.win ?? 0) - (a.win ?? 0));
  }, [rows]);
  const maxWin = Math.max(0.01, ...byCategory.map((c) => c.win ?? 0));

  return (
    <Panel accent eyebrow="ROLL-UP" title="Which screen categories actually work" dense>
      {byCategory.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[11px] text-mark-4">
          {isLoading ? 'Loading category statistics...' : 'No category statistics computed yet.'}
        </p>
      ) : (
        <div className="p-3.5">
          <p className="mb-3 text-[10px] leading-relaxed text-mark-3">
            Mean realised win rate per screener category. A category whose average screen sits below 50% is
            actively costing money - the desk shows that rather than quietly filtering it out.
          </p>
          <div className="space-y-0.5">
            {byCategory.map((c) => (
              <BarRow
                key={c.k}
                label={c.k}
                value={c.win}
                max={maxWin}
                tone={(c.win ?? 0) >= 0.55 ? 'bg-up/70' : (c.win ?? 0) >= 0.45 ? 'bg-marigold/60' : 'bg-down/50'}
                right={frac(c.win)}
                sub={String(c.n)}
              />
            ))}
          </div>
          <div className="mt-3 grid grid-cols-2 gap-3 border-t border-line pt-3 sm:grid-cols-4">
            {byCategory.slice(0, 4).map((c) => (
              <div key={c.k} className="min-w-0">
                <div className="truncate text-[9px] tracking-[0.12em] text-mark-4 uppercase">{c.k}</div>
                <div className="tnum font-mono text-[12px] text-mark-2">
                  {c.alpha === null ? DASH : pct(c.alpha)}{' '}
                  <span className="text-[9px] text-mark-4">alpha</span>
                </div>
                <Meter value={(c.win ?? 0) * 100} height="h-1" tone="bg-white/10" />
              </div>
            ))}
          </div>
        </div>
      )}
    </Panel>
  );
}

function Trending() {
  // Takes no input — `.query(async () => ...)` with no `.input()`.
  const { data, isLoading } = trpc.getTrendingScreeners.useQuery(undefined, { staleTime: 10 * 60_000 });
  const list: any[] = (data as any)?.topTrendingScreeners ?? [];

  return (
    <Panel
      eyebrow="ATTENTION"
      title="What the crowd is running"
      action={<Chip tone="neutral">{String((data as any)?.resultDate ?? '')}</Chip>}
      dense
    >
      <p className="border-b border-line bg-ink-900/40 px-3.5 py-2 text-[10px] leading-relaxed text-mark-3">
        Popularity, not performance. A useful map of where retail attention sits - and a useful warning when
        a crowded screen is also a late one.
      </p>
      {list.length === 0 ? (
        <p className="px-3.5 py-8 text-center text-[11px] text-mark-4">
          {isLoading ? 'Loading...' : 'No trending screeners available.'}
        </p>
      ) : (
        <ul className="tala-scroll max-h-[calc(100vh-240px)] overflow-y-auto">
          {list.map((s: any, i: number) => (
            <li key={s.screenerDisplayName + '-' + i} className="flex items-start gap-3 border-b border-line/50 px-3.5 py-2.5 last:border-0">
              <span className="tnum w-5 shrink-0 font-mono text-[12px] font-bold text-marigold/70">{i + 1}</span>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] text-mark">{s.screenerDisplayName}</div>
                <div className="mt-0.5 line-clamp-2 text-[10px] leading-snug text-mark-4">{s.shortDescription}</div>
              </div>
              <div className="shrink-0 text-right">
                <div className="tnum font-mono text-[12px] text-mark-2">{n0(s.resultCount)}</div>
                <div className="text-[9px] text-mark-4">matches</div>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Panel>
  );
}
