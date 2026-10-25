import React from 'react';
import { cn } from '../../../lib/utils';

interface SignalBadgeProps {
  type?: string | null;
  className?: string;
}

/** Renders BUY/SELL/HOLD with honest, non-ambiguous coloring. Unknown -> neutral. */
export const SignalBadge: React.FC<SignalBadgeProps> = ({ type, className }) => {
  const t = (type ?? '').toUpperCase();
  const variants: Record<string, string> = {
    BUY: 'v7-badge-elite',
    SELL: 'v7-badge-low',
    HOLD: 'v7-badge-neutral',
    STRONG_BUY: 'v7-badge-elite',
    STRONG_SELL: 'v7-badge-low',
  };
  return (
    <span className={cn(variants[t] || 'v7-badge-neutral', className)}>
      {t || '—'}
    </span>
  );
};

interface ConvictionBadgeProps {
  level?: string | null;
  className?: string;
}

/** Conviction badge: high/medium/low; null reads neutral, never fabricated. */
export const ConvictionBadge: React.FC<ConvictionBadgeProps> = ({ level, className }) => {
  const variants: Record<string, string> = {
    high: 'v7-badge-elite',
    medium: 'v7-badge-high',
    low: 'v7-badge-medium',
  };
  const key = (level ?? '').toLowerCase();
  return (
    <span className={cn(variants[key] || 'v7-badge-neutral', className)}>
      {key ? `${key.charAt(0).toUpperCase()}${key.slice(1)}` : '—'}
    </span>
  );
};

export default SignalBadge;
