import React from 'react';
import { motion } from 'motion/react';
import { cn } from '../lib/utils';

export interface TabItem {
  id: string;
  label: string;
  icon?: React.ElementType;
  count?: number;
  disabled?: boolean;
}

export type TabVariant = 'pills' | 'underline' | 'sewing';

export interface TabBarProps {
  tabs: TabItem[];
  active: string;
  onChange: (id: string) => void;
  variant?: TabVariant;
  className?: string;
  iconPosition?: 'left' | 'top';
}

const variantClasses: Record<TabVariant, string> = {
  pills: 'rounded-t-[var(--bsi-radius-sm)] border border-b-0',
  underline: '',
  sewing: 'rounded-t-[var(--bsi-radius-lg)] border border-b-0',
};

export const TabBar: React.FC<TabBarProps> = ({
  tabs,
  active,
  onChange,
  variant = 'underline',
  className,
  iconPosition = 'left',
}) => {
  const instanceId = React.useId();
  return (
    <div role="tablist" aria-label="Intelligence views" className={cn('bsi-tabs overflow-x-auto', variantClasses[variant], className)}>
      {tabs.map((tab) => {
        const Icon = tab.icon;
        const isActive = active === tab.id;
        const isDisabled = tab.disabled;

        return (
          <button
            key={tab.id}
            role="tab"
            aria-selected={isActive}
            tabIndex={isActive ? 0 : -1}
            onKeyDown={event => {
              if (!['ArrowRight', 'ArrowLeft', 'Home', 'End'].includes(event.key)) return;
              event.preventDefault();
              const enabled = tabs.filter(item => !item.disabled);
              const current = enabled.findIndex(item => item.id === tab.id);
              const index = event.key === 'Home' ? 0 : event.key === 'End' ? enabled.length - 1 : (current + (event.key === 'ArrowRight' ? 1 : -1) + enabled.length) % enabled.length;
              const target = enabled[index];
              if (!target) return;
              onChange(target.id);
              const buttons = event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role="tab"]:not(:disabled)');
              buttons?.[index]?.focus();
            }}
            onClick={() => !isDisabled && onChange(tab.id)}
            disabled={isDisabled}
            type="button"
            className={cn(
              'bsi-tab relative transition-all duration-200',
              isActive
                ? 'text-[var(--bsi-accent)] font-semibold'
                : 'text-[var(--bsi-text-muted)] hover:text-[var(--bsi-text-secondary)]',
              isDisabled && 'opacity-40 cursor-not-allowed',
              variant === 'pills' && isActive && 'bg-[var(--bsi-accent-soft)]',
              variant === 'sewing' && isActive && 'bg-[var(--bsi-surface-2)]',
            )}
          >
            <span className={cn('flex items-center gap-1.5', iconPosition === 'top' && 'flex-col')}>
              {Icon && <Icon className="w-3.5 h-3.5" />}
              <span>{tab.label}</span>
            </span>
            {tab.count !== undefined && (
              <span className="bsi-tab-count">
                {tab.count}
              </span>
            )}
            {isActive && variant !== 'pills' && variant !== 'sewing' && (
              <motion.div
                layoutId="bsi-tab-underline"
                className="absolute bottom-0 left-0 right-0 h-2 bg-[var(--bsi-accent)] rounded-t"
                initial={{ scaleX: 0 }}
                animate={{ scaleX: 1 }}
                exit={{ scaleX: 0 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
};

TabBar.displayName = 'TabBar';
