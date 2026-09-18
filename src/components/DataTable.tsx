import React from 'react';
import { cn } from '../lib/utils';
import { ChevronUp, ChevronDown, Search } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';

export interface Column<T> {
  key: string;
  label: string;
  render?: (item: T) => React.ReactNode;
  sortable?: boolean;
  width?: string;
  align?: 'left' | 'center' | 'right';
  className?: string;
}

export interface DataTableProps<T> {
  data: T[];
  columns: Column<T>[];
  isLoading?: boolean;
  emptyMessage?: string;
  searchable?: boolean;
  searchKeys?: string[];
  onRowClick?: (item: T) => void;
  className?: string;
  rowKey?: (item: T, index: number) => string;
  maxHeight?: string;
  dense?: boolean;
}

export function DataTable<T extends Record<string, unknown>>({
  data, columns, isLoading = false, emptyMessage = 'No data to display',
  searchable = false, searchKeys, onRowClick, className, rowKey,
  maxHeight = '480px', dense = false,
}: DataTableProps<T>) {
  const [sortConfig, setSortConfig] = React.useState<{ key: string; direction: 'asc' | 'desc' } | null>(null);
  const [search, setSearch] = React.useState('');

  const sortedData = React.useMemo(() => {
    if (!sortConfig) return data;
    return [...data].sort((a, b) => {
      const aVal = a[sortConfig.key], bVal = b[sortConfig.key];
      if (aVal == null) return 1;
      if (bVal == null) return -1;
      if (typeof aVal === 'number' && typeof bVal === 'number') return sortConfig.direction === 'asc' ? aVal - bVal : bVal - aVal;
      const cmp = String(aVal).toLowerCase().localeCompare(String(bVal).toLowerCase());
      return sortConfig.direction === 'asc' ? cmp : -cmp;
    });
  }, [data, sortConfig]);

  const filteredData = React.useMemo(() => {
    if (!searchable || !search) return sortedData;
    const keys = searchKeys ?? columns.map((column) => column.key);
    return sortedData.filter((item) => keys.some((key) =>
      item[key] != null && String(item[key]).toLowerCase().includes(search.toLowerCase()),
    ));
  }, [sortedData, search, searchable, searchKeys, columns]);

  const handleSort = (column: Column<T>) => {
    if (!column.sortable) return;
    setSortConfig((prev) => ({
      key: column.key,
      direction: prev?.key === column.key && prev.direction === 'desc' ? 'asc' : 'desc',
    }));
  };

  const rows = isLoading ? Array.from({ length: dense ? 5 : 8 }).map((_, i) => ({ __skeleton: true, _idx: i })) : filteredData;

  return (
    <div className={cn('w-full', className)}>
      {searchable && (
        <div className="relative mb-3">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-[var(--bsi-text-caption)]" />
          <input
            type="text" placeholder="Search..." value={search}
            onChange={(e) => setSearch(e.target.value)}
            className="w-full pl-8 pr-3 py-1.5 text-[11px] font-mono rounded-[var(--bsi-radius-sm)] bg-[var(--bsi-surface-1)] border border-[var(--bsi-border)] placeholder-[var(--bsi-text-caption)] text-[var(--bsi-text-secondary)] focus:outline-none focus:border-[var(--bsi-accent)] transition-colors"
          />
        </div>
      )}
      <div className={cn('overflow-auto rounded-[var(--bsi-radius-md)] border border-[var(--bsi-border)] bg-[var(--bsi-surface-1)]')} style={{ maxHeight }}>
        <table className="w-full border-collapse">
          <thead>
            <tr className="border-b border-[var(--bsi-border)]">
              {columns.map((col) => (
                <th
                  key={col.key}
                  className={cn(
                    'text-left text-[9px] font-semibold text-[var(--bsi-text-caption)] uppercase tracking-wider',
                    dense ? 'px-3 py-1.5' : 'px-3 py-2.5',
                    col.align === 'center' && 'text-center', col.align === 'right' && 'text-right',
                    col.sortable && 'cursor-pointer select-none', col.className,
                  )}
                  style={{ width: col.width }}
                  onClick={() => handleSort(col)}
                >
                  <div className="flex items-center gap-1">
                    {col.label}
                    {col.sortable && sortConfig?.key === col.key && (
                      <span className="text-[var(--bsi-accent)]">
                        {sortConfig.direction === 'asc' ? <ChevronUp className="w-2.5 h-2.5" /> : <ChevronDown className="w-2.5 h-2.5" />}
                      </span>
                    )}
                  </div>
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            <AnimatePresence>
              {rows.map((item, idx) => {
                const rowKeyStr = rowKey ? rowKey(item as T, idx) : String(idx);
                const isSkel = (item as any).__skeleton === true;
                return (
                  <motion.tr
                    key={rowKeyStr}
                    initial={{ opacity: 0, y: -4 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: 4 }}
                    transition={{ duration: 0.2, delay: idx * 0.01 }}
                    className={cn('border-b border-[var(--bsi-border)] last:border-0', onRowClick && 'cursor-pointer', 'hover:bg-[var(--bsi-accent-soft)]/30')}
                    onClick={() => !isSkel && onRowClick?.(item as T)}
                  >
                    {columns.map((col) => (
                      <td
                        key={col.key}
                        className={cn(
                          'text-[11px] text-[var(--bsi-text-secondary)] font-mono',
                          dense ? 'px-3 py-1.5' : 'px-3 py-2.5',
                          col.align === 'center' && 'text-center', col.align === 'right' && 'text-right',
                        )}
                      >
                        {isSkel ? (
                          <div className="h-3 w-3/4 bg-[var(--bsi-border-strong)] rounded animate-pulse-live" />
                        ) : col.render ? (
                          col.render(item as T)
                        ) : (
                          String(item[col.key as keyof T] ?? '—')
                        )}
                      </td>
                    ))}
                  </motion.tr>
                );
              })}
            </AnimatePresence>
          </tbody>
        </table>
      </div>
      {!isLoading && filteredData.length === 0 && (
        <div className="flex flex-col items-center justify-center gap-3 py-12 text-center mt-2">
          <div className="text-3xl text-[var(--bsi-text-caption)]">📊</div>
          <p className="text-[11px] text-[var(--bsi-text-caption)]">{emptyMessage}</p>
        </div>
      )}
    </div>
  );
}

DataTable.displayName = 'DataTable';

