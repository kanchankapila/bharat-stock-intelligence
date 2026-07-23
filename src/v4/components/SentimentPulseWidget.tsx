import React from 'react';
import { useNavigate } from 'react-router-dom';
import { Newspaper, ArrowRight } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { Card } from '../../components/Card';
import { cn } from '../../lib/utils';

// Compact teaser of the full Sentiment Intelligence page (src/components/SentimentIntelligence.tsx)
// for the Market Command dashboard — same data source (market_sentiment_snapshots via
// getMarketSentiment), no separate computation, so the two pages can never disagree.
export const SentimentPulseWidget: React.FC = () => {
  const navigate = useNavigate();
  const { data, isLoading } = trpc.getMarketSentiment.useQuery({ historyHours: 6 });
  const { data: news } = trpc.getNewsItems.useQuery({ limit: 3, hours: 12 });

  const latest = data?.latest;
  const score = latest?.overall_score ?? null;
  const label = latest?.overall_label ?? (isLoading ? 'Loading…' : 'No data');
  const color =
    score == null ? 'text-slate-400' :
    score >= 60 ? 'text-emerald-400' :
    score <= 40 ? 'text-rose-400' : 'text-amber-400';

  let themes: string[] = [];
  try { themes = latest?.key_themes_json ? JSON.parse(latest.key_themes_json) : []; } catch { /* malformed json, skip */ }

  return (
    <Card
      title="Sentiment Pulse"
      icon={Newspaper}
      onClick={() => navigate('/sentiment')}
      action={<ArrowRight className="w-3.5 h-3.5 text-slate-500" />}
    >
      <div className="flex items-center gap-4">
        <div className="flex flex-col items-center justify-center w-16 h-16 rounded-full glass shrink-0">
          <span className={cn('text-xl font-black font-mono', color)}>{score != null ? Math.round(score) : '—'}</span>
          <span className="text-[8px] text-slate-500 uppercase tracking-widest">Score</span>
        </div>
        <div className="min-w-0">
          <div className={cn('text-sm font-bold uppercase tracking-wide', color)}>{label}</div>
          {latest?.nifty_bias && (
            <div className="text-[11px] text-slate-400 mt-0.5">
              Nifty bias: <span className="text-slate-200 font-semibold">{latest.nifty_bias}</span>
              {latest.nifty_support != null && latest.nifty_resistance != null && (
                <span> ({latest.nifty_support}–{latest.nifty_resistance})</span>
              )}
            </div>
          )}
          {latest?.global_cue && (
            <div className="text-[11px] text-slate-400 mt-0.5 truncate">Global cue: {latest.global_cue}</div>
          )}
        </div>
      </div>

      {themes.length > 0 && (
        <div className="flex flex-wrap gap-1.5 mt-3">
          {themes.slice(0, 4).map((t, i) => (
            <span key={i} className="text-[10px] px-2 py-0.5 rounded-full bg-indigo-500/10 text-indigo-300 border border-indigo-500/20">
              {t}
            </span>
          ))}
        </div>
      )}

      {news && news.length > 0 && (
        <div className="mt-3 pt-3 border-t border-slate-800/60 space-y-1.5">
          {news.map((n: any) => (
            <div key={n.id} className="text-[11px] text-slate-400 truncate">
              <span className={cn(
                'inline-block w-1.5 h-1.5 rounded-full mr-1.5',
                n.sentiment === 'BULLISH' ? 'bg-emerald-500' : n.sentiment === 'BEARISH' ? 'bg-rose-500' : 'bg-slate-500'
              )} />
              {n.title}
            </div>
          ))}
        </div>
      )}
    </Card>
  );
};

export default SentimentPulseWidget;
