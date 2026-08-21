import React from 'react';
import { trpc } from '../lib/trpc';
import { Radio, Newspaper, ExternalLink, Clock } from 'lucide-react';
import { cn } from '../lib/utils';
import { relativeFromNow, formatISTWithLocal } from '../lib/timeFormat';

interface ActivityFeedProps {
  onSelectStock?: (symbol: string) => void;
  hours?: number;
  limit?: number;
}

const sentimentDot: Record<string, string> = {
  BULLISH: 'bg-emerald-500',
  BEARISH: 'bg-rose-500',
  NEUTRAL: 'bg-slate-500',
};

const sentimentText: Record<string, string> = {
  BULLISH: 'text-emerald-400',
  BEARISH: 'text-rose-400',
  NEUTRAL: 'text-slate-400',
};

// Merges signals + news into one reverse-chronological timeline (misc.router.ts's
// getActivityFeed) so a trader can scan "what happened, in order" without cross-referencing
// the Signal Ledger and News tabs separately.
export const ActivityFeed: React.FC<ActivityFeedProps> = ({ onSelectStock, hours = 24, limit = 60 }) => {
  const { data, isLoading, dataUpdatedAt } = trpc.getActivityFeed.useQuery(
    { hours, limit },
    { refetchInterval: 60_000, refetchOnWindowFocus: false },
  );

  const items = data?.items ?? [];
  const fetchIsStale = dataUpdatedAt > 0 && Date.now() - dataUpdatedAt > 150_000;

  if (isLoading) {
    return (
      <div className="py-12 flex flex-col items-center gap-3">
        <div className="w-6 h-6 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-[9px] font-black text-slate-500 font-display uppercase tracking-widest animate-pulse">Loading activity…</p>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between px-0.5">
        <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-wider">
          Last {hours}h · {items.length} events
        </p>
        {dataUpdatedAt > 0 && (
          <p className={cn('text-[9px] font-bold flex items-center gap-1', fetchIsStale ? 'text-amber-400' : 'text-slate-600')}
             title={formatISTWithLocal(dataUpdatedAt)}>
            <Clock className="w-2.5 h-2.5" />
            {relativeFromNow(dataUpdatedAt)}
          </p>
        )}
      </div>

      {items.length === 0 ? (
        <div className="py-12 v1-card text-center">
          <Radio className="w-6 h-6 text-slate-700 mx-auto mb-2" />
          <p className="text-[10px] font-black text-slate-500 font-display uppercase tracking-widest">
            No signals or news in the last {hours}h
          </p>
        </div>
      ) : (
        <div className="max-h-[520px] overflow-y-auto pr-1 space-y-1.5">
          {items.map(item => (
            <div
              key={item.id}
              className={cn(
                'bg-slate-900/60 border border-slate-800/50 rounded-lg p-2.5 flex items-start gap-2.5',
                item.symbol && onSelectStock && 'cursor-pointer hover:bg-slate-800/40 hover:border-slate-700/60 transition-colors',
              )}
              onClick={() => item.symbol && onSelectStock?.(item.symbol)}
            >
              <div className="mt-1 shrink-0">
                {item.type === 'SIGNAL'
                  ? <Radio className={cn('w-3 h-3', sentimentText[item.tagSentiment])} />
                  : <Newspaper className={cn('w-3 h-3', sentimentText[item.tagSentiment])} />}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-1.5 flex-wrap">
                  <span className={cn('w-1.5 h-1.5 rounded-full shrink-0', sentimentDot[item.tagSentiment])} />
                  <span className="text-[10px] font-black text-white truncate">{item.headline}</span>
                  {item.url && (
                    <a href={item.url} target="_blank" rel="noopener noreferrer"
                       onClick={e => e.stopPropagation()}
                       className="text-slate-500 hover:text-indigo-400 shrink-0">
                      <ExternalLink className="w-2.5 h-2.5" />
                    </a>
                  )}
                </div>
                {item.detail && (
                  <p className="text-[9px] text-slate-400 mt-0.5 line-clamp-2">{item.detail}</p>
                )}
                <div className="flex items-center gap-1.5 mt-1 text-[8.5px] font-bold font-display uppercase tracking-wider">
                  <span className="px-1.5 py-0.5 rounded bg-slate-800/60 text-slate-400">{item.tag}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-500">{item.source}</span>
                  <span className="text-slate-600">·</span>
                  <span className="text-slate-500" title={formatISTWithLocal(item.timestamp)}>
                    {relativeFromNow(item.timestamp)}
                  </span>
                </div>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
};

export default ActivityFeed;
