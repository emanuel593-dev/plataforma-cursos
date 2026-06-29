import React, { useState } from 'react';
import { ChevronUp, ChevronDown } from 'lucide-react';
import { cn } from '../../lib/utils';
import EmptyState from './EmptyState';

/* ── Column definition ─────────────────────────────────────────────────── */

export interface Column<T> {
  /** Unique key (also used for sorting) */
  key: string;
  /** Header label */
  header: string;
  /** Cell renderer — receives the full row */
  cell: (row: T) => React.ReactNode;
  /** Optional card-mode renderer (defaults to cell) */
  cardCell?: (row: T) => React.ReactNode;
  /** Hide this column in card mode on mobile? */
  hideOnCard?: boolean;
  /** Custom header/cell className */
  headerClassName?: string;
  cellClassName?: string;
  /** Sort value extractor (string | number). If omitted column is not sortable */
  sortValue?: (row: T) => string | number;
}

export interface DataTableProps<T> {
  columns: Column<T>[];
  data: T[];
  /** Unique key extractor */
  keyExtractor: (row: T) => string;
  /** Click handler for a row / card */
  onRowClick?: (row: T) => void;
  /** Empty-state overrides */
  emptyIcon?: React.ReactNode;
  emptyTitle?: string;
  emptyDescription?: string;
  /** Extra className for outer wrapper */
  className?: string;
  /** Force a specific mode (default: auto — cards on <768px, table on ≥768px) */
  mode?: 'table' | 'cards' | 'auto';
}

/* ── Component ─────────────────────────────────────────────────────────── */

export default function DataTable<T>({
  columns,
  data,
  keyExtractor,
  onRowClick,
  emptyIcon,
  emptyTitle,
  emptyDescription,
  className,
  mode = 'auto',
}: DataTableProps<T>) {
  const [sortKey, setSortKey] = useState<string | null>(null);
  const [sortDir, setSortDir] = useState<'asc' | 'desc'>('asc');

  /* ── Sort logic ──────────────────────────────────────── */
  const sortedData = React.useMemo(() => {
    if (!sortKey) return data;
    const col = columns.find((c) => c.key === sortKey);
    if (!col?.sortValue) return data;
    const sorted = [...data].sort((a, b) => {
      const va = col.sortValue!(a);
      const vb = col.sortValue!(b);
      if (typeof va === 'number' && typeof vb === 'number') return va - vb;
      return String(va).localeCompare(String(vb), 'pt-BR');
    });
    return sortDir === 'desc' ? sorted.reverse() : sorted;
  }, [data, sortKey, sortDir, columns]);

  function toggleSort(key: string) {
    if (sortKey === key) {
      setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'));
    } else {
      setSortKey(key);
      setSortDir('asc');
    }
  }

  if (data.length === 0) {
    return (
      <EmptyState
        icon={emptyIcon}
        title={emptyTitle}
        description={emptyDescription}
      />
    );
  }

  /* ── Table (desktop) ─────────────────────────────────── */
  const table = (
    <div className={cn('glass-panel overflow-hidden', className)}>
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-white/8">
              {columns.map((col) => {
                const sortable = !!col.sortValue;
                const active = sortKey === col.key;
                return (
                  <th
                    key={col.key}
                    className={cn(
                      'px-4 py-3 text-left text-xs font-semibold text-iv-muted uppercase tracking-wider whitespace-nowrap',
                      sortable && 'cursor-pointer select-none hover:text-iv-text transition-colors',
                      col.headerClassName,
                    )}
                    onClick={sortable ? () => toggleSort(col.key) : undefined}
                  >
                    <span className="inline-flex items-center gap-1">
                      {col.header}
                      {sortable && active && (
                        sortDir === 'asc'
                          ? <ChevronUp size={12} className="text-iv-accent" />
                          : <ChevronDown size={12} className="text-iv-accent" />
                      )}
                    </span>
                  </th>
                );
              })}
            </tr>
          </thead>
          <tbody className="divide-y divide-white/5">
            {sortedData.map((row) => (
              <tr
                key={keyExtractor(row)}
                className={cn(
                  'hover:bg-white/[0.03] transition-colors',
                  onRowClick && 'cursor-pointer',
                )}
                onClick={onRowClick ? () => onRowClick(row) : undefined}
              >
                {columns.map((col) => (
                  <td key={col.key} className={cn('px-4 py-3 whitespace-nowrap', col.cellClassName)}>
                    {col.cell(row)}
                  </td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );

  /* ── Cards (mobile) ──────────────────────────────────── */
  const visibleCardCols = columns.filter((c) => !c.hideOnCard);

  const cards = (
    <div className={cn('space-y-2', className)}>
      {sortedData.map((row) => (
        <div
          key={keyExtractor(row)}
          className={cn(
            'glass-panel p-3 sm:p-4 space-y-2 sm:space-y-3',
            onRowClick && 'cursor-pointer hover:bg-white/[0.03] transition-colors',
          )}
          onClick={onRowClick ? () => onRowClick(row) : undefined}
        >
          {visibleCardCols.map((col) => (
            <div key={col.key} className="flex items-start justify-between gap-3">
              <span className="text-[11px] sm:text-xs font-semibold text-iv-muted uppercase tracking-wider shrink-0 max-w-[40%] break-words pt-0.5">
                {col.header}
              </span>
              <div className="text-[13px] sm:text-sm text-iv-text text-right flex-1 break-words overflow-hidden min-w-0">
                {col.cardCell ? col.cardCell(row) : col.cell(row)}
              </div>
            </div>
          ))}
        </div>
      ))}
    </div>
  );

  /* ── Mode resolution ────────────────────────────────── */
  if (mode === 'table') return table;
  if (mode === 'cards') return cards;

  // auto: table hidden on mobile, cards hidden on desktop
  return (
    <>
      <div className="hidden md:block">{table}</div>
      <div className="md:hidden">{cards}</div>
    </>
  );
}
