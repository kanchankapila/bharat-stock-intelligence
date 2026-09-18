import React from 'react';
import { cn } from '../lib/utils';
import { TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { Variants } from 'motion/react';
import { motion } from 'motion/react';

export type Direction = 'up' | 'down' | 'neutral';
export type Size = 'sm' | 'md' | 'lg';

export interface MetricTileProps {
  label: string;
  value: string | number;
  change?: string;
  direction?: Direction;
  prefix?: string;
  suffix?: string;
  icon?: React.ReactNode;
  sparkline?: Array<{ value: number }>;
  health?: 'fresh' | 'stale' | 'error' | string;
  sparklineColor?: string;
  className?: string;
  onClick?: () => void;
  loading?: boolean;
  size?: Size;
}

const SIZE_CLASSES: Record<Size, string> = {
  sm: 'bsi-kpi p-3',
  md: 'bsi-kpi p-4',
  lg: 'bsi-kpi p-5',
};

const DIRECTION_ICONS: Record<Direction, React.ElementType> = {
  up: TrendingUp,
  down: TrendingDown,
  neutral: Minus,
};

const DIRECTION_COLORS: Record<Direction, string> = {
  up: 'text-[var(--bsi-up)]',
  down: 'text-[var(--bsi-down)]',
  neutral: 'text-[var(--bsi-text-muted)]',
};

const DIRECTION_BORDERS: Record<Direction, string> = {
  up: 'bsi-kpi-up',
  down: 'bsi-kpi-down',
  neutral: 'bsi-kpi-accent',
};

const tileVariants: Variants = {
  initial: { opacity: 0, y: 8 },
  animate: { opacity: 1, y: 0 },
  hover: { y: -2 },
};

export const MetricTile: React.FC<MetricTileProps> = ({
  label,
  value,
  change,
  direction = 'neutral',
  prefix = '',
  suffix = '',
  icon,
  sparkline,
  health,
  sparklineColor,
  className,
  onClick,
  loading = false,
  size = 'md',
}) => {
  const Icon = direction !== 'neutral' ? DIRECTION_ICONS[direction] : null;
  const iconColor = direction !== 'neutral' ? DIRECTION_COLORS[direction] : undefined;
  const formattedValue =
    typeof value === 'number' ? `${prefix}${value.toLocaleString('en-IN')}${suffix}` : `${prefix}${value}${suffix}`;

  const sparklineW = 60;
  const sparklineH = 24;
  const sparklinePad = 2;

  const sparklinePoints = React.useMemo(() => {
    if (!sparkline || sparkline.length < 2) return null;
    const vals = sparkline.map((d) => d.value);
    const min = Math.min(...vals);
    const max = Math.max(...vals);
    const range = max - min || 1;

    const chartW = sparklineW - sparklinePad * 2;
    const chartH = sparklineH - sparklinePad * 2;

    const points = sparkline.map((d, i) => {
      const x = sparklinePad + (i / (sparkline.length - 1)) * chartW;
      const y = sparklinePad + chartH - ((d.value - min) / range) * chartH;
      return `${x},${y}`;
    });

    return points.join(' ');
  }, [sparkline]);

  return (
    <motion.div
      variants={tileVariants}
      initial="initial"
      animate="animate"
      whileHover="hover"
      onClick={onClick}
      className={cn(
        SIZE_CLASSES[size],
        DIRECTION_BORDERS[direction],
        onClick && 'cursor-pointer',
        loading && 'opacity-60',
        className,
      )}
    >
      <div className="flex items-center justify-between gap-2 mb-1">
        <span className="bsi-kpi-label truncate">{label}</span>
        {health && (
          <span
            className={cn(
              'bsi-healthchip',
              health === 'fresh' ? 'bsi-healthchip-fresh' :
              health === 'stale' ? 'bsi-healthchip-stale' :
              health === 'error' ? 'bsi-healthchip-error' : 'bsi-healthchip-fresh',
            )}
          >
            <span className="w-1 h-1 rounded-full bg-current animate-pulse-live" />
            {health}
          </span>
        )}
      </div>

      <div className="flex items-end justify-between gap-2">
        <span className="bsi-kpi-value truncate">{loading ? '—' : formattedValue}</span>

        <div className="flex items-center gap-1.5">
          {change && direction !== 'neutral' && (
            <span className={cn('text-[11px] font-medium', DIRECTION_COLORS[direction])}>
              {DirectionIcon(direction)} {change}
            </span>
          )}
          {icon ?? (Icon && <Icon className={cn('w-3.5 h-3.5 shrink-0', iconColor)} />)}
        </div>
      </div>

      {sparkline && sparklinePoints && (
        <svg
          width={sparklineW}
          height={sparklineH}
          className="mt-1.5 overflow-visible bsi-sparkline"
        >
          <polyline
            fill="none"
            stroke={sparklineColor ?? 'var(--bsi-accent)'}
            strokeWidth={1.5}
            points={sparklinePoints}
            opacity={0.6}
          />
          <polyline
            fill="none"
            stroke={sparklineColor ?? 'var(--bsi-accent)'}
            strokeWidth={2}
            points={sparklinePoints}
            strokeLinejoin="round"
            strokeLinecap="round"
            style={{
              strokeDasharray: '1000',
              strokeDashoffset: 0,
              animation: 'none',
            }}
          />
        </svg>
      )}
    </motion.div>
  );
};

function DirectionIcon(direction: Direction) {
  const IconMap: Record<Direction, string> = { up: '▲', down: '▼', neutral: '—' };
  return IconMap[direction];
}

MetricTile.displayName = 'MetricTile';
