import React, { useState, useEffect, useMemo } from 'react';
import { 
  TrendingUp, TrendingDown, RefreshCw, AlertCircle, Search, 
  Clock, Shield, Award, Calendar, DollarSign, ExternalLink, Filter, ChevronLeft, ChevronRight, Tag
} from 'lucide-react';
import { cn } from '../lib/utils';
import stockData, { StockMapping } from '../data/stocklist';

export interface EtRecoItem {
  instrumentId: number | string;
  instrumentName?: string | null;
  instrumentNameDisplay?: string | null;
  instrumentType?: string;
  contract?: string;
  recoId?: string;
  scripCode?: string | null;
  recoTimeFrame?: string;
  segment?: string;
  status?: string;
  statusColour?: string;
  recoAction?: string;
  duration?: string;
  analystId?: string;
  analystName?: string;
  recoTimestamp?: number;
  recoPrice?: string;
  recopriceForGraph?: string;
  stopLoss?: string | number | null;
  target?: string | number | null;
  currentReturn?: string | number | null;
  potentialValue?: string;
  potentialValueColour?: string;
  potentialValueFlag?: string;
  potentialValueTextPrefix?: string;
  reportUrl?: string | null;
  imageUrl?: string | null;
  history?: any;
  callRationale?: string | null;
  logoUrl?: string | null;
  seoName?: string | null;
}

interface EtCallsPageProps {
  onSelectStock?: (symbol: string) => void;
}
export function EtCallsPage({ onSelectStock }: EtCallsPageProps) {
  const [recommendations, setRecommendations] = useState<EtRecoItem[]>([]);
  const [isLoading, setIsLoading] = useState<boolean>(true);
  const [error, setError] = useState<string | null>(null);
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [actionFilter, setActionFilter] = useState<'all' | 'buy' | 'sell'>('all');
  const [pageNo, setPageNo] = useState<number>(1);
  const [pageSize, setPageSize] = useState<number>(24);
  const [pageSummary, setPageSummary] = useState<{ totalrecords?: number; totalpages?: number }>({});

  // Fast map indexed by stockid & companyid from stocklist.json / stockData
  const stockMap = useMemo(() => {
    const map = new Map<string, StockMapping>();
    stockData.forEach((item) => {
      if (item.stockid) {
        map.set(String(item.stockid), item);
      }
      if (item.companyid) {
        map.set(String(item.companyid), item);
      }
    });
    return map;
  }, []);

  const fetchRecommendations = async () => {
    setIsLoading(true);
    setError(null);
    try {
      const response = await fetch('https://etapi.indiatimes.com/precos/recommendations', {
        method: 'POST',
        headers: {
          'accept': '*/*',
          'content-type': 'application/json',
          'apptype': 'markets',
          'devicetype': 'web',
          'feature': 'ETTRADEG',
          'isprime': 'false',
          'referer': 'https://economictimes.indiatimes.com/'
        },
        body: JSON.stringify({
          segment: ['equity'],
          analyst: ['all'],
          status: 'open',
          pageno: pageNo,
          pagesize: pageSize,
          termDuration: ['short']
        })
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} - ${response.statusText}`);
      }

      const resJson = await response.json();
      if (resJson.data && Array.isArray(resJson.data)) {
        setRecommendations(resJson.data);
        if (resJson.pagesummary) {
          setPageSummary(resJson.pagesummary);
        }
      } else {
        setRecommendations([]);
      }
    } catch (err: any) {
      console.error('Failed to fetch ET Recommendations:', err);
      setError(err.message || 'Failed to load ET recommendations.');
    } finally {
      setIsLoading(false);
    }
  };

  useEffect(() => {
    fetchRecommendations();
  }, [pageNo, pageSize]);

  // Filter recommendations based on search query & action filter
  const filteredRecos = useMemo(() => {
    return recommendations.filter((item) => {
      if (actionFilter === 'buy' && (item.recoAction || '').toLowerCase() !== 'buy') {
        return false;
      }
      if (actionFilter === 'sell' && (item.recoAction || '').toLowerCase() !== 'sell') {
        return false;
      }

      if (searchQuery.trim()) {
        const q = searchQuery.toLowerCase();
        const matched = stockMap.get(String(item.instrumentId));
        const stockName = (matched?.name || item.instrumentName || '').toLowerCase();
        const symbol = (matched?.symbol || item.scripCode || '').toLowerCase();
        const analyst = (item.analystName || '').toLowerCase();
        const instId = String(item.instrumentId);

        return (
          stockName.includes(q) ||
          symbol.includes(q) ||
          analyst.includes(q) ||
          instId.includes(q)
        );
      }

      return true;
    });
  }, [recommendations, actionFilter, searchQuery, stockMap]);


  return (
    <div className="p-6 space-y-6">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-5">
        <div>
          <h1 className="v1-title-page flex items-center gap-3">
            <div className="p-2.5 bg-emerald-500/10 rounded-xl border border-emerald-500/20">
              <TrendingUp className="w-6 h-6 text-emerald-400" />
            </div>
            ET Calls
          </h1>
          <p className="text-xs text-slate-400 mt-1">
            Real-time Economic Times stock recommendations cross-referenced with master stock inventory
          </p>
        </div>

        <div className="flex items-center gap-3">
          <button
            onClick={() => fetchRecommendations()}
            disabled={isLoading}
            className="v1-btn-primary flex items-center gap-2 text-xs cursor-pointer"
          >
            <RefreshCw className={cn("w-3.5 h-3.5", isLoading && "animate-spin")} />
            Refresh Calls
          </button>
        </div>
      </div>

      {/* Controls & Filters */}
      <div className="flex flex-col sm:flex-row items-center justify-between gap-4 bg-slate-900/60 p-4 rounded-xl border border-slate-800">
        <div className="relative w-full sm:w-80">
          <Search className="w-4 h-4 text-slate-400 absolute left-3 top-1/2 -translate-y-1/2" />
          <input
            type="text"
            placeholder="Search stock, symbol, analyst..."
            value={searchQuery}
            onChange={(e) => setSearchQuery(e.target.value)}
            className="w-full bg-slate-950 border border-slate-800 rounded-lg pl-9 pr-4 py-2 text-xs text-slate-200 placeholder-slate-500 focus:outline-none focus:border-indigo-500 transition-colors"
          />
        </div>

        <div className="flex items-center gap-1 bg-slate-950 p-1 rounded-lg border border-slate-800 w-full sm:w-auto justify-center">
          <button
            onClick={() => setActionFilter('all')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-semibold transition-all cursor-pointer",
              actionFilter === 'all'
                ? "bg-indigo-600 text-white shadow-sm"
                : "text-slate-400 hover:text-slate-200"
            )}
          >
            All Calls ({recommendations.length})
          </button>
          <button
            onClick={() => setActionFilter('buy')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center gap-1 cursor-pointer",
              actionFilter === 'buy'
                ? "bg-emerald-600 text-white shadow-sm"
                : "text-slate-400 hover:text-emerald-400"
            )}
          >
            <TrendingUp className="w-3 h-3" />
            Buy Calls
          </button>
          <button
            onClick={() => setActionFilter('sell')}
            className={cn(
              "px-3 py-1.5 rounded-md text-xs font-semibold transition-all flex items-center gap-1 cursor-pointer",
              actionFilter === 'sell'
                ? "bg-rose-600 text-white shadow-sm"
                : "text-slate-400 hover:text-rose-400"
            )}
          >
            <TrendingDown className="w-3 h-3" />
            Sell Calls
          </button>
        </div>
      </div>

      {error && (
        <div className="p-4 bg-rose-500/10 border border-rose-500/30 rounded-xl flex items-center gap-3 text-rose-400 text-xs">
          <AlertCircle className="w-5 h-5 flex-shrink-0" />
          <div className="flex-1">{error}</div>
          <button
            onClick={() => fetchRecommendations()}
            className="px-3 py-1 bg-rose-500/20 hover:bg-rose-500/30 rounded-md font-semibold transition-colors cursor-pointer"
          >
            Retry
          </button>
        </div>
      )}

      {isLoading && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {[...Array(6)].map((_, i) => (
            <div key={i} className="v1-card p-5 space-y-4 animate-pulse">
              <div className="h-5 bg-slate-800 rounded w-3/4"></div>
              <div className="h-4 bg-slate-800 rounded w-1/2"></div>
              <div className="grid grid-cols-2 gap-3 pt-2">
                <div className="h-10 bg-slate-800/60 rounded"></div>
                <div className="h-10 bg-slate-800/60 rounded"></div>
              </div>
            </div>
          ))}
        </div>
      )}
      {!isLoading && !error && filteredRecos.length === 0 && (
        <div className="v1-card p-12 text-center flex flex-col items-center justify-center space-y-3">
          <AlertCircle className="w-10 h-10 text-slate-500" />
          <h3 className="text-base font-semibold text-slate-300">No ET Calls found</h3>
          <p className="text-xs text-slate-500 max-w-sm">
            {searchQuery ? `No recommendations matching "${searchQuery}"` : "No recommendation data available."}
          </p>
        </div>
      )}

      {!isLoading && !error && filteredRecos.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-5">
          {filteredRecos.map((item, index) => {
            const matchedStock = stockMap.get(String(item.instrumentId));
            const stockName = matchedStock 
              ? matchedStock.name 
              : (item.instrumentName || item.instrumentNameDisplay || `Stock #${item.instrumentId}`);
            const symbol = matchedStock?.symbol || item.scripCode || null;

            const isBuy = (item.recoAction || '').toLowerCase() === 'buy';
            const isSell = (item.recoAction || '').toLowerCase() === 'sell';

            // Card border color red or green depending on whether recoAction is buy or sell
            const cardBorderClass = isBuy
              ? 'v1-card-up border-2 border-emerald-500/60 hover:border-emerald-500 shadow-[0_0_20px_rgba(16,185,129,0.12)]'
              : isSell
              ? 'v1-card-down border-2 border-rose-500/60 hover:border-rose-500 shadow-[0_0_20px_rgba(244,63,94,0.12)]'
              : 'v1-card-neutral border-2 border-amber-500/50';

            const formattedDate = item.recoTimestamp
              ? new Date(item.recoTimestamp).toLocaleString('en-IN', {
                  day: 'numeric',
                  month: 'short',
                  year: 'numeric',
                  hour: '2-digit',
                  minute: '2-digit'
                })
              : '—';

            return (
              <div
                key={item.recoId || `${item.instrumentId}-${index}`}
                onClick={() => symbol && onSelectStock?.(symbol)}
                className={cn(
                  cardBorderClass,
                  "p-5 rounded-2xl flex flex-col justify-between space-y-4 transition-all duration-200",
                  symbol && "cursor-pointer hover:scale-[1.015]"
                )}
              >
                <div className="space-y-2">
                  <div className="flex items-start justify-between gap-3">
                    <div>
                      <h3 className="v1-title-card text-lg font-bold text-white leading-snug">
                        {stockName}
                      </h3>
                      {symbol && (
                        <span className="text-xs font-mono font-bold text-indigo-400 bg-indigo-500/10 px-2 py-0.5 rounded border border-indigo-500/20 inline-block mt-1">
                          {symbol}
                        </span>
                      )}
                    </div>

                    <div
                      className={cn(
                        "px-3 py-1 rounded-full text-xs font-black uppercase tracking-wider flex items-center gap-1.5 shadow-sm flex-shrink-0",
                        isBuy
                          ? "bg-emerald-500/20 border border-emerald-500/40 text-emerald-400"
                          : isSell
                          ? "bg-rose-500/20 border border-rose-500/40 text-rose-400"
                          : "bg-amber-500/20 border border-amber-500/40 text-amber-400"
                      )}
                    >
                      {isBuy ? (
                        <TrendingUp className="w-3.5 h-3.5 text-emerald-400" />
                      ) : (
                        <TrendingDown className="w-3.5 h-3.5 text-rose-400" />
                      )}
                      {item.recoAction || 'HOLD'}
                    </div>
                  </div>

                  <div className="flex items-center gap-2 text-[11px] text-slate-400">
                    <Tag className="w-3 h-3 text-slate-500" />
                    <span>Instrument ID: <strong className="text-slate-300 font-mono">{item.instrumentId}</strong></span>
                    {matchedStock ? (
                      <span className="text-emerald-400 text-[10px] bg-emerald-500/10 px-1.5 py-0.5 rounded border border-emerald-500/20">
                        stocklist match
                      </span>
                    ) : (
                      <span className="text-amber-400 text-[10px] bg-amber-500/10 px-1.5 py-0.5 rounded border border-amber-500/20">
                        unmapped ID
                      </span>
                    )}
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2.5 bg-slate-950/60 p-3 rounded-xl border border-slate-800/80 text-xs">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block">
                      Time Frame
                    </span>
                    <span className="text-slate-200 font-medium capitalize">
                      {item.recoTimeFrame ? item.recoTimeFrame.replace('_', ' ') : '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block">
                      Segment
                    </span>
                    <span className="text-slate-200 font-medium uppercase">
                      {item.segment || '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block flex items-center gap-1">
                      <Clock className="w-2.5 h-2.5 text-slate-400" /> Duration
                    </span>
                    <span className="text-slate-200 font-medium">
                      {item.duration || '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 tracking-wider block">
                      Potential Value
                    </span>
                    <span className={cn(
                      "font-mono font-bold text-sm",
                      isBuy ? "text-emerald-400" : "text-rose-400"
                    )}>
                      {item.potentialValue || '—'}
                    </span>
                  </div>
                </div>

                <div className="grid grid-cols-2 gap-2 bg-slate-900/40 p-3 rounded-xl border border-slate-800/50 text-xs">
                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 block">
                      Reco Price
                    </span>
                    <span className="text-white font-mono font-bold text-sm">
                      ₹{item.recoPrice || '—'}
                    </span>
                  </div>

                  <div>
                    <span className="text-[10px] uppercase font-bold text-slate-500 block">
                      Graph Price
                    </span>
                    <span className="text-slate-300 font-mono font-semibold">
                      ₹{item.recopriceForGraph || '—'}
                    </span>
                  </div>
                </div>

                {item.callRationale && (
                  <div className="text-[11px] text-slate-400 bg-slate-950/40 p-2.5 rounded-lg border border-slate-800/40 line-clamp-3 leading-relaxed italic">
                    "{item.callRationale.replace(/\n+/g, ' ')}"
                  </div>
                )}

                <div className="pt-2 border-t border-slate-800/60 flex items-center justify-between text-[11px] text-slate-400">
                  <div className="flex items-center gap-1.5">
                    <Award className="w-3.5 h-3.5 text-indigo-400" />
                    <span className="font-medium text-slate-300">{item.analystName || 'ET Analyst'}</span>
                  </div>

                  <div className="flex items-center gap-1 text-slate-500">
                    <Calendar className="w-3 h-3 text-slate-500" />
                    <span>{formattedDate}</span>
                  </div>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {pageSummary.totalpages && pageSummary.totalpages > 1 && (
        <div className="flex items-center justify-between pt-4 border-t border-slate-800 text-xs text-slate-400">
          <div>
            Page <strong>{pageNo}</strong> of <strong>{pageSummary.totalpages}</strong> ({pageSummary.totalrecords} total calls)
          </div>
          <div className="flex items-center gap-2">
            <button
              onClick={() => setPageNo(p => Math.max(1, p - 1))}
              disabled={pageNo <= 1 || isLoading}
              className="px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 text-slate-200 disabled:opacity-50 flex items-center gap-1 font-medium transition-colors cursor-pointer"
            >
              <ChevronLeft className="w-3.5 h-3.5" /> Previous
            </button>
            <button
              onClick={() => setPageNo(p => Math.min(pageSummary.totalpages || 1, p + 1))}
              disabled={pageNo >= (pageSummary.totalpages || 1) || isLoading}
              className="px-3 py-1.5 bg-slate-900 border border-slate-800 rounded-lg hover:bg-slate-800 text-slate-200 disabled:opacity-50 flex items-center gap-1 font-medium transition-colors cursor-pointer"
            >
              Next <ChevronRight className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export default EtCallsPage;

