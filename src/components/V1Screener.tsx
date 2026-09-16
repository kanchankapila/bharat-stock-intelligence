import React, { useState, useMemo } from 'react';
import {
  Filter, Zap, TrendingUp, Search, Download, Minus, Plus, ArrowUpRight,
} from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import type { MarketData } from '../services/marketService';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this only mounts when a user opens the Screener tab.
export const V1Screener: React.FC<{
  stocks?: MarketData[];
  onSelectStock: (symbol: string) => void;
  watchlist: string[];
  onToggleWatchlist: (symbol: string, metadata?: { price?: number; name?: string; source?: string }) => void;
}> = ({ onSelectStock, watchlist, onToggleWatchlist }) => {
  const [filter, setFilter] = useState('All');
  const [activeScanner, setActiveScanner] = useState<any>(null);
  const [searchQuery, setSearchQuery] = useState('');
  const [sortField, setSortField] = useState<string>('symbol');
  const [sortOrder, setSortOrder] = useState<'asc' | 'desc'>('asc');
  const [activeTab, setActiveTab] = useState<'fundamental' | 'technical'>('fundamental');

  // Specific Fundamental Filters
  const [minPe, setMinPe] = useState<number | undefined>(undefined);
  const [maxPe, setMaxPe] = useState<number | undefined>(undefined);
  const [minRoe, setMinRoe] = useState<number | undefined>(undefined);
  const [maxPb, setMaxPb] = useState<number | undefined>(undefined);
  const [maxDe, setMaxDe] = useState<number | undefined>(undefined);

  // Advanced Screener Filters
  const [minVolume, setMinVolume] = useState<number>(0);
  const [minMktCap, setMinMktCap] = useState<number>(0);
  const [selectedSector, setSelectedSector] = useState<string>('All');
  const [selectedTimeframes, setSelectedTimeframes] = useState<string[]>(['1h', 'D']);

  const { data: sectors } = trpc.getAllSectors.useQuery();

  const { data: stocks, isLoading: stocksLoading } = trpc.getScreenerResults.useQuery(
    {
      filter,
      sector: selectedSector,
      minPe,
      maxPe,
      minRoe,
      maxPb,
      maxDe
    },
    { enabled: filter !== 'External' && filter !== 'TradingView' && activeTab === 'fundamental' }
  );

  const { data: tvScreener, isLoading: tvScreenerLoading } = trpc.getTvScreener.useQuery(undefined, {
    enabled: filter === 'TradingView' && activeTab === 'fundamental'
  });

  const { data: scannerGroups } = trpc.getMarketScanners.useQuery();

  const { data: marketData, isLoading: marketLoading } = trpc.fetchMarketData.useQuery(
    {
      provider: activeScanner?.provider,
      params: activeScanner?.provider === 'mc' ? {
        type: activeScanner.type, catId: activeScanner.catId, scanId: activeScanner.scanId
      } : activeScanner?.provider === 'custom' ? {
        timeframes: selectedTimeframes,
        minVolume,
        minMktCap,
        sector: selectedSector
      } : {
        screenerId: activeScanner?.screenerId, queryCondition: activeScanner?.queryCondition
      }
    },
    { enabled: !!activeScanner && activeTab === 'technical' }
  );

  const handleScannerSelect = (scanner: any) => {
    setFilter('External');
    setActiveScanner(scanner);
    setActiveTab('technical');
  };

  const isLoading = (activeTab === 'fundamental' && (stocksLoading || tvScreenerLoading)) || (activeTab === 'technical' && marketLoading);

  // Process data based on provider. Was recomputed (filter + sort, unmemoized) on every render
  // of this screener route -- App() itself re-renders on essentially any top-level state change
  // (toasts, drawer, watchlist, etc.), so this filter/sort over the full result set reran far
  // more often than the underlying query data actually changed.
  const { displayStocks, displayColumns, processedStocks } = useMemo(() => {
    let displayStocks: any[] = [];
    let displayColumns: string[] = [];

    if (activeTab === 'technical' && activeScanner?.provider === 'mc') {
      displayStocks = marketData?.data?.list?.scannerDetails || [];
      displayColumns = displayStocks[0]?.columns?.map((c: any) => c.name) || [];
    } else if (activeTab === 'technical' && activeScanner?.provider === 'custom') {
      displayStocks = marketData?.data?.list?.scannerDetails || [];
      displayColumns = ['timeframesMet', 'momentum', 'pattern', 'mktCap'];
    } else if (activeTab === 'technical' && activeScanner?.provider === 'et') {
      displayStocks = marketData?.searchResult?.searchData?.records || [];
      // ETnow usually returns column names in a header or we can skip and show basic info
      const firstStock = displayStocks[0];
      if (firstStock) {
        displayColumns = Object.keys(firstStock).filter(k =>
          !['stkId', 'stkname', 'ltp', 'perChg', 'scUrl', 'symbol', 'name', 'companyName', 'recoid', 'id'].includes(k)
        ).slice(0, 4); // Limit to key columns
      }
    } else if (activeTab === 'fundamental' && filter === 'TradingView') {
      displayStocks = tvScreener?.results || [];
      displayColumns = ['market_cap', 'volume', 'recommendation'];
    } else if (activeTab === 'fundamental') {
      displayStocks = stocks || [];
      displayColumns = ['pe', 'roe', 'pb', 'debtEquity'];
    }

    const processedStocks = displayStocks.filter(s => {
      const symbol = s.symbol || s.stkId || s.ticker || "";
      const name = s.name || s.stkname || s.companyName || "";
      const matchesSearch = symbol.toLowerCase().includes(searchQuery.toLowerCase()) ||
                            name.toLowerCase().includes(searchQuery.toLowerCase());
      return matchesSearch;
    }).sort((a, b) => {
      let aVal: any, bVal: any;

      if (activeTab === 'fundamental') {
        aVal = (a as any)[sortField];
        bVal = (b as any)[sortField];
      } else {
        // For external, we mostly sort by price or change if available
        if (sortField === 'ltp' || sortField === 'price') {
           aVal = parseFloat(a.ltp || a.price || a.lastPrice || 0);
           bVal = parseFloat(b.ltp || b.price || b.lastPrice || 0);
        } else if (sortField === 'perChg' || sortField === 'changePct') {
           aVal = parseFloat(a.perChg || a.changePct || a.percentageChange || 0);
           bVal = parseFloat(b.perChg || b.changePct || b.percentageChange || 0);
        } else {
           aVal = (a.stkname || a.companyName || a.symbol || "").toLowerCase();
           bVal = (b.stkname || b.companyName || b.symbol || "").toLowerCase();
        }
      }

      if (aVal === undefined || aVal === null) return 1;
      if (bVal === undefined || bVal === null) return -1;

      if (aVal < bVal) return sortOrder === 'asc' ? -1 : 1;
      if (aVal > bVal) return sortOrder === 'asc' ? 1 : -1;
      return 0;
    });

    return { displayStocks, displayColumns, processedStocks };
  }, [activeTab, activeScanner?.provider, marketData, tvScreener, stocks, filter, searchQuery, sortField, sortOrder]);

  const handleSort = (field: string) => {
    if (sortField === field) {
      setSortOrder(sortOrder === 'asc' ? 'desc' : 'asc');
    } else {
      setSortField(field);
      setSortOrder('desc');
    }
  };

  return (
    <div className="p-6 space-y-6">
      <Card
        title={activeScanner ? `Market Intelligence: ${activeScanner.name}` : "Elite Stock Discovery"}
        icon={Filter}
      >
        <div className="flex flex-col gap-10 mb-8">
           {activeScanner && (
             <div className="p-5 bg-emerald-500/5 border border-emerald-500/20 rounded-3xl relative overflow-hidden group">
                <div className="absolute top-0 right-0 w-32 h-32 bg-emerald-500/10 blur-3xl -mr-16 -mt-16 group-hover:bg-emerald-500/20 transition-colors" />
                <div className="relative z-10">
                  <div className="flex items-center gap-3 mb-2">
                    <div className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse" />
                    <h3 className="text-base font-black text-slate-200 italic tracking-tight uppercase">
                      {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerName || activeScanner.name) : activeScanner.name}
                    </h3>
                  </div>
                  <p className="text-xs text-slate-400 font-medium leading-relaxed italic max-w-2xl">
                    {activeScanner.provider === 'mc' ? (marketData?.data?.list?.scannerDescription || "Advanced technical analysis for professional trading.") : "Strategic fundamental screening powered by Economic Times Intelligence."}
                  </p>
                </div>
             </div>
           )}

           <div className="grid grid-cols-1 lg:grid-cols-12 gap-8">
              <div className="lg:col-span-3 space-y-6">
                <div className="space-y-4">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Zap className="w-3 h-3 text-indigo-500" /> System Presets
                  </h4>
                  <div className="flex flex-col gap-2">
                    {['All', 'TradingView', 'Gainers', 'Losers', 'High ROE', 'Low Debt', 'Near 52W High', 'Near 52W Low'].map(tag => (
                      <button
                          key={tag}
                          onClick={() => { setFilter(tag); setActiveScanner(null); }}
                          className={cn(
                              "px-4 py-2.5 text-[10px] font-black tracking-widest transition-all uppercase text-left",
                              (filter === tag && !activeScanner) ? "bg-indigo-600 border border-indigo-600 rounded-[10px] text-white shadow-lg shadow-indigo-500/20" : "v1-card text-slate-400 hover:text-white"
                          )}
                      >
                        {tag}
                      </button>
                    ))}
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/30">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <Filter className="w-3 h-3 text-emerald-500" /> Fundamental Gears
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Max P/E Ratio</label>
                       <input
                          type="range" min="0" max="60" step="5"
                          value={maxPe || 60}
                          onChange={(e) => setMaxPe(parseInt(e.target.value))}
                          className="w-full accent-indigo-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxPe || 60}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Min ROE %</label>
                       <input
                          type="range" min="0" max="40" step="5"
                          value={minRoe || 0}
                          onChange={(e) => setMinRoe(parseInt(e.target.value))}
                          className="w-full accent-emerald-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{minRoe || 0}%</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Max P/B Ratio</label>
                       <input
                          type="range" min="0" max="15" step="1"
                          value={maxPb || 15}
                          onChange={(e) => setMaxPb(parseInt(e.target.value))}
                          className="w-full accent-indigo-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxPb || 15}</span></div>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Max D/E Ratio</label>
                       <input
                          type="range" min="0" max="3" step="0.5"
                          value={maxDe || 3}
                          onChange={(e) => setMaxDe(parseFloat(e.target.value))}
                          className="w-full accent-rose-500 h-1 glass rounded-full appearance-none cursor-pointer"
                       />
                       <div className="flex justify-between text-[8px] font-bold text-slate-400"><span>0</span><span>{maxDe || 3.0}</span></div>
                    </div>
                    <button
                       onClick={() => { setMaxPe(undefined); setMinRoe(undefined); setMaxDe(undefined); setMaxPb(undefined); }}
                       className="w-full py-2 glass-strong border border-slate-800/50 rounded-lg text-[8px] font-black text-slate-400 font-display uppercase tracking-widest hover:border-slate-800/30 hover:text-slate-300 transition-all"
                    >
                       Reset Gears
                    </button>
                  </div>
                </div>

                <div className="space-y-4 pt-4 border-t border-slate-800/30">
                  <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em] flex items-center gap-2">
                    <TrendingUp className="w-3 h-3 text-rose-500" /> Breakout & Trend
                  </h4>
                  <div className="space-y-4">
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Min Market Cap (Cr)</label>
                       <select
                          value={minMktCap}
                          onChange={(e) => setMinMktCap(parseInt(e.target.value))}
                          className="w-full glass-strong border border-slate-800/50 rounded-lg py-2 px-3 text-[10px] font-bold text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                       >
                          <option value="0">All Caps</option>
                          <option value="500">500 Cr+</option>
                          <option value="2000">2,000 Cr+</option>
                          <option value="10000">10,000 Cr+</option>
                          <option value="50000">50,000 Cr+</option>
                       </select>
                    </div>
                    <div className="space-y-1.5">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Sector Focus</label>
                       <select
                          value={selectedSector}
                          onChange={(e) => setSelectedSector(e.target.value)}
                          className="w-full glass-strong border border-slate-800/50 rounded-lg py-2 px-3 text-[10px] font-bold text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500"
                       >
                          <option value="All">All Sectors</option>
                          <option value="Energy">Energy</option>
                          <option value="IT">IT</option>
                          <option value="Banking">Banking</option>
                          <option value="Auto">Auto</option>
                          <option value="Healthcare">Healthcare</option>
                       </select>
                    </div>
                    <div className="space-y-2">
                       <label className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Timeframe Multi-Select</label>
                       <div className="grid grid-cols-2 gap-2">
                          {['15m', '1h', '4h', 'D', 'W'].map(tf => (
                            <button
                              key={tf}
                              onClick={() => {
                                if (selectedTimeframes.includes(tf)) {
                                  setSelectedTimeframes(selectedTimeframes.filter(t => t !== tf));
                                } else {
                                  setSelectedTimeframes([...selectedTimeframes, tf]);
                                }
                              }}
                              className={cn(
                                "px-2 py-1.5 text-[9px] font-black tracking-widest transition-all",
                                selectedTimeframes.includes(tf) ? "bg-indigo-600 border border-indigo-600 rounded-[10px] text-white" : "v1-card text-slate-400"
                              )}
                            >
                              {tf}
                            </button>
                          ))}
                       </div>
                    </div>
                  </div>
                </div>
              </div>

              <div className="lg:col-span-9 space-y-8">
                {activeTab === 'technical' && scannerGroups?.map((group) => (
                  <div key={group.category} className="space-y-4">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">{group.category}</h4>
                    <div className="flex flex-wrap gap-2">
                      {group.items.map(scanner => (
                        <button
                            key={scanner.id}
                            onClick={() => handleScannerSelect(scanner)}
                            className={cn(
                                "px-4 py-2 text-[10px] font-black tracking-widest transition-all uppercase",
                                activeScanner?.id === scanner.id ? "bg-emerald-600 border border-emerald-600 rounded-[10px] text-white shadow-lg shadow-emerald-500/20" : "v1-card text-slate-400 hover:text-white"
                            )}
                        >
                          {scanner.name}
                        </button>
                      ))}
                    </div>
                  </div>
                ))}
            <div className="flex flex-col md:flex-row gap-4 items-center justify-between pt-6 border-t border-slate-800/30">
              <div className="flex flex-col gap-4 w-full">
                <div className="flex items-center gap-3">
                   <h4 className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest">Quick Technical Screener:</h4>
                   <div className="flex flex-wrap gap-2">
                      {[
                        { name: 'Bullish BO', id: 'mc-25-BPBULL' },
                        { name: 'RSI Power', id: 'mc-25-RSIPOWBO' },
                        { name: '52W High', id: 'mc-17-52HIGH' },
                        { name: '52W Low', id: 'mc-17-52LOW' }
                      ].map(iq => (
                        <button
                          key={iq.id}
                          onClick={() => {
                            const scanner = (scannerGroups as any)?.flatMap((g: any) => g.items).find((i: any) => i.id === iq.id);
                            if (scanner) handleScannerSelect(scanner);
                          }}
                          className={cn(
                            "px-3 py-1.5 rounded-lg text-[9px] font-bold tracking-tight uppercase border transition-all",
                            activeScanner?.id === iq.id ? "bg-indigo-600 border-indigo-600 text-white" : "glass border-slate-800/50 text-slate-400 hover:border-slate-800/30 hover:text-white"
                          )}
                        >
                          {iq.name}
                        </button>
                      ))}
                   </div>
                </div>

                <div className="relative w-full md:w-96">
                  <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
                  <input
                    type="text"
                    placeholder="Deep search assets..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="glass-strong border border-slate-800/50 rounded-2xl py-3.5 pl-10 pr-4 text-xs text-slate-200 focus:outline-none focus:ring-1 focus:ring-indigo-500 w-full transition-all"
                  />
                </div>
              </div>
              <div className="flex gap-3 shrink-0">
                <div className="flex glass-strong border border-slate-800/50 p-1 rounded-2xl">
                   <button
                    onClick={() => { setActiveTab('fundamental'); setFilter('All'); setActiveScanner(null); }}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'fundamental' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-300"
                    )}
                   >Fundamental</button>
                   <button
                    onClick={() => setActiveTab('technical')}
                    className={cn(
                      "px-5 py-2.5 rounded-xl text-[10px] font-black tracking-widest uppercase transition-all",
                      activeTab === 'technical' ? "bg-indigo-600 text-white shadow-sm" : "text-slate-400 hover:text-slate-300"
                    )}
                   >Technical</button>
                </div>
                <button className="flex items-center gap-2 glass-strong text-slate-400 border border-slate-800/50 px-5 py-3 rounded-2xl text-[10px] font-black tracking-widest transition-all hover:text-white hover:border-slate-800/30 uppercase">
                  <Download className="w-3 h-3" />
                  Extract
                </button>
              </div>
         </div>

        <div className="overflow-x-auto v1-card">
          {isLoading ? (
            <div className="py-48 flex flex-col items-center justify-center space-y-6">
              <div className="relative w-12 h-12">
                <div className="absolute inset-0 border-2 border-indigo-500/20 rounded-full" />
                <div className="absolute inset-0 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
              </div>
              <p className="text-[10px] font-black text-slate-400 uppercase tracking-[0.3em] animate-pulse">Synchronizing Intelligence...</p>
            </div>
          ) : (
            <table className="w-full text-left border-collapse">
              <thead>
                <tr className="glass/50 backdrop-blur-xl">
                  <th
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('symbol')}
                  >
                    Asset {sortField === 'symbol' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-right cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('price')}
                  >
                    LTP {sortField === 'price' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  <th
                    className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-center cursor-pointer hover:text-white transition-colors"
                    onClick={() => handleSort('changePct')}
                  >
                    Momentum {sortField === 'changePct' && (sortOrder === 'asc' ? '↑' : '↓')}
                  </th>
                  {displayColumns.map(col => (
                    <th key={col} className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-center">{col}</th>
                  ))}
                  <th className="px-6 py-6 font-black text-[9px] text-slate-400 uppercase tracking-[0.25em] border-b border-slate-800/50 text-right">Direct</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-800/30">
                {processedStocks.map((row: any, idx: number) => {
                  const symbol = row.symbol || row.stkId || row.ticker;
                  const name = row.name || row.stkname || row.companyName || "";
                  const ltp = row.price || row.ltp || row.lastPrice || 0;
                  const perChg = row.changePct || row.perChg || row.percentageChange || 0;

                  return (
                    <tr
                      key={idx}
                      onClick={() => onSelectStock(symbol)}
                      className="hover:bg-slate-800/20 group transition-all cursor-pointer"
                    >
                      <td className="px-6 py-6" onClick={(e) => e.stopPropagation()}>
                        <div className="flex items-center gap-3">
                          {watchlist.includes(symbol) ? (
                            <button
                              onClick={() => onToggleWatchlist(symbol)}
                              className="p-1.5 bg-rose-500/10 border border-rose-500/20 rounded-lg text-rose-500 hover:bg-rose-500 hover:text-white transition-all shadow-md flex items-center justify-center w-8 h-8"
                              title="Remove from Watchlist"
                            >
                              <Minus className="w-3.5 h-3.5" />
                            </button>
                          ) : (
                            <button
                              onClick={() => onToggleWatchlist(symbol, { price: parseFloat(ltp), name, source: `Screener: ${activeScanner?.name || filter}` })}
                              className="p-1.5 bg-emerald-500/10 border border-emerald-500/20 rounded-lg text-emerald-500 hover:bg-emerald-500 hover:text-white transition-all shadow-md flex items-center justify-center w-8 h-8"
                              title="Add to Watchlist"
                            >
                              <Plus className="w-3.5 h-3.5" />
                            </button>
                          )}
                          <div className="cursor-pointer" onClick={() => onSelectStock(symbol)}>
                            <div className="font-black text-slate-200 text-xs tracking-tight group-hover:text-indigo-400 transition-colors uppercase truncate max-w-[150px]">{name || symbol}</div>
                            <div className="text-[8px] text-slate-400 font-bold tracking-widest mt-1 uppercase italic truncate max-w-[150px]">{symbol}</div>
                          </div>
                        </div>
                      </td>
                      <td className="px-6 py-6 text-right font-black text-xs tabular-nums text-slate-100">₹{parseFloat(ltp).toLocaleString('en-IN', { minimumFractionDigits: 2 })}</td>
                      <td className="px-6 py-6 text-center">
                        <span className={cn(
                          "font-black text-[10px] tabular-nums px-3 py-1.5 rounded-lg border",
                          parseFloat(perChg) >= 0 ? "text-emerald-400 bg-emerald-400/5 border-emerald-400/10" : "text-rose-400 bg-rose-400/5 border-rose-400/10"
                        )}>
                          {parseFloat(perChg) >= 0 ? '+' : ''}{parseFloat(perChg).toFixed(2)}%
                        </span>
                      </td>
                      {activeTab === 'fundamental' ? (
                        ['pe', 'roe', 'pb', 'debtEquity'].map(f => (
                          <td key={f} className="px-6 py-6 text-center font-bold text-[10px] text-slate-400 font-display uppercase tracking-widest">
                            {row[f]?.toFixed(2) || '-'}
                          </td>
                        ))
                      ) : (
                        (row.columns || displayColumns.map(c => ({ name: c, value: row[c] }))).map((c: any, cidx: number) => (
                          <td key={cidx} className="px-6 py-6 text-center font-bold text-[10px] text-slate-300 uppercase italic">
                            {c.value || '-'}
                          </td>
                        ))
                      )}
                      <td className="px-6 py-6 text-right">
                         <button
                            onClick={() => onSelectStock(symbol)}
                            className="p-2.5 glass border border-slate-800/50 rounded-xl text-slate-400 hover:text-white hover:border-slate-600 transition-all"
                         >
                            <ArrowUpRight className="w-4 h-4" />
                         </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  </div>
  </Card>
  </div>
  );
};

export default V1Screener;
