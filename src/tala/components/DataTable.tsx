import { useMemo, useState, type ReactNode } from 'react';
import { ArrowDown, ArrowUp, ChevronsUpDown } from 'lucide-react';
import { cn } from '../lib/utils';
import { num } from '../lib/format';
import { Skeleton, EmptyState, ErrorState } from './Primitives';

export interface Column<T> {
  key: string;
  header: string;
  /** Cell renderer. Keep it terse — this table is a scanning surface, not a page. */
  cell: (row: T) => ReactNode;
  /** Supplying a sort accessor turns the column sortable. */
  sort?: (row: T) => number | string | null;
  align?: 'left' | 'right' | 'center';
  width?: string;
  /** Hide below this breakpoint to keep the table usable on a laptop. */
  hideBelow?: 'sm' | 'md' | 'lg' | 'xl';
}

const HIDE = {
  sm: 'hidden sm:table-cell',
  md: 'hidden md:table-cell',
  lg: 'hidden lg:table-cell',
  xl: 'hidden xl:table-cell',
} as const;

/**
 * The desk's one table. Sticky header, sortable columns, monospaced numerics and
 * a staggered row entrance — the four things that make a 200-row scan of numbers
 * actually workable rather than a wall.
 */
export function DataTable<T>({
  rows,
  columns,
  getKey,
  isLoading,
  error,
  onRetry,
  emptyLabel = 'No rows',
  emptyHint,
  initialSort,
  onRowClick,
  rowTone,
  maxHeight,
  dense,
}: {
  rows: T[] | undefined;
  columns: Column<T>[];
  getKey: (row: T, index: number) => string;
  isLoading?: boolean;
  error?: unknown;
  onRetry?: () => void;
  emptyLabel?: string;
  emptyHint?: string;
  initialSort?: { key: string; dir: 'asc' | 'desc' };
  onRowClick?: (row: T) => void;
  rowTone?: (row: T) => string | undefined;
  maxHeight?: string;
  dense?: boolean;
}) {
  const [sort, setSort] = useState(initialSort ?? null);

  const sorted = useMemo(() => {
    if (!rows) return [];
    if (!sort) return rows;
    const col = columns.find((c) => c.key === sort.key);
    if (!col?.sort) return rows;
    const dir = sort.dir === 'asc' ? 1 : -1;
    return [...rows].sort((a, b) => {
      const av = col.sort!(a);
      const bv = col.sort!(b);
      // Nulls always sort last regardless of direction — a missing number is not
      // "smallest", and letting it float to the top of a descending sort reads as
      // "best score" when it means the exact opposite.
      if (av === null || av === undefined) return 1;
      if (bv === null || bv === undefined) return -1;
      if (typeof av === 'number' && typeof bv === 'number') return (av - bv) * dir;
      return String(av).localeCompare(String(bv)) * dir;
    });
  }, [rows, sort, columns]);

  const toggle = (key: string) => {
    setSort((s) =>
      s?.key === key ? (s.dir === 'desc' ? { key, dir: 'asc' } : null) : { key, dir: 'desc' },
    );
  };


  if (error) {
    return (
      <div className="p-3">
        <ErrorState error={error} onRetry={onRetry} />
      </div>
    );
  }

  if (isLoading && (!rows || rows.length === 0)) {
    return (
      <div className="divide-y divide-line">
        {Array.from({ length: 8 }).map((_, i) => (
          <div key={i} className="flex items-center gap-3 px-3.5 py-2.5">
            <Skeleton className="h-3 w-20" />
            <Skeleton className="h-3 flex-1" />
            <Skeleton className="h-3 w-14" />
            <Skeleton className="h-3 w-14" />
          </div>
        ))}
      </div>
    );
  }

  if (!sorted.length) return <EmptyState label={emptyLabel} hint={emptyHint} />;

  return (
    <div className={cn('tala-scroll overflow-auto', maxHeight)}>
      <table className="w-full border-collapse text-[12px]">
        <thead className="sticky top-0 z-10 bg-ink-850/95 backdrop-blur-sm">
          <tr className="border-b border-line-2">
            {columns.map((c) => {
              const active = sort?.key === c.key;
              return (
                <th
                  key={c.key}
                  style={c.width ? { width: c.width } : undefined}
                  className={cn(
                    'px-3 py-2 text-[10px] font-semibold tracking-[0.12em] whitespace-nowrap text-mark-3 uppercase',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.hideBelow && HIDE[c.hideBelow],
                  )}
                >
                  {c.sort ? (
                    <button
                      onClick={() => toggle(c.key)}
                      className={cn(
                        'inline-flex items-center gap-1 transition-colors hover:text-mark',
                        active && 'text-marigold',
                        c.align === 'right' && 'flex-row-reverse',
                      )}
                    >
                      {c.header}
                      {active ? (
                        sort!.dir === 'desc' ? <ArrowDown size={10} /> : <ArrowUp size={10} />
                      ) : (
                        <ChevronsUpDown size={10} className="opacity-30" />
                      )}
                    </button>
                  ) : (
                    c.header
                  )}
                </th>
              );
            })}
          </tr>
        </thead>
        <tbody>
          {sorted.map((row, i) => (
            <tr
              key={getKey(row, i)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={cn(
                'tala-rise border-b border-line/60 transition-colors',
                onRowClick && 'cursor-pointer hover:bg-white/[0.035]',
                rowTone?.(row),
              )}
              style={{ animationDelay: `${Math.min(i, 24) * 14}ms` }}
            >
              {columns.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    'px-3 align-middle whitespace-nowrap',
                    dense ? 'py-1.5' : 'py-2.5',
                    c.align === 'right' ? 'text-right' : c.align === 'center' ? 'text-center' : 'text-left',
                    c.hideBelow && HIDE[c.hideBelow],
                  )}
                >
                  {c.cell(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** Extract a nested numeric for a sort accessor without the boilerplate at every
 *  column definition. */
export const byNum =
  (pick: (r: any) => unknown) =>
  (r: any): number | null =>
    num(pick(r));
