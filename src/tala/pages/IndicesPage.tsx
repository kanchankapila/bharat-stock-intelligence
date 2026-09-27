import { useMemo } from 'react';
import { TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { DASH, n0, num, pct } from '../lib/format';
import { Panel, Stat } from '../components/Primitives';

interface IndexRow {
  name: string;
  value: number | null;
  changePct: number | null;
}

/**
 * The index board: every Indian benchmark, the global backdrop, and breadth.
 *
 * An index level alone says almost nothing about whether to buy — a +0.3% day on
 * 52% of stocks above their 200-DMA is a very different tape from the same number
 * on 80%. Breadth therefore gets its own panel rather than being a footnote, and
 * the India VIX is framed as a volatility-regime input, not a direction.
 */
export default function IndicesPage() {
  const { data, isLoading, error, refetch } = trpc.getAllIndices.useQuery(undefined, {
    staleTime: 30_000,
    refetchInterval: 60_000,
  });
  const { data: global } = trpc.getGlobalIndices.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 120_000,
  });
  const { data: ad } = trpc.getIndexAdvanceDecline.useQuery(undefined, { staleTime: 60_000 });
  const { data: vix } = trpc.getIndiaVix.useQuery(undefined, { staleTime: 60_000, refetchInterval: 120_000 });
  const { data: sectors } = trpc.getSectorsOverview.useQuery(undefined, {
    staleTime: 60_000,
    refetchInterval: 120_000,
  });

  // Upstream shapes nest differently per vendor revision; each reader tries the
  // known paths in order so a shape change degrades this page to "no data" rather
  // than throwing during render.
  const groups: { name: string; list: IndexRow[] }[] = useMemo(() => {
    const g: any = data;
    const lists: any[] = g?.data?.indiceList ?? g?.indiceList ?? [];
    return Array.isArray(lists) ? lists : [];
  }, [data]);

  const globalList: IndexRow[] = useMemo(() => {
    const g: any = global;
    const lists: any[] = g?.data?.indiceList ?? g?.indiceList ?? [];
    return Array.isArray(lists) ? lists.flatMap((l: any) => l.list ?? []) : [];
  }, [global]);

  const adRows: any[] = useMemo(() => {
    const d: any = ad;
    const list = d?.data?.list ?? d?.list ?? (Array.isArray(d?.data) ? d.data : []);
    return Array.isArray(list) ? list : [];
  }, [ad]);

  const sectorList: any[] = (sectors as any)?.sectors ?? [];
  const vixValue = num((vix as any)?.value ?? (vix as any)?.data?.value ?? (vix as any)?.close);
  const retry = () => {
    void (refetch() as Promise<unknown>).catch(() => {});
  };

  return (
    <div className="tala-rise space-y-3 p-3">
      <div className="grid gap-3 lg:grid-cols-4">
        <IndexHeadline title="India VIX" value={vixValue} sub="volatility regime" />
        <IndexHeadline title="Index groups" value={groups.length} sub="live" />
        <IndexHeadline title="Global boards" value={globalList.length} sub="overnight" />
        <IndexHeadline
          title="Sectors tracked"
          value={sectorList.length}
          sub={(sectors as any)?.marketRegime ? `regime ${(sectors as any).marketRegime}` : undefined}
        />
      </div>

      <div className="grid gap-3 lg:grid-cols-3">
        {groups.map((g) => (
          <Panel key={g.name} dense eyebrow="INDIA" title={g.name}>
            <Board rows={g.list} isLoading={isLoading} error={error} onRetry={retry} />
          </Panel>
        ))}
      </div>

      {globalList.length > 0 && (
        <Panel dense eyebrow="GLOBAL" title="Overnight backdrop">
          <Board rows={globalList} />
        </Panel>
      )}

      {adRows.length > 0 && (
        <Panel dense eyebrow="BREADTH" title="Index advance / decline">
          <div className="grid grid-cols-2 gap-2 p-3.5 sm:grid-cols-3 lg:grid-cols-4">
            {adRows.map((r, i) => {
              const adv = num(r.advance) ?? 0;
              const dec = num(r.decline) ?? 0;
              const ratio = adv / (adv + dec || 1);
              return (
                <div key={i} className="min-w-0 rounded border border-line bg-ink-900/40 p-2.5">
                  <div className="truncate text-[10px] text-mark-3">{r.indexName ?? r.index_name ?? '—'}</div>
                  <div className="mt-1 flex items-baseline gap-1.5">
                    <span className="tnum font-mono text-[13px] font-semibold text-up">{adv}</span>
                    <span className="text-mark-4">/</span>
                    <span className="tnum font-mono text-[13px] font-semibold text-down">{dec}</span>
                  </div>
                  <div className="mt-1.5 flex h-1 overflow-hidden rounded-full bg-white/[0.05]">
                    <div className="bg-up/70" style={{ width: `${ratio * 100}%` }} />
                  </div>
                </div>
              );
            })}
          </div>
        </Panel>
      )}

      {sectorList.length > 0 && (
        <Panel dense eyebrow="SECTORS" title="Sector index board">
          <div className="grid grid-cols-2 gap-2 p-3.5 sm:grid-cols-3 lg:grid-cols-6">
            {sectorList.map((s) => (
              <div key={s.id} className="min-w-0 rounded border border-line bg-ink-900/40 p-2.5">
                <div className="truncate text-[10px] text-mark-3">{s.name}</div>
                <div className="tnum mt-0.5 truncate font-mono text-[13px] text-mark">
                  {n0(s.niftyBaseline?.value, 0)}
                </div>
                <div
                  className={cn(
                    'tnum font-mono text-[10px]',
                    (num(s.niftyBaseline?.changePct) ?? 0) >= 0 ? 'text-up' : 'text-down',
                  )}
                >
                  {pct(s.niftyBaseline?.changePct)}
                </div>
              </div>
            ))}
          </div>
        </Panel>
      )}
    </div>
  );
}

function IndexHeadline({ title, value, sub }: { title: string; value: number | null; sub?: string }) {
  const v = num(value);
  return (
    <Panel dense>
      <Stat label={title} value={v === null ? DASH : n0(v, v < 1000 ? 2 : 0)} size="xl" sub={sub} />
    </Panel>
  );
}


function Board({
  rows,
  isLoading,
  error,
  onRetry,
}: {
  rows: IndexRow[];
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
}) {
  if (error) {
    return (
      <div className="px-3.5 py-4 text-[11px] text-down">
        Index board unavailable - {String((error as any)?.message ?? '').slice(0, 90)}
        {onRetry && (
          <button onClick={onRetry} className="ml-2 rounded border border-line-2 px-1.5 py-0.5 font-mono text-[9px]">
            RETRY
          </button>
        )}
      </div>
    );
  }
  if (isLoading && !rows?.length) {
    return (
      <div className="space-y-2 p-3.5">
        {Array.from({ length: 5 }).map((_, i) => (
          <div key={i} className="tala-live-dot h-4 rounded bg-white/[0.06]" />
        ))}
      </div>
    );
  }
  if (!rows?.length) return <p className="px-3.5 py-6 text-center text-[11px] text-mark-4">No index data.</p>;

  return (
    <ul className="tala-scroll max-h-[340px] overflow-y-auto">
      {rows.map((r, i) => {
        const up = (num(r.changePct) ?? 0) >= 0;
        return (
          <li
            key={r.name + '-' + i}
            className="tala-rise flex items-center gap-2 border-b border-line/50 px-3.5 py-1.5 last:border-0"
            style={{ animationDelay: Math.min(i, 14) * 14 + 'ms' }}
          >
            {up ? (
              <TrendingUp size={10} className="shrink-0 text-up" />
            ) : (
              <TrendingDown size={10} className="shrink-0 text-down" />
            )}
            <span className="min-w-0 flex-1 truncate text-[11px] text-mark-2">{r.name}</span>
            <span className="tnum shrink-0 font-mono text-[11px] text-mark">{n0(r.value, 2)}</span>
            <span
              className={cn(
                'tnum w-14 shrink-0 text-right font-mono text-[11px] font-semibold',
                up ? 'text-up' : 'text-down',
              )}
            >
              {pct(r.changePct)}
            </span>
          </li>
        );
      })}
    </ul>
  );
}
