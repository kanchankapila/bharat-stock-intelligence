import { trpc } from '../lib/trpc';

export interface NewsArticle {
  id: string;
  title: string;
  summary: string;
  source: string;
  time: string;
  category: 'Market' | 'Stock' | 'Economy';
  sentiment: 'Positive' | 'Negative' | 'Neutral';
  url: string;
  relatedSymbols?: string[];
}

function mapCategory(cat: string): 'Market' | 'Stock' | 'Economy' {
  if (['EARNINGS', 'ORDER_WIN', 'BUYBACK', 'IPO'].includes(cat)) return 'Stock';
  if (['POLICY', 'GLOBAL'].includes(cat)) return 'Economy';
  return 'Market';
}

function mapSentiment(s: string): 'Positive' | 'Negative' | 'Neutral' {
  if (s === 'BULLISH') return 'Positive';
  if (s === 'BEARISH') return 'Negative';
  return 'Neutral';
}

function relativeTime(iso: string): string {
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'Just now';
  if (mins < 60) return `${mins} min${mins > 1 ? 's' : ''} ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs} hour${hrs > 1 ? 's' : ''} ago`;
  return `${Math.floor(hrs / 24)} day${Math.floor(hrs / 24) > 1 ? 's' : ''} ago`;
}

export function useNewsFeed(): NewsArticle[] {
  const { data } = trpc.getNewsItems.useQuery(
    { limit: 20, category: 'ALL', sentiment: 'ALL', sourceType: 'ALL', hours: 24 },
    { staleTime: 5 * 60 * 1000, refetchOnWindowFocus: false }
  );

  if (!data) return [];

  return data.map((item: any): NewsArticle => ({
    id:             item.id,
    title:          item.title,
    summary:        item.summary ?? '',
    source:         item.source,
    time:           relativeTime(item.published_at ?? item.fetched_at),
    category:       mapCategory(item.category ?? ''),
    sentiment:      mapSentiment(item.sentiment ?? 'NEUTRAL'),
    url:            item.url ?? '#',
    relatedSymbols: item.symbols_json ? JSON.parse(item.symbols_json) : [],
  }));
}
