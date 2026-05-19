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
}

const variantBase: Record<CardVariant, string> = {
  default:  'bg-[#141416] border border-white/[0.06] shadow-[0_2px_12px_rgba(0,0,0,0.4)]',
  elevated: 'bg-[#1c1c1f] backdrop-blur-xl border border-white/[0.08] shadow-[0_8px_32px_rgba(0,0,0,0.5)]',
  accent:   'bg-[#141416] border border-violet-500/20 shadow-[0_0_0_1px_rgba(124,58,237,0.08),0_8px_32px_rgba(0,0,0,0.4)]',
  ghost:    'bg-transparent border border-transparent',
};

const variantHover: Record<CardVariant, string> = {
  default:  'hover:border-white/[0.1] hover:shadow-[0_8px_32px_rgba(0,0,0,0.5)]',
  elevated: 'hover:border-white/[0.12] hover:shadow-[0_16px_48px_rgba(0,0,0,0.6)]',
  accent:   'hover:border-violet-500/30 hover:shadow-[0_0_0_1px_rgba(124,58,237,0.15),0_8px_32px_rgba(0,0,0,0.5)]',
  ghost:    'hover:bg-white/[0.02]',
};

export const Card = React.forwardRef<HTMLDivElement, CardProps>(({
  children,
  className,
  title,
  icon: Icon,
  onClick,
  action,
  variant = 'default',
}, ref) => (
  <div
    ref={ref}
    className={cn(
      'rounded-2xl overflow-hidden transition-all duration-200',
      variantBase[variant],
      onClick && cn('cursor-pointer', variantHover[variant]),
      className
    )}
    onClick={onClick}
  >
    {title && (
      <div className="px-5 py-3.5 border-b border-white/[0.05] flex items-center justify-between">
        <h3 className="text-[11px] font-medium text-zinc-400 flex items-center gap-2 uppercase tracking-wider">
          {Icon && <Icon className="w-3.5 h-3.5 text-violet-500" />}
          {title}
        </h3>
        {action ?? null}
      </div>
    )}
    <div className="p-5">{children}</div>
  </div>
));

Card.displayName = 'Card';
