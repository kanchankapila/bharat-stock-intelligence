import React, { useState, useEffect } from 'react';
import {
  Search, Zap, TrendingUp, TrendingDown, Loader, RefreshCw,
  ChevronRight, Filter, BarChart3, AlertCircle
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import stockData from '../data/stocklist';

interface TrendlyneStock {
  stockId: string;
  name: string;
  ltp: number;
  change: number;
  changePercent: number;
  screenerName: string;
  screenerType?: string;
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
  source?: 'trendlyne' | 'moneycontrol';
  confidence?: number;
}

function resolveNseSymbol(stock: TrendlyneStock): string | null {
  if (stock.screenerType === 'moneycontrol') return stock.stockId; // Directly use symbol
  
  // 0. check if stockId is actually a valid NSE symbol
  const bySymbol = stockData.find(s => s.symbol === stock.stockId);
  if (bySymbol) return bySymbol.symbol;

  // 1. match Trendlyne stockId against stocklist.stockid
  const byId = stockData.find(s => s.stockid === stock.stockId);
  if (byId) return byId.symbol;
  // 2. exact name match
  const nameLower = stock.name.toLowerCase();
  const byName = stockData.find(s => s.name.toLowerCase() === nameLower);
  if (byName) return byName.symbol;
  // 3. partial name match (first word of Trendlyne name inside stocklist name)
  const firstWord = nameLower.split(' ')[0];
  if (firstWord.length >= 4) {
    const partial = stockData.find(s => s.name.toLowerCase().startsWith(firstWord));
    if (partial) return partial.symbol;
  }
  return null;
}

const TrendlyneScreenerPanel: React.FC<{ onSelectStock?: (symbol: string) => void }> = ({ onSelectStock }) => {
  const [selectedScreener, setSelectedScreener] = useState<ScreenerCategory | null>(null);
  const [screenerSearchQuery, setScreenerSearchQuery] = useState('');
  const [stockSearchQuery, setStockSearchQuery] = useState('');
  const [filteredStocks, setFilteredStocks] = useState<TrendlyneStock[]>([]);
  const [rawStocks, setRawStocks] = useState<TrendlyneStock[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [activeTab, setActiveTab] = useState<'screeners' | 'details'>('screeners');
  
  // Category filters
  const [filterSentiment, setFilterSentiment] = useState<string>('all');
  const [filterType, setFilterType] = useState<string>('all');
  const [filterTimeframe, setFilterTimeframe] = useState<string>('all');
  const [filterSource, setFilterSource] = useState<string>('all');

  // TRPC hooks
  const getTrendlyneScreener = trpc.getTrendlyneScreener.useQuery(
    {
      screenpk: selectedScreener?.screenpk || '',
      screenerName: selectedScreener?.name || '',
      pageNumber: 0
    },
    { enabled: !!selectedScreener?.screenpk && !!selectedScreener?.name }
  );

  const getTrendlyneScreenerNames = trpc.getTrendlyneScreenerNames.useQuery();
  const getTrendlyneCategories = trpc.getTrendlyneCategories.useQuery();

  // Fetch screener data when a screener is selected
  useEffect(() => {
    if (selectedScreener?.screenpk) {
      setIsLoading(true);
      // The query will automatically trigger when selectedScreener changes
      // but we use the refetch/promise pattern here to handle loading state consistently
      getTrendlyneScreener.refetch().then(result => {
        if (result.data?.success) {
          const stocks = (result.data.data || []) as TrendlyneStock[];
          setRawStocks(stocks);
        } else {
          setRawStocks([]);
        }
        setIsLoading(false);
      }).catch(error => {
        console.error('❌ Error fetching screener:', error);
        setIsLoading(false);
      });
    }
  }, [selectedScreener?.id, selectedScreener?.screenpk, selectedScreener?.name]);

  // Apply search filter to stocks independently
  useEffect(() => {
    let filtered = rawStocks;
    if (stockSearchQuery) {
      filtered = rawStocks.filter(s =>
        s.name.toLowerCase().includes(stockSearchQuery.toLowerCase())
      );
    }
    setFilteredStocks(filtered);
  }, [rawStocks, stockSearchQuery]);

  // Use dynamic screener names if available, fallback to hardcoded categories
  const dynamicCategories = (getTrendlyneScreenerNames.data || []) as ScreenerCategory[];
  const categories = (dynamicCategories && dynamicCategories.length > 0)
    ? dynamicCategories
    : ((getTrendlyneCategories.data || []) as ScreenerCategory[]);

  console.log('DEBUG: categories length:', categories.length);
  console.log('DEBUG: first category:', categories[0]);
  console.log('DEBUG: bullish count:', categories.filter(c => c.sentiment === 'bullish').length);
  console.log('DEBUG: filterSentiment state:', filterSentiment);

  // Apply filters to screeners list
  const filteredCategories = categories.filter(c => {
    const matchSentiment = filterSentiment === 'all' || c.sentiment === filterSentiment;
    const matchType = filterType === 'all' || c.category === filterType;
    const matchTimeframe = filterTimeframe === 'all' || c.timeframe === filterTimeframe;
    const matchSource = filterSource === 'all' || c.source === filterSource;
    const matchSearch = screenerSearchQuery === '' || c.name.toLowerCase().includes(screenerSearchQuery.toLowerCase());
    return matchSentiment && matchType && matchTimeframe && matchSource && matchSearch;
  });

  const isPositive = (value: number) => value >= 0;

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="bg-gradient-to-r from-slate-900 via-slate-800 to-slate-900 rounded-lg border border-slate-700/50 p-6 shadow-2xl">
        <div className="flex flex-col md:flex-row items-start justify-between gap-4">
          <div className="flex-1">
            <div className="flex items-center gap-2 mb-2">
              <div className="p-2 bg-amber-500/10 rounded-lg border border-amber-500/20">
                <BarChart3 className="w-6 h-6 text-amber-400" />
              </div>
              <div>
                <h2 className="text-2xl font-black text-white tracking-tight uppercase italic">Screener Intelligence</h2>
                <p className="text-[10px] font-bold text-slate-400 uppercase tracking-widest mt-0.5 flex items-center gap-2">
                  <span className="bg-blue-500/20 text-blue-400 px-1.5 py-0.5 rounded text-[8px] border border-blue-500/20">FinBERT AI POWERED</span>
                  Advanced Multi-Factor Market Scanners
                </p>
              </div>
            </div>
          </div>
          <div className="flex gap-2">
            {selectedScreener && (
              <button
                onClick={() => {
                  setRawStocks([]);
                  setFilteredStocks([]);
                  getTrendlyneScreener.refetch();
                }}
                disabled={isLoading}
                className="flex items-center gap-2 px-4 py-2 bg-amber-500/10 hover:bg-amber-500/20 border border-amber-400/50 rounded-lg text-amber-400 font-bold text-xs uppercase tracking-widest transition-all disabled:opacity-50"
              >
                <RefreshCw className={cn("w-3 h-3", isLoading && "animate-spin")} />
                Refresh Data
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Tabs and Filters */}
      <div className="space-y-4">
        <div className="flex items-center justify-between border-b border-slate-800 pb-px">
          <div className="flex gap-1">
            <button
              onClick={() => setActiveTab('screeners')}
              className={cn(
                "px-4 py-3 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all",
                activeTab === 'screeners'
                  ? "border-amber-400 text-amber-400 bg-amber-400/5"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              )}
            >
              Active Scans
            </button>
            <button
              onClick={() => setActiveTab('details')}
              className={cn(
                "px-4 py-3 text-[10px] font-black uppercase tracking-widest border-b-2 transition-all",
                activeTab === 'details'
                  ? "border-amber-400 text-amber-400 bg-amber-400/5"
                  : "border-transparent text-slate-500 hover:text-slate-300"
              )}
            >
              Master Directory
            </button>
          </div>
          
          <div className="flex items-center gap-4">
             <div className="relative w-64 hidden md:block">
                <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                <input 
                  type="text" 
                  placeholder="SEARCH SCREENERS..."
                  value={screenerSearchQuery}
                  onChange={(e) => setScreenerSearchQuery(e.target.value)}
                  className="w-full bg-slate-900/50 border border-slate-800 rounded-full pl-9 pr-4 py-1.5 text-[10px] font-bold text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-500/50"
                />
             </div>
          </div>
        </div>

        {/* Global Filters */}
        <div className="flex flex-wrap gap-3 p-3 bg-slate-900/30 border border-slate-800/50 rounded-xl">
          <div className="flex items-center gap-2 bg-slate-800/50 px-2 py-1 rounded-lg">
            <TrendingUp className="w-3 h-3 text-slate-500" />
            <select 
              value={filterSentiment} 
              onChange={(e) => setFilterSentiment(e.target.value)}
              className="bg-transparent text-[10px] font-black text-slate-300 uppercase focus:outline-none"
            >
              <option value="all">ALL SENTIMENTS</option>
              <option value="bullish">BULLISH</option>
              <option value="bearish">BEARISH</option>
              <option value="neutral">NEUTRAL</option>
            </select>
          </div>
          
          <div className="flex items-center gap-2 bg-slate-800/50 px-2 py-1 rounded-lg">
            <Filter className="w-3 h-3 text-slate-500" />
            <select 
              value={filterType} 
              onChange={(e) => setFilterType(e.target.value)}
              className="bg-transparent text-[10px] font-black text-slate-300 uppercase focus:outline-none"
            >
              <option value="all">ALL TYPES</option>
              <option value="fundamental">FUNDAMENTAL</option>
              <option value="technical">TECHNICAL</option>
              <option value="valuation">VALUATION</option>
              <option value="momentum">MOMENTUM</option>
              <option value="sector">SECTOR / THEMATIC</option>
              <option value="delivery">DELIVERY</option>
            </select>
          </div>

          <div className="flex items-center gap-2 bg-slate-800/50 px-2 py-1 rounded-lg">
            <Zap className="w-3 h-3 text-slate-500" />
            <select 
              value={filterTimeframe} 
              onChange={(e) => setFilterTimeframe(e.target.value)}
              className="bg-transparent text-[10px] font-black text-slate-300 uppercase focus:outline-none"
            >
              <option value="all">ALL TIMEFRAMES</option>
              <option value="intraday">INTRADAY</option>
              <option value="long_term">LONG TERM</option>
            </select>
          </div>

          <div className="flex items-center gap-2 bg-slate-800/50 px-2 py-1 rounded-lg">
            <BarChart3 className="w-3 h-3 text-slate-500" />
            <select 
              value={filterSource} 
              onChange={(e) => setFilterSource(e.target.value)}
              className="bg-transparent text-[10px] font-black text-slate-300 uppercase focus:outline-none"
            >
              <option value="all">ALL SOURCES</option>
              <option value="trendlyne">TRENDLYNE</option>
              <option value="moneycontrol">MONEYCONTROL</option>
              <option value="etnow">ETNOW</option>
            </select>
          </div>
        </div>
      </div>

      {activeTab === 'screeners' ? (
        <>
          {/* Quick Select Grid */}
          <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-6 gap-2">
            {filteredCategories.slice(0, 12).map((screener) => (
              <button
                key={screener.id}
                onClick={() => setSelectedScreener(screener)}
                className={cn(
                  "p-3 rounded-xl border text-left transition-all relative overflow-hidden group",
                  screener.sentiment === 'bullish' ? "border-emerald-500/50" : screener.sentiment === 'bearish' ? "border-rose-500/50" : "border-yellow-500/50",
                  selectedScreener?.id === screener.id
                    ? "bg-slate-800/80 shadow-lg"
                    : "bg-slate-900/50 hover:bg-slate-800/50"
                )}
              >
                <div className={cn(
                  "absolute top-0 right-0 w-12 h-12 -mr-4 -mt-4 opacity-5 group-hover:opacity-10 transition-opacity",
                  screener.sentiment === 'bullish' ? "bg-emerald-500" : screener.sentiment === 'bearish' ? "bg-rose-500" : "bg-slate-500"
                )} />
                <div className="relative z-10">
                   <p className={cn(
                     "text-[8px] font-black uppercase tracking-[0.2em] mb-1",
                     screener.sentiment === 'bullish' ? "text-emerald-400" : screener.sentiment === 'bearish' ? "text-rose-400" : "text-slate-500"
                   )}>
                     {screener.sentiment || 'NEUTRAL'}
                   </p>
                   <p className="text-[10px] font-black text-white leading-tight uppercase group-hover:text-amber-400 transition-colors">
                     {screener.name}
                   </p>
                   {screener.confidence && screener.confidence > 0.8 && (
                     <span className="absolute bottom-2 right-2 text-[6px] font-black text-blue-400/50 uppercase tracking-tighter">AI Analyzed</span>
                   )}
                </div>
              </button>
            ))}
          </div>

          {/* Loading State */}
          {isLoading && (
            <div className="flex flex-col items-center justify-center py-20 bg-slate-900/30 rounded-2xl border border-dashed border-slate-800">
              <Loader className="w-10 h-10 text-amber-500 animate-spin mb-4" />
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest">Compiling live results...</p>
            </div>
          )}

          {/* No Results */}
          {!isLoading && filteredStocks.length === 0 && (
            <div className="bg-slate-900/30 border border-dashed border-slate-800 rounded-2xl p-12 text-center">
              <AlertCircle className="w-12 h-12 text-slate-700 mx-auto mb-4" />
              <p className="text-[11px] font-black text-slate-400 uppercase tracking-[0.2em]">Select a scan to view results</p>
              <p className="text-[9px] font-bold text-slate-600 mt-2 uppercase tracking-widest">
                Data will be fetched in real-time from Trendlyne
              </p>
            </div>
          )}

          {/* Stocks Grid */}
          {!isLoading && filteredStocks.length > 0 && (
            <div className="space-y-4">
              <div className="flex items-center justify-between px-2">
                 <div className="flex items-center gap-3">
                   <div className={cn(
                     "w-2 h-2 rounded-full",
                     selectedScreener?.sentiment === 'bullish' ? "bg-emerald-500 shadow-[0_0_8px_rgba(16,185,129,0.5)]" : "bg-rose-500 shadow-[0_0_8px_rgba(244,63,94,0.5)]"
                   )} />
                   <h3 className="text-sm font-black text-white uppercase tracking-wider italic">
                     {selectedScreener?.name} <span className="text-slate-500 font-bold not-italic ml-2">({filteredStocks.length} Results)</span>
                   </h3>
                 </div>
                 <div className="relative w-48 hidden md:block">
                    <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-3 h-3 text-slate-500" />
                    <input 
                      type="text" 
                      placeholder="FILTER STOCKS..."
                      value={stockSearchQuery}
                      onChange={(e) => setStockSearchQuery(e.target.value)}
                      className="w-full bg-slate-900/50 border border-slate-800 rounded-full pl-9 pr-4 py-1.5 text-[8px] font-bold text-white placeholder:text-slate-600 focus:outline-none focus:border-amber-500/50"
                    />
                 </div>
              </div>

              <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                {filteredStocks.map((stock) => {
                  const nseSymbol = resolveNseSymbol(stock);
                  return (
                  <div
                    key={`${stock.stockId}-${stock.screenerName}`}
                    onClick={() => nseSymbol && onSelectStock && onSelectStock(nseSymbol)}
                    className={cn(
                      "bg-slate-900/50 border rounded-2xl p-5 transition-all hover:shadow-2xl hover:translate-y-[-2px] group relative overflow-hidden",
                      nseSymbol && onSelectStock ? "cursor-pointer border-slate-800 hover:border-amber-500/40" : "border-slate-800"
                    )}
                  >
                    {/* Glass highlight */}
                    <div className="absolute top-0 left-0 w-full h-1 bg-gradient-to-r from-transparent via-amber-500/20 to-transparent" />
                    
                    <div className="flex items-start justify-between mb-4">
                      <div>
                        <h3 className="font-black text-white text-lg tracking-tight group-hover:text-amber-400 transition-colors uppercase italic leading-none">
                          {stock.name}
                        </h3>
                        <div className="flex items-center gap-2 mt-2">
                           <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">NSE: {nseSymbol || '—'}</span>
                           <span className="w-1 h-1 rounded-full bg-slate-700" />
                           <span className="text-[9px] font-black text-amber-500/80 uppercase tracking-widest">{selectedScreener?.category || 'TECH'}</span>
                        </div>
                      </div>
                      <div className="p-2 bg-slate-800/50 rounded-xl">
                        <ChevronRight className="w-4 h-4 text-slate-600 group-hover:text-amber-400 transition-colors" />
                      </div>
                    </div>

                    <div className="flex items-end justify-between">
                       <div className="space-y-0.5">
                         <p className="text-[8px] font-black text-slate-500 uppercase tracking-widest">LTP (₹)</p>
                         <p className="text-2xl font-black text-white tabular-nums tracking-tighter italic leading-none">
                           {stock.ltp.toLocaleString()}
                         </p>
                       </div>
                       
                       <div className={cn(
                         "flex flex-col items-end gap-1 px-3 py-2 rounded-xl border",
                         isPositive(stock.changePercent)
                           ? "bg-emerald-500/10 border-emerald-500/20 text-emerald-400"
                           : "bg-rose-500/10 border-rose-500/20 text-rose-400"
                       )}>
                         <div className="flex items-center gap-1">
                           {isPositive(stock.changePercent) ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                           <span className="text-xs font-black tabular-nums">{Math.abs(stock.changePercent).toFixed(2)}%</span>
                         </div>
                       </div>
                    </div>
                  </div>
                  );
                })}
              </div>
            </div>
          )}
        </>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
          {filteredCategories.map((screener) => (
            <div
              key={screener.id}
              onClick={() => {
                setSelectedScreener(screener);
                setActiveTab('screeners');
              }}
              className={cn(
                "bg-slate-900/50 border rounded-2xl p-6 hover:bg-slate-800/50 transition-all cursor-pointer group relative",
                screener.sentiment === 'bullish' ? "border-emerald-500/30 hover:border-emerald-500/50" :
                screener.sentiment === 'bearish' ? "border-rose-500/30 hover:border-rose-500/50" :
                "border-yellow-500/30 hover:border-yellow-500/50"
              )}
            >
              <div className={cn(
                "w-1 h-12 rounded-full absolute left-0 top-1/2 -translate-y-1/2 transition-all group-hover:h-full group-hover:w-1.5",
                screener.sentiment === 'bullish' ? "bg-emerald-500" : screener.sentiment === 'bearish' ? "bg-rose-500" : "bg-yellow-500"
              )} />
              
              <div className="flex items-center justify-between mb-3">
                 <div className="flex gap-2">
                    <span className={cn(
                      "px-2 py-0.5 rounded text-[8px] font-black uppercase tracking-widest border",
                      screener.sentiment === 'bullish' ? "bg-emerald-500/10 text-emerald-500 border-emerald-500/20" : 
                      screener.sentiment === 'bearish' ? "bg-rose-500/10 text-rose-500 border-rose-500/20" : 
                      "bg-yellow-500/10 text-yellow-500 border-yellow-500/20"
                    )}>
                      {screener.sentiment}
                    </span>
                    <span className="px-2 py-0.5 bg-slate-800 rounded text-[8px] font-black text-slate-500 uppercase tracking-widest border border-slate-700">
                      {screener.category}
                    </span>
                 </div>
                 <span className="text-[8px] font-black text-slate-600 uppercase tracking-widest">{screener.timeframe}</span>
              </div>

              <h3 className="font-black text-white text-base mb-2 uppercase italic group-hover:text-amber-400 transition-colors">{screener.name}</h3>
              <p className="text-[11px] font-bold text-slate-500 leading-relaxed line-clamp-2">{screener.description}</p>
              
              {screener.confidence && (
                <div className="mt-3 flex items-center gap-2">
                  <div className="flex-1 h-1 bg-slate-800 rounded-full overflow-hidden">
                    <div 
                      className="h-full bg-blue-500 shadow-[0_0_8px_rgba(59,130,246,0.5)]" 
                      style={{ width: `${screener.confidence * 100}%` }} 
                    />
                  </div>
                  <span className="text-[8px] font-black text-blue-400 uppercase tracking-widest">AI {Math.round(screener.confidence * 100)}%</span>
                </div>
              )}
              
              <div className="mt-4 pt-4 border-t border-slate-800 flex items-center justify-between">
                 <span className="text-[9px] font-black text-amber-500/80 uppercase tracking-widest">Execute Scan</span>
                 <ChevronRight className="w-4 h-4 text-slate-700 group-hover:text-amber-500 transition-all group-hover:translate-x-1" />
              </div>
            </div>
          ))}
        </div>
      )}

      {/* Footer Info */}
      <div className="mt-12 p-6 bg-slate-900/50 border border-slate-800 rounded-2xl">
         <div className="flex flex-col md:flex-row items-center justify-between gap-6">
            <div className="flex items-center gap-4">
               <div className="p-3 bg-slate-800 rounded-xl">
                  <AlertCircle className="w-5 h-5 text-slate-500" />
               </div>
               <div>
                  <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Intelligence Network</p>
                  <p className="text-[9px] font-bold text-slate-600 uppercase tracking-wider mt-1">
                    Powered by Trendlyne & Moneycontrol APIs • Database Optimized
                  </p>
               </div>
            </div>
            <div className="flex gap-4">
               <div className="text-right">
                  <p className="text-xl font-black text-white tabular-nums italic">{categories.length}</p>
                  <p className="text-[8px] font-black text-slate-600 uppercase tracking-[0.2em]">Total Screeners</p>
               </div>
               <div className="w-px h-10 bg-slate-800" />
               <div className="text-right">
                  <p className="text-xl font-black text-amber-500 tabular-nums italic">
                     {categories.filter(c => c.sentiment === 'bullish').length}
                  </p>
                  <p className="text-[8px] font-black text-slate-600 uppercase tracking-[0.2em]">Bullish Scans</p>
               </div>
            </div>
         </div>
      </div>
    </div>
  );
};

export default TrendlyneScreenerPanel;
