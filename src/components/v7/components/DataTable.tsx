import React, { useMemo, useState, useCallback } from 'react';
import { ChevronUp, ChevronDown, Search, Filter } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { DASH } from '../lib';

export type SortDirection = 'asc' | 'desc' | null;

export interface DataTableColumn<T> {
  key: string;
  label: string;
  width?: string | number;
  align?: 'left' | 'center' | 'right';
  sortable?: boolean;
  format?: (value: any, row: T) => string | React.ReactNode;
  className?: string;
}

export interface DataTableProps<T> {
  columns: DataTableColumn<T>[];
  data: T[];
  pageSize?: number;
  getRowId?: (row: T) => string;
  onRowClick?: (row: T) => void;
  rowClassName?: (row: T) => string;
  loading?: boolean;
  emptyTitle?: string;
  emptyText?: string;
}

function defaultGetRowId<T>(row: T): string {
  return String((row as any).symbol ?? (row as any).id ?? '');
}

export function DataTable<T extends Record<string, any>>({
  columns, data, pageSize = 25, getRowId = defaultGetRowId as (row: T) => string,
  onRowClick, rowClassName, loading, emptyTitle = 'No data available', emptyText = '',
}: DataTableProps<T>) {
  const [sort, setSort] = useState<{ key: string; dir: SortDirection } | null>(null);
  const [page, setPage] = useState(0);
  const [search, setSearch] = useState('');

  const sortableCols = useMemo(() => columns.filter((c) => c.sortable), [columns]);
  const filtered = useMemo(() => {
    if (!search) return data;
    const s = search.toLowerCase();
    return data.filter((row) => columns.some((c) => {
      const v = row[c.key];
      return v != null && String(v).toLowerCase().includes(s);
    }));
  }, [data, search, columns]);
  const sorted = useMemo(() => {
    if (!sort) return filtered;
    return [...filtered].sort((a, b) => {
      const av = a[sort.key], bv = b[sort.key];
      const an = Number(av), bn = Number(bv);
      const numeric = Number.isFinite(an) && Number.isFinite(bn) && String(av).trim() !== '' && String(bv).trim() !== '';
      let cmp: number = numeric ? an - bn : String(av ?? '').localeCompare(String(bv ?? ''));
      return sort.dir === 'asc' ? cmp : -cmp;
    });
  }, [filtered, sort]);
  const totalPages = Math.max(1, Math.ceil(sorted.length / pageSize));
  const currentPage = Math.min(page, totalPages - 1);
  const paged = useMemo(() => sorted.slice(currentPage * pageSize, (currentPage + 1) * pageSize), [sorted, currentPage, pageSize]);

  const handleSort = useCallback((key: string) => {
    setSort((prev) => (prev?.key === key && prev.dir === 'asc' ? { key, dir: 'desc' } : { key, dir: 'asc' }));
  }, []);

  if (loading) {
    return (<div className="v7-table-wrap"><div className="flex items-center justify-center h-64 text-slate-500 font-data">Loading…</div></div>);
  }
  if (sorted.length === 0) {
    return (
      <div className="v7-table-wrap"><div className="p-12 text-center">
        <Search className="w-10 h-10 mx-auto mb-3 text-slate-600" />
        <h4 className="text-sm font-semibold text-slate-300">{emptyTitle}</h4>
        {emptyText && <p className="text-xs text-slate-500 mt-1">{emptyText}</p>}
      </div></div>
    );
  }

  return (
    <>
      <div className="v7-table-wrap v7-scroll">
        <div className="overflow-auto">
          <table className="v7-table">
            <thead>
              <tr>
                {columns.map((col) => {
                  const isSorted = sort?.key === col.key;
                  return (
                    <th key={col.key} aria-sort={col.sortable ? (isSorted ? sort.dir === 'asc' ? 'ascending' : 'descending' : 'none') : undefined}
                      className={cn('select-none cursor-pointer transition-colors', col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : '', col.className, isSorted && 'text-accent')}
                      style={{ width: col.width }}>
                      <div className="flex items-center gap-1.5">
                        {col.sortable ? <button type="button" onClick={() => handleSort(col.key)}>{col.label}</button> : col.label}
                        {col.sortable && (
                          <span className="text-[10px]">
                            {isSorted ? (sort.dir === 'asc' ? <ChevronUp size={12} /> : <ChevronDown size={12} />) : (<> <ChevronUp size={12} className="text-slate-600/40" /> <ChevronDown size={12} className="text-slate-600/40" /></>)}
                          </span>
                        )}
                      </div>
                    </th>
                  );
                })}
              </tr>
            </thead>
            <tbody>
              {paged.map((row) => (
                <tr key={getRowId(row)} className={cn('group', rowClassName ? rowClassName(row) : '', onRowClick ? 'cursor-pointer hover:bg-white/[0.02] transition-colors' : '')}
                  tabIndex={onRowClick ? 0 : undefined}
                  onKeyDown={onRowClick ? (event) => {
                    if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); onRowClick(row); }
                  } : undefined}
                  onClick={() => onRowClick?.(row)}>
                  {columns.map((col) => {
                    const value = row[col.key];
                    const cell = col.format ? col.format(value, row) : (value == null ? DASH : value);
                    return (
                      <td key={col.key}
                        className={cn(col.align === 'center' ? 'text-center' : col.align === 'right' ? 'text-right' : '', col.key === 'symbol' ? 'v7-table-cell-symbol' : col.key === 'name' ? 'v7-table-cell-name' : '', col.className)}>
                        {cell}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
      <div className="mt-4 flex items-center justify-between gap-4 px-2">
        <div className="flex items-center gap-2 text-xs font-data text-slate-400">
          Showing <span className="text-slate-300 font-medium">{currentPage * pageSize + 1}</span> to{' '}
          <span className="text-slate-300 font-medium">{Math.min((currentPage + 1) * pageSize, sorted.length)}</span> of{' '}
          <span className="text-slate-300 font-medium">{sorted.length}</span>
        </div>
        <div className="flex items-center gap-2">
          <button disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}
            className="px-3 py-1.5 rounded-lg border border-slate-700/50 bg-slate-900/40 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed">Prev</button>
          <button disabled={currentPage >= totalPages - 1} onClick={() => setPage(currentPage + 1)}
            className="px-3 py-1.5 rounded-lg border border-slate-700/50 bg-slate-900/40 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-40 disabled:cursor-not-allowed">Next</button>
          <span className="px-2 py-1 rounded text-[10px] font-bold border border-slate-800/40 bg-slate-900/50 text-slate-400">{currentPage + 1} / {totalPages}</span>
        </div>
      </div>
      <div className="mt-2 flex items-center gap-3">
        <Search className=" w-4 h-4 text-slate-600 shrink-0" />
        <input type="search" name="row-filter" aria-label="Filter rows" placeholder="Filter rows…" value={search}
          onChange={(e) => { setSearch(e.target.value); setPage(0); }}
          className="v7-control w-[220px] text-xs" />
        {sortableCols.length > 0 && <Filter size={16} className="text-slate-500 shrink-0" />}
      </div>
    </>
  );
}
