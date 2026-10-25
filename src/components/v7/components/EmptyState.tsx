import React from 'react';
import { Activity, ShieldAlert, Inbox } from 'lucide-react';
import { cn } from '../../../lib/utils';

interface EmptyStateProps {
  icon?: React.ReactNode;
  title: string;
  text?: string;
  action?: React.ReactNode;
  variant?: 'default' | 'alert' | 'info';
}

export const EmptyState: React.FC<EmptyStateProps> = ({ icon, title, text, action, variant = 'default' }) => {
  const Icon = icon || (<Activity size={32} strokeWidth={1.5} className="text-slate-500" />);
  return (
    <div className="v7-empty">
      <div className={cn(
        'v7-empty-icon',
        variant === 'alert' ? 'bg-rose-500/10 border-rose-500/20 text-rose-400' : variant === 'info'
          ? 'bg-info-bg border-info-border text-info'
          : '',
      )}>
        {Icon}
      </div>
      <h3 className="v7-empty-title">{title}</h3>
      {text && <p className="v7-empty-text">{text}</p>}
      {action && <div className="mt-6">{action}</div>}
    </div>
  );
};

export default EmptyState;
