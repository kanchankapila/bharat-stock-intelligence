import React from 'react';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { QueryError } from './IntelligenceQueryError';
import { DataTable, type Column } from './DataTable';
import { DataHealthChip } from './DataHealthChip';
import { cn } from '../lib/utils';

// fetchMarketMap (src/server/marketData.ts) hits MoneyControl's marketmap feed and returns
// { item: [{ id, shortname, mktcap, lastvalue, change, percentchange, direction, ... }] }.
// With type=1 (the only mode the procedure exposes) that is SECTOR-level: mktcap is a
// comma-formatted string in Rs crore and lastvalue is "0". There is no stock-level payload
// here, so this page deliberately renders a sector treemap and says so.
type MapItem = {
  id?: string;
  shortname?: string;
  mktcap?: string;
  lastvalue?: string;
  change?: string;
  percentchange?: string;
  direction?: string;
};

export type MapCell = {
  key: string;
  name: string;
  mktcap: number;
  changePct: number;
};

type Rect = { cell: MapCell; x: number; y: number; w: number; h: number };

const INDEX_CHOICES = [
  { id: '9', name: 'NIFTY 50' },
  { id: '7', name: 'NIFTY 500' },
  { id: '6', name: 'NIFTY NEXT 50' },
  { id: '23', name: 'NIFTY BANK' },
  { id: '19', name: 'NIFTY IT' },
  { id: '38', name: 'NIFTY ENERGY' },
  { id: '52', name: 'NIFTY AUTO' },
  { id: '41', name: 'NIFTY PHARMA' },
  { id: '39', name: 'NIFTY FMCG' },
  { id: '51', name: 'NIFTY METAL' },
  { id: '35', name: 'NIFTY INFRA' },
  { id: '34', name: 'NIFTY REALTY' },
];

// MoneyControl returns market cap as a grouped string ("4,991,143.72").
export function parseMktcap(raw: unknown): number {
  if (typeof raw === 'number') return raw;
  if (typeof raw !== 'string') return 0;
  const n = Number(raw.replace(/,/g, ''));
  return Number.isFinite(n) ? n : 0;
}

// Recursive slice-and-dice treemap: split the largest remaining dimension at the point that
// balances area between the two groups. Deterministic, ~O(n log n), and needs no dependency
// beyond what is already installed.
export function layout(items: MapCell[], x: number, y: number, w: number, h: number, out: Rect[]): void {
  if (items.length === 0 || w <= 0 || h <= 0) return;
  if (items.length === 1) {
    out.push({ cell: items[0], x, y, w, h });
    return;
  }
  const total = items.reduce((s, i) => s + i.mktcap, 0);
  if (total <= 0) return;

  let acc = 0;
  let splitIndex = 0;
  for (let i = 0; i < items.length - 1; i += 1) {
    acc += items[i].mktcap;
    splitIndex = i;
    if (acc >= total / 2) break;
  }
  const head = items.slice(0, splitIndex + 1);
  const tail = items.slice(splitIndex + 1);
  if (tail.length === 0) {
    out.push({ cell: items[0], x, y, w, h });
    return;
  }
  const headValue = head.reduce((s, i) => s + i.mktcap, 0);
  const ratio = headValue / total;

  if (w >= h) {
    layout(head, x, y, w * ratio, h, out);
    layout(tail, x + w * ratio, y, w * (1 - ratio), h, out);
  } else {
    layout(head, x, y, w, h * ratio, out);
    layout(tail, x, y + h * ratio, w, h * (1 - ratio), out);
  }
}

// Diverging scale around 0: deep rose at <= -2%, deep emerald at >= +2%, neutral at 0.
export function heatColor(changePct: number): string {
  const clamped = Math.max(-2, Math.min(2, changePct));
  const t = Math.abs(clamped) / 2;
  if (clamped >= 0) {
    const g = Math.round(70 + 115 * t);
    return `rgba(16, ${g}, 129, ${(0.22 + 0.55 * t).toFixed(3)})`;
  }
  const r = Math.round(120 + 124 * t);
  return `rgba(${r}, 63, 94, ${(0.22 + 0.55 * t).toFixed(3)})`;
}

function Treemap({ cells, height, onSelect }: { cells: MapCell[]; height: number; onSelect?: (c: MapCell) => void }) {
  const [hover, setHover] = React.useState<MapCell | null>(null);
  const rects = React.useMemo(() => {
    if (cells.length === 0) return [] as Rect[];
    const sorted = [...cells].sort((a, b) => b.mktcap - a.mktcap);
    const out: Rect[] = [];
    layout(sorted, 0, 0, 100, 100, out);
    return out;
  }, [cells]);

  if (rects.length === 0) {
    return <p className="bsi-intel-note">No sector rows returned for this index.</p>;
  }

  const totalCap = cells.reduce((s, c) => s + c.mktcap, 0);

  return (
    <div>
      <div className="relative w-full overflow-hidden rounded-xl border border-[var(--bsi-border)]" style={{ height }}>
        {rects.map(r => {
          const wPct = Math.abs(r.w);
          const hPct = Math.abs(r.h);
          const areaShare = totalCap > 0 ? r.cell.mktcap / totalCap : 0;
          const showLabel = wPct > 7 && hPct > 9;
          return (
            <button
              key={r.cell.key}
              type="button"
              onClick={onSelect ? () => onSelect(r.cell) : undefined}
              onMouseEnter={() => setHover(r.cell)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(r.cell)}
              onBlur={() => setHover(null)}
              aria-label={`${r.cell.name}: ${r.cell.changePct >= 0 ? 'up' : 'down'} ${r.cell.changePct.toFixed(2)} percent, market cap ${Math.round(r.cell.mktcap).toLocaleString('en-IN')} crore`}
              style={{
                left: `${r.x}%`,
                top: `${r.y}%`,
                width: `${wPct}%`,
                height: `${hPct}%`,
                background: heatColor(r.cell.changePct),
              }}
              className="absolute overflow-hidden border border-black/30 p-1.5 text-left transition-[filter] hover:brightness-125 focus-visible:brightness-125"
            >
              {showLabel && (
                <>
                  <span className="block truncate text-[10px] font-semibold leading-tight text-white">{r.cell.name}</span>
                  <span className="block font-mono text-[10px] leading-tight text-white/80">
                    {r.cell.changePct >= 0 ? '+' : ''}{r.cell.changePct.toFixed(2)}%
                  </span>
                  {hPct > 14 && (
                    <span className="block font-mono text-[9px] leading-tight text-white/60">
                      {(areaShare * 100).toFixed(1)}% of cap
                    </span>
                  )}
                </>
              )}
            </button>
          );
        })}
      </div>
      <div className="mt-2 flex flex-wrap items-center gap-3">
        <div className="flex items-center gap-2">
          <span className="bsi-intel-note">Down</span>
          {[-2, -1, -0.5, 0, 0.5, 1, 2].map(v => (
            <span
              key={v}
              title={`${v > 0 ? '+' : ''}${v}%`}
              className="inline-block h-3 w-6 rounded-sm border border-black/30"
              style={{ background: heatColor(v) }}
            />
          ))}
          <span className="bsi-intel-note">Up</span>
        </div>
        <span className="bsi-intel-note">Area is proportional to sector market cap. Colour is the session move.</span>
      </div>
      {hover && (
        <p className="bsi-intel-note mt-2">
          <span className="text-white font-semibold">{hover.name}</span> — market cap ₹{Math.round(hover.mktcap).toLocaleString('en-IN')} Cr
          {totalCap > 0 && ` (${((hover.mktcap / totalCap) * 100).toFixed(1)}% of the mapped universe)`}, session move {hover.changePct >= 0 ? '+' : ''}{hover.changePct.toFixed(2)}%.
        </p>
      )}
    </div>
  );
}

const SECTOR_COLUMNS: Column<Record<string, unknown>>[] = [
  { key: 'name', label: 'Sector', sortable: true },
  { key: 'changePct', label: 'Session move', sortable: true, align: 'right', render: r => {
    const v = r.changePct as number;
    return <span className={v >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]'}>{v >= 0 ? '+' : ''}{v.toFixed(2)}%</span>;
  } },
  { key: 'mktcap', label: 'Market cap (Rs Cr)', sortable: true, align: 'right', render: r => Math.round(r.mktcap as number).toLocaleString('en-IN') },
  { key: 'share', label: 'Share of mapped cap', sortable: true, align: 'right', render: r => `${((r.share as number) * 100).toFixed(1)}%` },
];

export default function MarketMapPage() {
  const [indId, setIndId] = React.useState('9');
  const query = trpc.getMarketMapData.useQuery({ indId }, { staleTime: 120_000 });

  const cells = React.useMemo<MapCell[]>(() => {
    const items = (query.data as { item?: MapItem[] } | undefined)?.item ?? [];
    return items
      .map(i => ({
        key: String(i.id ?? i.shortname ?? 'unknown'),
        name: String(i.shortname ?? i.id ?? 'Unknown'),
        mktcap: parseMktcap(i.mktcap),
        changePct: Number(i.percentchange ?? 0),
      }))
      .filter(c => c.mktcap > 0)
      .sort((a, b) => b.mktcap - a.mktcap);
  }, [query.data]);

  const totalCap = cells.reduce((s, c) => s + c.mktcap, 0);
  const advancing = cells.filter(c => c.changePct > 0).length;
  const declining = cells.filter(c => c.changePct < 0).length;
  const avgMove = cells.length > 0 ? cells.reduce((s, c) => s + c.changePct, 0) / cells.length : 0;
  const leaders = React.useMemo(() => [...cells].sort((a, b) => b.changePct - a.changePct), [cells]);

  const tableRows = React.useMemo(
    () => cells.map(c => ({ name: c.name, changePct: c.changePct, mktcap: c.mktcap, share: totalCap > 0 ? c.mktcap / totalCap : 0 })),
    [cells, totalCap],
  );

  const selectedName = INDEX_CHOICES.find(i => i.id === indId)?.name ?? indId;

  return (
    <V1PageFrame title="Market Map" kicker="SECTOR TREEMAP · CAP-WEIGHTED · LIVE">
      <div className="space-y-6">
        <div className="bsi-intel-hero">
          <div>
            <span className="bsi-intel-eyebrow">07 / MARKET STRUCTURE</span>
            <h2 className="font-display text-2xl sm:text-3xl mt-2">Where the money is moving.</h2>
            <p className="bsi-intel-note mt-2">
              Every sector mapped by market cap and coloured by its session move — the fastest read on breadth, concentration and rotation.
            </p>
          </div>
          <label className="bsi-intel-note">
            Index universe
            <select className="bsi-control block mt-2" value={indId} onChange={e => setIndId(e.target.value)}>
              {INDEX_CHOICES.map(c => <option key={c.id} value={c.id}>{c.name}</option>)}
            </select>
          </label>
        </div>

        {query.isError && <QueryError retry={() => void query.refetch()} />}

        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
          <div className="bsi-kpi p-4">
            <span className="bsi-kpi-label">Sectors mapped</span>
            <span className="bsi-kpi-value block">{query.isLoading ? '—' : cells.length}</span>
          </div>
          <div className="bsi-kpi bsi-kpi-up p-4">
            <span className="bsi-kpi-label">Advancing</span>
            <span className="bsi-kpi-value block text-[var(--bsi-up)]">{query.isLoading ? '—' : advancing}</span>
          </div>
          <div className="bsi-kpi bsi-kpi-down p-4">
            <span className="bsi-kpi-label">Declining</span>
            <span className="bsi-kpi-value block text-[var(--bsi-down)]">{query.isLoading ? '—' : declining}</span>
          </div>
          <div className="bsi-kpi p-4">
            <span className="bsi-kpi-label">Average move</span>
            <span className={cn('bsi-kpi-value block', avgMove >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
              {query.isLoading ? '—' : `${avgMove >= 0 ? '+' : ''}${avgMove.toFixed(2)}%`}
            </span>
          </div>
        </div>

        <div className="bsi-intel-panel">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
            <h3 className="font-display">{selectedName} sector treemap</h3>
            <DataHealthChip lastUpdated={query.dataUpdatedAt ? new Date(query.dataUpdatedAt).toISOString() : null} staleThresholdMinutes={30} />
          </div>
          {query.isLoading ? (
            <div className="h-[380px] w-full animate-pulse rounded-xl bg-slate-900/50" />
          ) : (
            <Treemap cells={cells} height={380} />
          )}
        </div>

        {!query.isLoading && cells.length > 0 && (
          <div className="grid gap-4 lg:grid-cols-3">
            <div className="bsi-intel-panel lg:col-span-1">
              <h3 className="font-display mb-3">Leadership</h3>
              <ul className="space-y-2">
                {leaders.slice(0, 5).map(c => (
                  <li key={c.key} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-slate-300">{c.name}</span>
                    <span className={cn('font-mono', c.changePct >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
                      {c.changePct >= 0 ? '+' : ''}{c.changePct.toFixed(2)}%
                    </span>
                  </li>
                ))}
              </ul>
              <h3 className="font-display mb-3 mt-5">Lagging</h3>
              <ul className="space-y-2">
                {leaders.slice(-5).reverse().map(c => (
                  <li key={c.key} className="flex items-center justify-between gap-3 text-xs">
                    <span className="truncate text-slate-300">{c.name}</span>
                    <span className={cn('font-mono', c.changePct >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
                      {c.changePct >= 0 ? '+' : ''}{c.changePct.toFixed(2)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <div className="bsi-intel-panel lg:col-span-2">
              <h3 className="font-display mb-3">Sector detail</h3>
              <DataTable data={tableRows} columns={SECTOR_COLUMNS} searchable searchKeys={['name']} rowKey={r => String(r.name)} emptyMessage="No sector rows returned." />
            </div>
          </div>
        )}

        <p className="bsi-intel-note">
          Sector-level only: the upstream marketmap feed leaves its per-stock detail array empty, so this page does not imply stock-level granularity it cannot source. Market caps are vendor figures in Rs crore. NOT FINANCIAL ADVICE.
        </p>
      </div>
    </V1PageFrame>
  );
}
