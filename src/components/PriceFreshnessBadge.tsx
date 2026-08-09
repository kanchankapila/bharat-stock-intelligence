import React from 'react';
import { relativeFromNow, formatISTWithLocal, isStale } from '../lib/timeFormat';
import { cn } from '../lib/utils';

interface PriceFreshnessBadgeProps {
  /** ms epoch of the last successful fetch -- pass React Query's own `dataUpdatedAt` directly. */
  updatedAt: number | null | undefined;
  /** Default 5 min, matching liveStockData.ts's bulk quote cache TTL -- the real cadence behind
   * "live" prices platform-wide. Pass a tighter value (e.g. 30_000) for a query polling faster
   * than that, so "stale" still means something for it specifically. */
  thresholdMs?: number;
  label?: string;
  className?: string;
}

/**
 * Small "prices 3m ago" readout used next to any price/quote list, amber once past threshold.
 * Hovering shows the full IST timestamp (formatISTWithLocal already appends the viewer's own
 * local time when they're outside IST). Renders nothing until a first successful fetch has a
 * timestamp -- a loading skeleton has nothing true to say about freshness yet.
 */
export const PriceFreshnessBadge: React.FC<PriceFreshnessBadgeProps> = ({
  updatedAt,
  thresholdMs = 5 * 60_000,
  label = 'prices',
  className,
}) => {
  if (!updatedAt) return null;
  const stale = isStale(updatedAt, thresholdMs);
  return (
    <span
      className={cn('text-xs', stale ? 'text-amber-400 font-semibold' : 'text-slate-500', className)}
      title={formatISTWithLocal(updatedAt)}
    >
      {label} {relativeFromNow(updatedAt)}
      {stale ? ' — may be delayed' : ''}
    </span>
  );
};

export default PriceFreshnessBadge;
