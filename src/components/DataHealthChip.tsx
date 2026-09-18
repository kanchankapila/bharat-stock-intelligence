import React from 'react';
import { cn } from '../lib/utils';
import { formatDistanceToNow, parseISO } from 'date-fns';
import { Clock, CheckCircle2, AlertCircle, AlertOctagon } from 'lucide-react';

export type HealthStatus = 'fresh' | 'stale' | 'error' | 'unknown';

export interface DataHealthChipProps {
  lastUpdated: string | Date | null;
  staleThresholdMinutes?: number;
  className?: string;
  compact?: boolean;
  showIcon?: boolean;
}

const STALE_THRESHOLD_DEFAULT = 30;

export const DataHealthChip: React.FC<DataHealthChipProps> = ({
  lastUpdated,
  staleThresholdMinutes = STALE_THRESHOLD_DEFAULT,
  className,
  compact = false,
  showIcon = true,
}: DataHealthChipProps) => {
  if (!lastUpdated) {
    return (
      <span className={cn('bsi-healthchip bsi-healthchip-error', compact && 'text-[8px] px-1.5 py-0.25', className)}>
        {showIcon && <AlertOctagon className="w-2.5 h-2.5" />} No data
      </span>
    );
  }

  const date = typeof lastUpdated === 'string' ? parseISO(lastUpdated) : lastUpdated;
  if (isNaN(date.getTime())) {
    return (
      <span className={cn('bsi-healthchip bsi-healthchip-error', compact && 'text-[8px] px-1.5 py-0.25', className)}>
        {showIcon && <AlertCircle className="w-2.5 h-2.5" />} Invalid
      </span>
    );
  }

  const minutesAgo = Date.now() - date.getTime();
  const thresholdMs = staleThresholdMinutes * 60 * 1000;

  let status: HealthStatus;
  let label: string;

  if (minutesAgo < thresholdMs) {
    status = 'fresh';
    label = formatDistanceToNow(date, { addSuffix: true });
  } else if (minutesAgo < thresholdMs * 4) {
    status = 'stale';
    label = formatDistanceToNow(date, { addSuffix: true });
  } else {
    status = 'error';
    label = 'Stale data';
  }

  const iconMap: Record<HealthStatus, React.ElementType> = {
    fresh: CheckCircle2,
    stale: Clock,
    error: AlertOctagon,
    unknown: AlertCircle,
  };

  const Icon = iconMap[status];

  return (
    <span
      className={cn(
        'bsi-healthchip',
        status === 'fresh' && 'bsi-healthchip-fresh',
        status === 'stale' && 'bsi-healthchip-stale',
        status === 'error' && 'bsi-healthchip-error',
        compact && 'text-[8px] px-1.5 py-0.25',
        className,
      )}
      title={`Updated ${label}`}
    >
      {showIcon && <Icon className="w-2.5 h-2.5" />}
      <span className="ml-1">{label}</span>
    </span>
  );
};

DataHealthChip.displayName = 'DataHealthChip';
export default DataHealthChip;
