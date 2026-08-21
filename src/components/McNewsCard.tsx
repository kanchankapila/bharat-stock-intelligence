import React from 'react';
import { cn } from '../lib/utils';
import { CalendarClock } from 'lucide-react';

// Structurally mirrors the server's McStockNewsResponse (src/server/mcApiService.ts).
// Declared locally rather than imported so this client component never reaches
// across into a server module. Every field is optional because that is what the
// tRPC client actually infers off the wire.
export interface McNewsItem {
  heading?: string;
  posturl?: string;
  display_date?: string;
  post_type?: string;
  post_image?: string;
  summary?: string;
  formatted_date?: string;
}

export interface McNewsLink {
  name?: string;
  link?: string;
}

export type McNewsStatus = 'ok' | 'no_news' | 'fetch_failed';

type Accent = 'blue' | 'indigo';

const ACCENT: Record<Accent, { text: string; hover: string; chip: string; border: string }> = {
  blue: {
    text: 'text-blue-400',
    hover: 'hover:text-blue-300',
    chip: 'text-blue-400 bg-blue-500/10',
    border: 'hover:border-blue-500/40',
  },
  indigo: {
    text: 'text-indigo-400',
    hover: 'hover:text-indigo-300',
    chip: 'text-indigo-400 bg-indigo-500/10',
    border: 'hover:border-indigo-500/40',
  },
};

export const McNewsCard: React.FC<{ item: McNewsItem; accent?: Accent }> = ({ item, accent = 'blue' }) => {
  const a = ACCENT[accent];
  return (
    <div
      className={cn(
        'bg-slate-900/40 border border-slate-800/60 rounded-xl p-4 flex flex-col justify-between transition-all group',
        a.border,
      )}
    >
      <div className="space-y-2">
        {item.post_image && item.post_image.startsWith('http') && (
          <div className="w-full h-32 rounded-lg overflow-hidden bg-slate-950 mb-2">
            <img
              src={item.post_image}
              alt=""
              loading="lazy"
              className="w-full h-full object-cover group-hover:scale-105 transition-transform duration-300"
              onError={(e) => { (e.target as HTMLElement).style.display = 'none'; }}
            />
          </div>
        )}
        <div className="flex items-center justify-between text-[10px] text-slate-400 gap-2">
          <span className={cn('flex items-center gap-1 font-data px-2 py-0.5 rounded font-bold', a.chip)}>
            <CalendarClock className="w-3 h-3" />
            {item.formatted_date || item.display_date}
          </span>
          <span className="uppercase text-[9px] text-slate-500 font-bold tracking-wider">
            {item.post_type || 'News'}
          </span>
        </div>
        <a
          href={item.posturl}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('block font-bold text-sm text-slate-100 transition-colors line-clamp-2', a.hover)}
        >
          {item.heading}
        </a>
        {item.summary && (
          <p className="text-xs text-slate-400 line-clamp-3 leading-relaxed">{item.summary}</p>
        )}
      </div>
      {item.posturl && (
        <div className="mt-3 pt-2 border-t border-slate-800/50 flex justify-end">
          <a
            href={item.posturl}
            target="_blank"
            rel="noopener noreferrer"
            className={cn('text-[11px] font-bold flex items-center gap-1', a.text, a.hover)}
          >
            Read Full Article →
          </a>
        </div>
      )}
    </div>
  );
};

/** MoneyControl's own section links (Business / Earnings / Management Interviews) plus "View All News". */
export const McNewsLinks: React.FC<{
  additionalLinks?: McNewsLink[];
  moreLink?: McNewsLink;
  accent?: Accent;
}> = ({ additionalLinks, moreLink, accent = 'blue' }) => {
  const a = ACCENT[accent];
  const extras = (additionalLinks ?? []).filter((l) => !!l.link);
  if (extras.length === 0 && !moreLink?.link) return null;

  return (
    <div className="flex flex-wrap items-center gap-2 pt-3 border-t border-slate-800/60">
      {extras.map((link) => (
        <a
          key={link.link}
          href={link.link}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(
            'text-[10px] font-bold font-display uppercase tracking-wider px-2 py-1 rounded border border-slate-800 transition-colors',
            a.text,
            a.hover,
          )}
        >
          {link.name}
        </a>
      ))}
      {moreLink?.link && (
        <a
          href={moreLink.link}
          target="_blank"
          rel="noopener noreferrer"
          className={cn('text-xs font-bold hover:underline ml-auto', a.text)}
        >
          {moreLink.name || 'View All News on MoneyControl'} →
        </a>
      )}
    </div>
  );
};

/**
 * Empty state. A failed fetch and a genuinely quiet stock must not read the same —
 * an outage rendered as "no news" is how a broken feed goes unnoticed.
 */
export const McNewsEmptyState: React.FC<{ status?: McNewsStatus; symbol: string }> = ({ status, symbol }) => {
  const failed = status === 'fetch_failed' || status === undefined;
  return (
    <div className="text-center py-12 bg-slate-900/30 border border-slate-800 rounded-2xl">
      <p className={cn('text-xs font-bold', failed ? 'text-amber-400' : 'text-slate-500')}>
        {failed
          ? 'MoneyControl news is unavailable right now — try again shortly.'
          : `No recent news articles published for ${symbol}.`}
      </p>
    </div>
  );
};
