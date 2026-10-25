import React from 'react';
import { Clock, Database, RefreshCw } from 'lucide-react';
import { cn } from '../../../lib/utils';
import { formatIST } from '../../../lib/timeFormat';

interface AsOfBannerProps {
  asOf?: string | Date | null;
  label?: string;
  stale?: boolean;
  onRefresh?: () => void;
  refreshing?: boolean;
}

/**
 * Data freshness / honesty banner. Tells the user when data was last computed and whether
 * it may be stale — never lets an old timestamp masquerade as "live".
 */
export const AsOfBanner: React.FC<AsOfBannerProps> = ({
  asOf, label = 'Data as of', stale, onRefresh, refreshing,
}) => {
  const displayed = formatIST(asOf);
  const hasAsOf = displayed !== '—';
  return (
    <div className={cn('v7-honesty-banner', stale ? 'animate-pulse' : '')}>
      <Clock size={14} strokeWidth={1.5} className={stale ? 'text-amber-400 animate-pulse' : 'text-slate-500'} />
      <span className="font-medium">{label}</span>
      <span className={cn('ml-auto font-data', stale ? 'text-amber-400' : 'text-slate-400')}>
        {displayed}
      </span>
      {stale && <span className="px-2 py-0.5 rounded text-[10px] font-bold border border-amber-500/30 bg-amber-500/10 text-amber-400">STALE</span>}
      {!hasAsOf && <span className="px-2 py-0.5 rounded text-[10px] font-bold border border-slate-700/40 bg-slate-900/40 text-slate-400">NO DATA</span>}
      {onRefresh && (
        <button
          onClick={onRefresh}
          disabled={refreshing}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg border border-slate-700/50 bg-slate-900/40 text-xs font-semibold text-slate-300 hover:border-slate-500 hover:text-white disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
        >
          <RefreshCw size={13} strokeWidth={1.6} className={refreshing ? 'animate-spin' : ''} />
          {refreshing ? 'Refreshing…' : 'Refresh'}
        </button>
      )}
    </div>
  );
};

export default AsOfBanner;
