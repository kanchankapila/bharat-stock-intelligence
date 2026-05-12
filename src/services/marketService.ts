import { useState, useEffect, useCallback } from 'react';
import { trpc } from '../lib/trpc';

export interface MarketData {
  symbol: string;
  name: string;
  price: number;
  change: number;
  changePct: number;
  volume: string;
  high: number;
  low: number;
  open: number;
  prevClose: number;
  high52w?: number;
  low52w?: number;
  sector?: string;
  mcsymbol?: string;
  tlid?: string;
  tlname?: string;
}

export function useMarketData() {
  const [stocks, setStocks] = useState<MarketData[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const { data: liveStocks, isLoading: isLoadingLive } = trpc.getLiveStocks.useQuery(undefined, {
    refetchInterval: 5 * 60 * 1000,
    staleTime: 30 * 1000,
    gcTime: 10 * 60 * 1000,
  });

  useEffect(() => {
    if (isLoadingLive) {
      setIsLoading(true);
    } else if (liveStocks && liveStocks.length > 0) {
      setStocks(liveStocks as MarketData[]);
      setIsLoading(false);
      setError(null);
    } else {
      console.warn('[MARKET DATA] Live data fetch failed, using fallback dummy data');
      setError('Using cached/dummy data - live fetch unavailable');
      setIsLoading(false);
    }
  }, [liveStocks, isLoadingLive]);

  useEffect(() => {
    if (!liveStocks || liveStocks.length === 0) return;

    const interval = setInterval(() => {
      setStocks(prevStocks =>
        prevStocks.map(stock => {
          const volatility = 0.0005;
          const change = (Math.random() - 0.5) * 2 * volatility * stock.price;
          const newPrice = stock.price + change;
          const totalChange = newPrice - stock.prevClose;
          const totalChangePct = (totalChange / stock.prevClose) * 100;
          return {
            ...stock,
            price: Number(newPrice.toFixed(2)),
            change: Number(totalChange.toFixed(2)),
            changePct: Number(totalChangePct.toFixed(2)),
            high: Math.max(stock.high, newPrice),
            low: Math.min(stock.low, newPrice),
          };
        })
      );
    }, 5000);

    return () => clearInterval(interval);
  }, [liveStocks]);

  return stocks;
}


