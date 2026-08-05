import React, { useMemo, useState } from 'react';
import { BarChart3, Loader, Search, Star, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import stockData from '../data/stocklist';
import { PREMIUM_TRENDLYNE_SCREENERS, PREMIUM_TRENDLYNE_SCREENPK_SET } from '../data/premiumTrendlyneScreeners';

interface TrendlyneStock {
  stockId: string;
  name: string;
  ltp: number;
  change: number;
  changePercent: number;
  score?: number;
  return_1w?: number;
  return_1m?: number;
  piotroski_f_score?: number;
  mc_cp_net_score?: number;
  ext_mojo_quality_rank?: number;
  ext_mojo_valuation_rank?: number;
  ext_mojo_financial_pts?: number;
  [key: string]: any;
}

interface ScreenerCategory {
  id: string;
  name: string;
  description: string;
  screenpk?: string;
  sentiment: 'bullish' | 'bearish' | 'neutral';
  category: 'technical' | 'fundamental' | 'valuation' | 'delivery' | 'intraday' | 'momentum' | 'sector';
  timeframe: 'intraday' | 'long_term';
  source?: 'trendlyne' | 'moneycontrol' | 'etnow';
  confidence?: number;
}

interface PremiumScreenersPageProps {
  onSelectStock?: (symbol: string) => void;
}

function resolveNseSymbol(stock: TrendlyneStock): string | null {
  const bySymbol = stockData.find((s) => s.symbol === stock.stockId);
  if (bySymbol) return bySymbol.symbol;
  const byId = stockData.find((s) => s.stockid === stock.stockId);
  if (byId) return byId.symbol;
  const nameLower = stock.name.toLowerCase();
  const byName = stockData.find((s) => s.name.toLowerCase() === nameLower);
  if (byName) return byName.symbol;
  const firstWord = nameLower.split(' ')[0];
  if (firstWord.length >= 4) {
    const partial = stockData.find((s) => s.name.toLowerCase().startsWith(firstWord));
    if (partial) return partial.symbol;
  }
  return null;
}

function labelForReturnKey(key: string): string {
  const v = key.replace('return_', '');
  return v.toUpperCase();
}

function extractReturns(stock: TrendlyneStock): Array<{ label: string; value: number }> {
  const dynamic = Object.entries(stock)
    .filter(([k, v]) => /^return_/.test(k) && typeof v === 'number' && Number.isFinite(v as number))
    .map(([k, v]) => ({ label: labelForReturnKey(k), value: v as number }));

  const has1W = dynamic.some((r) => r.label === '1W');
  const has1M = dynamic.some((r) => r.label === '1M');
  if (!has1W && typeof stock.return_1w === 'number') dynamic.push({ label: '1W', value: stock.return_1w });
  if (!has1M && typeof stock.return_1m === 'number') dynamic.push({ label: '1M', value: stock.return_1m });

  return dynamic.slice(0, 6);
}

function formatMaybeNum(value: unknown, digits = 1): string {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

const PremiumScreenersPage: React.FC<PremiumScreenersPageProps> = ({ onSelectStock }) => {
  const [selectedScreener, setSelectedScreener] = useState<ScreenerCategory | null>(null);
  const [selectedStock, setSelectedStock] = useState<TrendlyneStock | null>(null);
  const [screenerSearch, setScreenerSearch] = useState('');
  const [stockSearch, setStockSearch] = useState('');

  const screenerNamesQ = trpc.getTrendlyneScreenerNames.useQuery();
  const screenerDataQ = trpc.getTrendlyneScreener.useQuery(
    {
      screenpk: selectedScreener?.screenpk || '',
      screenerName: selectedScreener?.name || '',
      pageNumber: 0,
    },
    { enabled: !!selectedScreener?.screenpk && !!selectedScreener?.name }
  );

  const selectedSymbol = selectedStock ? resolveNseSymbol(selectedStock) : null;

  const analystRatingQ = trpc.getMcAnalystRating.useQuery(
    { symbol: selectedSymbol || '' },
    { enabled: !!selectedSymbol }
  );
  const consensusQ = trpc.getMcConsensus.useQuery(
    { symbol: selectedSymbol || '' },
    { enabled: !!selectedSymbol }
  );
  const dvmQ = trpc.getTrendlyneDVM.useQuery(
    { symbol: selectedSymbol || '' },
    { enabled: !!selectedSymbol }
  );
  const metricsQ = trpc.getTrendlyneStockMetrics.useQuery(
    { symbol: selectedSymbol || '' },
    { enabled: !!selectedSymbol }
  );
  const forecastQ = trpc.getMcPriceForecast.useQuery(
    { symbol: selectedSymbol || '' },
    { enabled: !!selectedSymbol }
  );

  const premiumScreeners = useMemo(() => {
    const raw = (screenerNamesQ.data || []) as ScreenerCategory[];
    const trendlyneOnly = raw.filter((s) => s.source === 'trendlyne');
    const fromServer = trendlyneOnly.filter((s) => s.screenpk && PREMIUM_TRENDLYNE_SCREENPK_SET.has(String(s.screenpk)));

    const seen = new Set(fromServer.map((s) => String(s.screenpk)));
    const missing = PREMIUM_TRENDLYNE_SCREENERS
      .filter((s) => !seen.has(s.screenpk))
      .map((s) => ({
        id: `premium-${s.screenpk}`,
        name: s.name,
        description: 'Premium Trendlyne Screener',
        screenpk: s.screenpk,
        sentiment: 'neutral' as const,
        category: 'fundamental' as const,
        timeframe: 'long_term' as const,
        source: 'trendlyne' as const,
        confidence: 0.7,
      }));

    const merged = [...fromServer, ...missing];
    const q = screenerSearch.trim().toLowerCase();
    if (!q) return merged;
    return merged.filter((s) => s.name.toLowerCase().includes(q) || String(s.screenpk).includes(q));
  }, [screenerNamesQ.data, screenerSearch]);

  const stocks = useMemo(() => {
    const rows = ((screenerDataQ.data?.data || []) as TrendlyneStock[]);
    const q = stockSearch.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((s) => s.name.toLowerCase().includes(q) || s.stockId.toLowerCase().includes(q));
  }, [screenerDataQ.data, stockSearch]);

  return (
    <div className="space-y-6 p-4 md:p-6">
      <div className="glass rounded-2xl border border-slate-700/50 p-5 md:p-6">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-amber-500/15 border border-amber-400/20">
            <Star className="w-5 h-5 text-amber-400" />
          </div>
          <div>
            <h1 className="text-xl md:text-2xl font-black text-white uppercase tracking-wide">Premium Screeners</h1>
            <p className="text-xs text-slate-300 mt-1">Premium Trendlyne screeners with stock-level intelligence cards.</p>
          </div>
        </div>
      </div>

      <div className="glass rounded-2xl border border-slate-800/60 p-4">
        <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3 mb-4">
          <h2 className="text-sm font-black uppercase tracking-wider text-slate-200">Premium Screener Directory</h2>
          <div className="relative w-full md:w-80">
            <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
            <input
              value={screenerSearch}
              onChange={(e) => setScreenerSearch(e.target.value)}
              placeholder="Search premium screeners..."
              className="w-full rounded-full border border-slate-700/70 bg-slate-950/40 pl-9 pr-3 py-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
            />
          </div>
        </div>

        {screenerNamesQ.isLoading ? (
          <div className="flex items-center gap-2 text-slate-400 text-xs"><Loader className="w-4 h-4 animate-spin" /> Loading screener catalog...</div>
        ) : (
          <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
            {premiumScreeners.map((s) => {
              const active = selectedScreener?.screenpk === s.screenpk;
              return (
                <button
                  key={`${s.id}-${s.screenpk}`}
                  onClick={() => {
                    setSelectedScreener(s);
                    setSelectedStock(null);
                  }}
                  className={cn(
                    'text-left glass rounded-xl border p-3 transition-all hover:border-amber-500/40',
                    active ? 'border-amber-500/60 bg-amber-500/10' : 'border-slate-800/60 bg-slate-900/30'
                  )}
                >
                  <div className="text-[11px] font-black text-slate-100 uppercase tracking-wide whitespace-normal break-words leading-snug">
                    {s.name}
                  </div>
                  <div className="mt-1 text-[10px] text-slate-400 font-mono">screenpk: {s.screenpk}</div>
                </button>
              );
            })}
          </div>
        )}
      </div>

      {selectedScreener && (
        <div className="glass rounded-2xl border border-slate-800/60 p-4 space-y-4">
          <div className="flex flex-col md:flex-row md:items-center md:justify-between gap-3">
            <div>
              <h3 className="text-sm font-black text-white uppercase tracking-wider whitespace-normal break-words">{selectedScreener.name}</h3>
              <p className="text-[11px] text-slate-400 mt-1">Screenpk {selectedScreener.screenpk} • Click any stock to view premium details.</p>
            </div>
            <div className="relative w-full md:w-72">
              <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-slate-400" />
              <input
                value={stockSearch}
                onChange={(e) => setStockSearch(e.target.value)}
                placeholder="Search stocks in this screener..."
                className="w-full rounded-full border border-slate-700/70 bg-slate-950/40 pl-9 pr-3 py-2 text-xs font-semibold text-slate-100 placeholder:text-slate-500 focus:outline-none focus:border-amber-500/50"
              />
            </div>
          </div>

          {screenerDataQ.isFetching ? (
            <div className="flex items-center gap-2 text-slate-400 text-xs"><Loader className="w-4 h-4 animate-spin" /> Fetching screener stocks...</div>
          ) : stocks.length === 0 ? (
            <div className="text-xs text-slate-400 border border-dashed border-slate-700/50 rounded-xl p-6">No stocks returned for this premium screener right now.</div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-3">
              {stocks.map((stock) => {
                const nse = resolveNseSymbol(stock);
                const returns = extractReturns(stock);
                const positive = (stock.changePercent || 0) >= 0;
                return (
                  <div
                    key={`${stock.stockId}-${stock.name}`}
                    onClick={() => {
                      setSelectedStock(stock);
                      if (nse && onSelectStock) onSelectStock(nse);
                    }}
                    className="glass rounded-xl border border-slate-800/60 p-3 cursor-pointer hover:border-amber-500/40 transition-all"
                  >
                    <div className="flex items-start justify-between gap-2">
                      <div className="min-w-0">
                        <div className="text-[12px] font-black text-white uppercase tracking-wide whitespace-normal break-words leading-tight">{stock.name}</div>
                        <div className="text-[10px] text-slate-400 font-mono mt-1">{nse || stock.stockId}</div>
                      </div>
                      <div className={cn('text-[11px] font-black', positive ? 'text-emerald-400' : 'text-rose-400')}>
                        {positive ? '+' : ''}{(stock.changePercent || 0).toFixed(2)}%
                      </div>
                    </div>

                    <div className="grid grid-cols-2 gap-2 mt-3">
                      <div className="rounded-lg border border-slate-800/60 bg-slate-950/35 p-2">
                        <div className="text-[9px] text-slate-500 uppercase tracking-widest">Price</div>
                        <div className="text-sm font-black text-white">₹{Number(stock.ltp || 0).toLocaleString()}</div>
                      </div>
                      <div className="rounded-lg border border-slate-800/60 bg-slate-950/35 p-2">
                        <div className="text-[9px] text-slate-500 uppercase tracking-widest">Score</div>
                        <div className="text-sm font-black text-amber-300">{Math.round(Number(stock.score || 0))}</div>
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-slate-800/60 bg-slate-950/35 p-2">
                      <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Price Performance Durations</div>
                      <div className="flex flex-wrap gap-2">
                        <span className={cn('text-[10px] font-bold', positive ? 'text-emerald-400' : 'text-rose-400')}>
                          1D: {positive ? '+' : ''}{(stock.changePercent || 0).toFixed(2)}%
                        </span>
                        {returns.map((r) => (
                          <span key={r.label} className={cn('text-[10px] font-bold', r.value >= 0 ? 'text-emerald-400' : 'text-rose-400')}>
                            {r.label}: {r.value >= 0 ? '+' : ''}{r.value.toFixed(2)}%
                          </span>
                        ))}
                      </div>
                    </div>

                    <div className="mt-3 rounded-lg border border-slate-800/60 bg-slate-950/35 p-2">
                      <div className="text-[9px] text-slate-500 uppercase tracking-widest mb-1">Moneycontrol / MarketMojo Scores</div>
                      <div className="grid grid-cols-2 gap-x-2 gap-y-1 text-[10px]">
                        <div className="text-slate-300">Moneycontrol Score: <span className="font-bold text-white">{formatMaybeNum(stock.mc_cp_net_score, 0)}</span></div>
                        <div className="text-slate-300">Piotroski F: <span className="font-bold text-white">{formatMaybeNum(stock.piotroski_f_score, 0)}/9</span></div>
                        <div className="text-slate-300">Mojo Quality: <span className="font-bold text-white">{formatMaybeNum(stock.ext_mojo_quality_rank, 0)}</span></div>
                        <div className="text-slate-300">Mojo Valuation: <span className="font-bold text-white">{formatMaybeNum(stock.ext_mojo_valuation_rank, 1)}</span></div>
                        <div className="text-slate-300 col-span-2">Mojo Financial: <span className="font-bold text-white">{formatMaybeNum(stock.ext_mojo_financial_pts, 1)}</span></div>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}

      {selectedStock && selectedSymbol && (
        <div className="glass rounded-2xl border border-amber-500/30 p-4 md:p-5 space-y-4">
          <div>
            <h3 className="text-sm font-black text-white uppercase tracking-wider">Premium Stock Intelligence</h3>
            <p className="text-xs text-slate-300 mt-1 whitespace-normal break-words">
              {selectedStock.name} ({selectedSymbol})
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-4 gap-3">
            <div className="glass rounded-xl border border-slate-800/60 p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Analyst Rating</div>
              <div className="text-sm font-black text-white mt-1 whitespace-normal break-words">
                {analystRatingQ.data?.finalRating || '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">Analysts: {analystRatingQ.data?.analystCount ?? '—'}</div>
            </div>

            <div className="glass rounded-xl border border-slate-800/60 p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Consensus</div>
              <div className="text-sm font-black text-white mt-1">
                {Array.isArray(consensusQ.data?.graphData) ? `${consensusQ.data.graphData.length} series` : '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">Source: Moneycontrol</div>
            </div>

            <div className="glass rounded-xl border border-slate-800/60 p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500">DVM Scores</div>
              <div className="text-[11px] text-slate-200 mt-1 whitespace-normal break-words">
                D: {dvmQ.data?.durability?.score ?? '—'} • V: {dvmQ.data?.valuation?.score ?? '—'} • M: {dvmQ.data?.momentum?.score ?? '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">Trendlyne DVM</div>
            </div>

            <div className="glass rounded-xl border border-slate-800/60 p-3">
              <div className="text-[9px] uppercase tracking-widest text-slate-500">Target Forecast</div>
              <div className="text-sm font-black text-white mt-1">
                {forecastQ.data?.mean ? `₹${Number(forecastQ.data.mean).toLocaleString()}` : '—'}
              </div>
              <div className="text-[10px] text-slate-400 mt-1">Low/High: {forecastQ.data?.low ?? '—'} / {forecastQ.data?.high ?? '—'}</div>
            </div>
          </div>

          <div className="glass rounded-xl border border-slate-800/60 p-3">
            <div className="text-[9px] uppercase tracking-widest text-slate-500 mb-2">Other Critical Metrics</div>
            {metricsQ.isLoading ? (
              <div className="flex items-center gap-2 text-xs text-slate-400"><Loader className="w-3.5 h-3.5 animate-spin" /> Loading metrics...</div>
            ) : (
              <div className="grid grid-cols-2 md:grid-cols-4 gap-2 text-[11px]">
                <div className="text-slate-300">PE: <span className="font-bold text-white">{metricsQ.data?.pe ?? '—'}</span></div>
                <div className="text-slate-300">PB: <span className="font-bold text-white">{metricsQ.data?.pb ?? '—'}</span></div>
                <div className="text-slate-300">ROE: <span className="font-bold text-white">{metricsQ.data?.roe ?? '—'}</span></div>
                <div className="text-slate-300">ROCE: <span className="font-bold text-white">{metricsQ.data?.roce ?? '—'}</span></div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
};

export default PremiumScreenersPage;
