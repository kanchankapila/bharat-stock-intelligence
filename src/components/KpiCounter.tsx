import React from 'react';
import { cn } from '../lib/utils';
import { motion } from 'motion/react';
import { TrendingUp, TrendingDown } from 'lucide-react';

export interface KpiCounterProps {
  value: number;
  label: string;
  change?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  icon?: React.ElementType;
  direction?: 'up' | 'down' | 'neutral';
  animateOnMount?: boolean;
  className?: string;
}

export const KpiCounter: React.FC<KpiCounterProps> = ({
  value, label, change, prefix = '', suffix = '', decimals = 0,
  icon: Icon, direction = 'neutral', animateOnMount = true, className,
}) => {
  const displayValue =
    typeof value === 'number'
      ? `${prefix}${value.toLocaleString('en-IN', { minimumFractionDigits: decimals, maximumFractionDigits: decimals })}${suffix}`
      : `${prefix}${value}${suffix}`;

  const changeColor = direction === 'up' ? 'var(--bsi-up)' : direction === 'down' ? 'var(--bsi-down)' : 'var(--bsi-text-caption)';
  const showChange = change !== undefined && !isNaN(change);
  const changePct = showChange ? (change > 0 ? '+' : '') + `${Math.abs(change).toFixed(1)}%` : null;
  const IconCmp = Icon;

  return (
    <motion.div
      className={cn('flex items-center gap-3', className)}
      initial={animateOnMount ? { opacity: 0, scale: 0.95 } : undefined}
      animate={animateOnMount ? { opacity: 1, scale: 1, transition: { type: 'spring', stiffness: 260, damping: 20 } } : undefined}
    >
      {IconCmp && (
        <motion.div
          initial={animateOnMount ? { rotate: -10 } : undefined}
          animate={animateOnMount ? { rotate: 0, transition: { delay: 0.1, type: 'spring', stiffness: 400 } } : undefined}
        >
          <IconCmp className="w-3.5 h-3.5 shrink-0" style={{ color: changeColor }} />
        </motion.div>
      )}
      <div className="flex flex-col min-w-0">
        <span className="text-[11px] font-display uppercase tracking-wider text-[var(--bsi-text-muted)]">
          {label}
        </span>
        <span className="text-[20px] font-black font-mono tabular-nums text-[var(--bsi-text-primary)]">
          {displayValue}
        </span>
      </div>
      {showChange && (
        <motion.span
          className="flex items-center gap-0.5 text-[10px] font-medium"
          style={{ color: changeColor }}
          initial={animateOnMount ? { opacity: 0, x: -6 } : undefined}
          animate={animateOnMount ? { opacity: 1, x: 0, transition: { delay: 0.15 } } : undefined}
        >
          {direction === 'up' ? <TrendingUp className="w-2.5 h-2.5" /> : direction === 'down' ? <TrendingDown className="w-2.5 h-2.5" /> : null}
          {changePct}
        </motion.span>
      )}
    </motion.div>
  );
};

KpiCounter.displayName = 'KpiCounter';
