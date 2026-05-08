import { useState, useEffect } from 'react';

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

const INITIAL_NEWS: NewsArticle[] = [
  {
    id: '1',
    title: 'RBI Monetary Policy: Repo Rate Kept Unchanged at 6.5%',
    summary: 'The Reserve Bank of India decided to maintain the status quo on interest rates for the seventh consecutive time.',
    source: 'Economic Times',
    time: '10 mins ago',
    category: 'Economy',
    sentiment: 'Neutral',
    url: '#',
    relatedSymbols: ['BANKNIFTY', 'HDFCBANK', 'SBIN']
  },
  {
    id: '2',
    title: 'Reliance Industries Hits 52-Week High on New Energy Push',
    summary: 'Shares of RIL surged over 2% today as investors cheered the company\'s aggressive roadmap in green hydrogen.',
    source: 'Moneycontrol',
    time: '45 mins ago',
    category: 'Stock',
    sentiment: 'Positive',
    url: '#',
    relatedSymbols: ['RELIANCE']
  },
  {
    id: '3',
    title: 'Nifty IT Index Slumps 1.5% Amid US Recession Fears',
    summary: 'Technology stocks faced selling pressure following cautious guidance from global tech giants.',
    source: 'Reuters',
    time: '1 hour ago',
    category: 'Market',
    sentiment: 'Negative',
    url: '#',
    relatedSymbols: ['INFY', 'TCS', 'WIPRO']
  },
  {
    id: '4',
    title: 'Adani Enterprises Q4 Profit Jumps 30%, Beats Estimates',
    summary: 'The flagship company reported strong growth across all business segments in the final quarter of FY24.',
    source: 'LiveMint',
    time: '2 hours ago',
    category: 'Stock',
    sentiment: 'Positive',
    url: '#',
    relatedSymbols: ['ADANIENT']
  }
];

export function useNewsFeed() {
  const [news, setNews] = useState<NewsArticle[]>(INITIAL_NEWS);

  useEffect(() => {
    // Simulate new news arriving every 30 seconds
    const interval = setInterval(() => {
      const newsPool: NewsArticle[] = [
        {
          id: Math.random().toString(36).substr(2, 9),
          title: 'Sensex Reclaims 74,000 Mark as FIIs Turn Buyers',
          summary: 'Global liquidity and strong domestic earnings drove the benchmark index to its highest level this month.',
          source: 'Bloomberg',
          time: 'Just now',
          category: 'Market',
          sentiment: 'Positive',
          url: '#',
          relatedSymbols: ['SENSEX', 'NIFTY']
        },
        {
          id: Math.random().toString(36).substr(2, 9),
          title: 'TCS Wins Multi-Billion Dollar Contract from European Retailer',
          summary: 'The deal is expected to boost India\'s largest IT firm\'s order book significantly over the next 5 years.',
          source: 'Economic Times',
          time: 'Just now',
          category: 'Stock',
          sentiment: 'Positive',
          url: '#',
          relatedSymbols: ['TCS', 'INFY']
        }
      ];

      setNews(prev => [newsPool[Math.floor(Math.random() * newsPool.length)], ...prev].slice(0, 10));
    }, 30000);

    return () => clearInterval(interval);
  }, []);

  return news;
}
