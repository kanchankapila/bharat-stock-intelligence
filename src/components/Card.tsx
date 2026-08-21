import React from 'react';
import { cn } from '../lib/utils';

export type CardVariant = 'default' | 'elevated' | 'accent' | 'ghost';

export interface CardProps {
  children: React.ReactNode;
  className?: string;
  title?: string;
  icon?: any;
  onClick?: () => void;
  action?: React.ReactNode;
  variant?: CardVariant;
  dense?: boolean;
}

// ponytail: colors match v1-card's border-top-color values (index.css) so Card-based pages
// share the same "colored top edge" identity as pages using the raw v1-card classes directly.
const variantTopColor: Record<CardVariant, string> = {
  default:  'rgba(99, 102, 241, 0.7)',
  elevated: 'rgba(99, 102, 241, 0.7)',
  accent:   'rgba(99, 102, 241, 0.7)',
  ghost:    'transparent',
};

const variantBase: Record<CardVariant, string> = {
  default:  'glass shadow-[0_4px_20px_rgba(0,0,0,0.03)]',
  elevated: 'glass-strong shadow-[0_8px_32px_rgba(0,0,0,0.05)]',
  accent:   'glass shadow-[0_4px_20px_rgba(99,102,241,0.04)] border-indigo-500/25',
  ghost:    'bg-transparent border border-transparent',
};

const variantHover: Record<CardVariant, string> = {
  default:  'hover:bg-white/55 hover:shadow-[0_8px_24px_rgba(0,0,0,0.05)] hover:border-white/80',
  elevated: 'hover:bg-white/85 hover:shadow-[0_16px_48px_rgba(0,0,0,0.06)] hover:border-white/100',
  accent:   'hover:bg-slate-950/60 hover:shadow-[0_8px_24px_rgba(99,102,241,0.06)] hover:border-indigo-500/40',
  ghost:    'hover:bg-white/[0.04]',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(({
  children,
  className,
  title,
  icon: Icon,
  onClick,
  action,
  variant = 'default',
  dense = false,
}, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-[10px] overflow-hidden transition-all duration-200 border border-t-2',
      variantBase[variant],
      onClick && cn('cursor-pointer', variantHover[variant]),
      className
    )}
    style={{ borderTopColor: variantTopColor[variant] }}
    onClick={onClick}
  >
    {title && (
      <div className={cn(dense ? 'px-3 py-2.5' : 'px-5 py-3.5', 'border-b border-slate-800/50 flex items-center justify-between bg-slate-950/20')}>
        <h3 className="text-[10px] font-semibold text-slate-400 flex items-center gap-2 font-display uppercase tracking-widest">
          {Icon && <Icon className="w-3.5 h-3.5 text-indigo-600" />}
          {title}
        </h3>
        {action ?? null}
      </div>
    )}
    <div className={dense ? 'p-3' : 'p-5'}>{children}</div>
  </div>
));

Card.displayName = 'Card';
