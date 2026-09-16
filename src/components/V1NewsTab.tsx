import React, { useMemo } from 'react';
import { Activity } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { useNewsFeed } from '../services/newsService';
import { Card } from './Card';
import { McNewsCard, McNewsLinks, McNewsEmptyState } from './McNewsCard';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// News tab.
export const V1NewsTab: React.FC<{ symbol: string }> = ({ symbol }) => {
  const { data: mcNewsData, isLoading: loadingMcNews } = trpc.getMcStockNews.useQuery(
    { symbol },
    { staleTime: 60000 },
  );
  const allNews = useNewsFeed();
  const fallbackNews = useMemo(
    () => allNews.filter(n => n.relatedSymbols?.includes(symbol)),
    [allNews, symbol],
  );

  const mcItems = mcNewsData?.news ?? [];

  if (loadingMcNews) {
    return (
      <div className="flex flex-col items-center justify-center py-20 glass-strong rounded-2xl border border-slate-800/50 animate-pulse">
        <Activity className="w-10 h-10 text-blue-500 mb-3 animate-spin" />
        <h3 className="text-slate-300 font-bold text-sm font-display uppercase tracking-wider">Loading MoneyControl Live News…</h3>
      </div>
    );
  }

  if (mcItems.length > 0) {
    return (
      <div className="space-y-6">
        <Card title={`${symbol} — MoneyControl Live News`} icon={Activity}>
          <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
            {mcItems.map((item, idx) => (
              <McNewsCard key={item.posturl || idx} item={item} accent="blue" />
            ))}
          </div>
          <McNewsLinks
            additionalLinks={mcNewsData?.additional_links}
            moreLink={mcNewsData?.more_link}
            accent="blue"
          />
        </Card>
      </div>
    );
  }

  if (fallbackNews.length === 0) {
    return <McNewsEmptyState status={mcNewsData?.status} symbol={symbol} />;
  }

  return (
    <div className="space-y-6">
      <Card title={`${symbol} Intel Feed`} icon={Activity}>
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6 pt-2">
          {fallbackNews.map((item) => (
            <div key={item.id} className="p-5 glass-strong border border-slate-800/50 rounded-2xl hover:border-blue-500/30 transition-all group">
              <div className="flex gap-3 items-center mb-3">
                <span className={cn(
                  "text-[9px] font-black px-2 py-0.5 rounded font-display uppercase tracking-widest",
                  item.category === 'Economy' ? "bg-amber-500/20 text-amber-500" :
                  item.category === 'Stock' ? "bg-blue-500/20 text-blue-500" : "bg-purple-500/20 text-purple-500"
                )}>
                  {item.category}
                </span>
                <span className="text-[9px] font-bold text-slate-400 font-display uppercase tracking-widest">{item.time}</span>
                <span className="text-[9px] font-black text-slate-300 mx-1">•</span>
                <span className="text-[9px] font-black text-blue-500/80 font-display uppercase tracking-widest">{item.source}</span>
              </div>
              <h4 className="text-lg font-black text-white italic tracking-tighter leading-tight mb-2 group-hover:text-blue-400 transition-colors">
                {item.title}
              </h4>
              <p className="text-[11px] text-slate-400 font-medium leading-relaxed italic mb-4 line-clamp-3">
                {item.summary}
              </p>
              <div className="flex justify-between items-center">
                <div className="flex gap-2">
                  {item.relatedSymbols?.map(sym => (
                    <span key={sym} className="text-[9px] font-black text-slate-400 glass px-2 py-0.5 border border-slate-800/50 rounded uppercase tracking-tighter">
                      ${sym}
                    </span>
                  ))}
                </div>
                <button className="text-[9px] font-black text-blue-500 font-display uppercase tracking-widest hover:text-white transition-colors">
                  READ ARTICLE →
                </button>
              </div>
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
};

export default V1NewsTab;
