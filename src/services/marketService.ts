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

  const { data: liveStocks, isLoading: isLoadingLive, dataUpdatedAt } = trpc.getLiveStocks.useQuery(undefined, {
    // Match backend 5-min cache TTL; poll for genuinely fresh data at the same cadence
    // instead of faking movement client-side between fetches.
    staleTime: 5 * 60 * 1000,
    gcTime: 10 * 60 * 1000,
    refetchInterval: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  useEffect(() => {
    if (isLoadingLive) {
      setIsLoading(true);
    } else if (liveStocks && liveStocks.length > 0) {
      // Deduplicate by symbol to prevent React key warnings
      const uniqueStocks = Array.from(new Map((liveStocks as MarketData[]).map(s => [s.symbol, s])).values());
      setStocks(uniqueStocks);
      setIsLoading(false);
      setError(null);
    } else {
      console.warn('[MARKET DATA] Live data fetch returned no results');
      setError('Live market data unavailable');
      setIsLoading(false);
    }
  }, [liveStocks, isLoadingLive]);

  return { stocks, dataUpdatedAt };
}


