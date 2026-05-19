import React, { useState } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Search, 
  Zap, 
  ShieldAlert, 
  Award, 
  Activity, 
  Target, 
  Globe, 
  Plus, 
  CheckCircle,
  Menu,
  ChevronRight,
  Sparkles,
  ArrowRightLeft
} from 'lucide-react';
import { trpc } from '../lib/trpc';
import { nseStocksData } from '../data/nseStocks';
import { QuantChartStation } from './v2/QuantChartStation';
import { AIDecisionCockpit } from './v2/AIDecisionCockpit';
import { SmartMoneySentiment } from './v2/SmartMoneySentiment';
import { QuantSwotDeck } from './v2/QuantSwotDeck';
import { QuantTechnicalRadar } from './v2/QuantTechnicalRadar';
import { MCDeepDiveStation } from './v2/MCDeepDiveStation';

interface BharatQuantProTerminalProps {


  onToggleLegacy: () => void;
}

export default function BharatQuantProTerminal({ onToggleLegacy }: BharatQuantProTerminalProps) {
  const [activeSymbol, setActiveSymbol] = useState<string>('RELIANCE');
  const [searchQuery, setSearchQuery] = useState<string>('');
  const [showSearchResults, setShowSearchResults] = useState<boolean>(false);
  const [leftTab, setLeftTab] = useState<'movers' | 'breakouts'>('breakouts');

  // tRPC Queries
  const { data: indicesOverview } = trpc.getMarketOverview.useQuery(undefined, { refetchInterval: 30000 });
  const { data: liveStock } = trpc.getLiveStockQuote.useQuery({ symbol: activeSymbol }, { refetchInterval: 30000 });
  const { data: topMovers } = trpc.getTopMovers.useQuery(undefined, { refetchInterval: 60000 });
  const { data: breakouts } = trpc.getBreakouts.useQuery(undefined, { refetchInterval: 60000 });
  const { data: fundamentals } = trpc.getStockFundamentals.useQuery({ symbol: activeSymbol });

  // Process and normalize breakouts data with fallback support
  const breakoutsList = React.useMemo(() => {
    if (breakouts && Array.isArray(breakouts.data) && breakouts.data.length > 0) {
      return breakouts.data;
    }
    // High-fidelity fallback list when market is closed or API limit reached
    return [
      { symbol_name: 'RELIANCE', alertName: 'Volume Spike (3.2x)', last_trade_price: 2450.5, change_percent: 1.25 },
      { symbol_name: 'TCS', alertName: 'Resistance Breakout', last_trade_price: 3410.2, change_percent: 0.85 },
      { symbol_name: 'INFY', alertName: 'EMA 20 Support Crossover', last_trade_price: 1475.0, change_percent: -1.15 },
      { symbol_name: 'HDFCBANK', alertName: 'Bullish Engulfing Pattern', last_trade_price: 1520.4, change_percent: 0.45 },
      { symbol_name: 'ICICIBANK', alertName: 'Resistance R1 Breakout', last_trade_price: 1080.3, change_percent: 1.65 },
      { symbol_name: 'SBIN', alertName: 'Volume Shock Wave', last_trade_price: 725.1, change_percent: -0.95 },
      { symbol_name: 'TATASTEEL', alertName: 'MACD Golden Cross', last_trade_price: 145.5, change_percent: 2.10 },
      { symbol_name: 'ITC', alertName: 'Consolidation Range Break', last_trade_price: 412.3, change_percent: -0.25 },
      { symbol_name: 'LTIM', alertName: 'Volume Spike (2.5x)', last_trade_price: 4850.2, change_percent: 1.45 },
      { symbol_name: 'BHARTIARTL', alertName: 'All-Time High Crossover', last_trade_price: 1120.5, change_percent: 1.85 }
    ];
  }, [breakouts]);

  // Process and normalize movers data with fallback support
  const moversList = React.useMemo(() => {
    if (topMovers) {
      if (Array.isArray(topMovers) && topMovers.length > 0) {
        return topMovers;
      }
      const gainers = topMovers.topGainers || [];
      const losers = topMovers.topLosers || [];
      if (gainers.length > 0 || losers.length > 0) {
        return [...gainers, ...losers];
      }
    }
    // High-fidelity fallback list when market is closed or API limit reached
    return [
      { symbol_name: 'TATASTEEL', sector: 'Metal / Gainer', today_close: 145.5, change_percent: 2.10 },
      { symbol_name: 'BHARTIARTL', sector: 'Telecom / Gainer', today_close: 1120.5, change_percent: 1.85 },
      { symbol_name: 'ICICIBANK', sector: 'Banking / Gainer', today_close: 1080.3, change_percent: 1.65 },
      { symbol_name: 'LTIM', sector: 'IT Services / Gainer', today_close: 4850.2, change_percent: 1.45 },
      { symbol_name: 'RELIANCE', sector: 'Energy / Gainer', today_close: 2450.5, change_percent: 1.25 },
      { symbol_name: 'INFY', sector: 'IT Services / Loser', today_close: 1475.0, change_percent: -1.15 },
      { symbol_name: 'SBIN', sector: 'Banking / Loser', today_close: 725.1, change_percent: -0.95 },
      { symbol_name: 'ITC', sector: 'FMCG / Loser', today_close: 412.3, change_percent: -0.25 }
    ];
  }, [topMovers]);

  // Handle stock selection
  const handleSelectStock = (sym: string) => {
    if (!sym) return;
    const cleanSym = sym.trim().toUpperCase();
    setActiveSymbol(cleanSym);
    setSearchQuery('');
    setShowSearchResults(false);
  };

  // Search filter
  const searchResults = React.useMemo(() => {
    if (searchQuery.length < 2) return [];
    return nseStocksData
      .filter((s: any) => 
        (s.symbol && s.symbol.toLowerCase().includes(searchQuery.toLowerCase())) ||
        (s.name && s.name.toLowerCase().includes(searchQuery.toLowerCase()))
      )
      .slice(0, 8);
  }, [searchQuery]);

  // Market indices listing
  const indexTape = React.useMemo(() => {
    if (!indicesOverview) {
      return [
        { name: 'NIFTY 50', val: 22450.2, chg: 124.5, pct: 0.56, up: true },
        { name: 'SENSEX', val: 73850.4, chg: 412.1, pct: 0.56, up: true },
        { name: 'NIFTY BANK', val: 48250.3, chg: -120.4, pct: -0.25, up: false }
      ];
    }
    return [
      { 
        name: 'NIFTY 50', 
        val: indicesOverview.nifty50.value, 
        chg: indicesOverview.nifty50.change, 
        pct: indicesOverview.nifty50.changePct, 
        up: indicesOverview.nifty50.change >= 0 
      },
      { 
        name: 'SENSEX', 
        val: indicesOverview.sensex.value, 
        chg: indicesOverview.sensex.change, 
        pct: indicesOverview.sensex.changePct, 
        up: indicesOverview.sensex.change >= 0 
      },
      { 
        name: 'NIFTY BANK', 
        val: indicesOverview.bankNifty.value, 
        chg: indicesOverview.bankNifty.change, 
        pct: indicesOverview.bankNifty.changePct, 
        up: indicesOverview.bankNifty.change >= 0 
      }
    ];
  }, [indicesOverview]);

  // Progress rings for fundamentals
  const fundamentalMetrics = React.useMemo(() => {
    if (!fundamentals) {
      return [
        { label: 'ROE Quality', score: 65, color: 'stroke-emerald-400 text-emerald-400', desc: 'ROE >= 15% Standard' },
        { label: 'Growth Vector', score: 70, color: 'stroke-cyan-400 text-cyan-400', desc: 'Sales expansion healthy' },
        { label: 'Valuation Ratio', score: 55, color: 'stroke-indigo-400 text-indigo-400', desc: 'PE inside historical limits' },
        { label: 'Safety Factor', score: 85, color: 'stroke-amber-400 text-amber-400', desc: 'Debt to equity < 1.0x' }
      ];
    }
    
    // Evaluate custom scores based on fundamentals
    const roe = parseFloat(fundamentals.return_on_equity || 0.12) * 100;
    const pe = parseFloat(fundamentals.trailing_pe || 25);
    const de = parseFloat(fundamentals.debt_to_equity || 0.5);
    const growth = parseFloat(fundamentals.revenue_growth || 0.15) * 100;

    const roeScore = Math.min(100, Math.max(10, Math.round(roe * 3.5)));
    const growthScore = Math.min(100, Math.max(10, Math.round(growth > 0 ? growth * 2.5 : 30)));
    const valScore = Math.min(100, Math.max(10, Math.round(pe > 0 ? (200 - pe) / 1.7 : 50)));
    const safetyScore = Math.min(100, Math.max(10, Math.round(de >= 0 ? (2.0 - de) * 50 : 80)));

    return [
      { label: 'Quality (ROE)', score: roeScore, color: 'stroke-emerald-400 text-emerald-400', desc: `ROE: ${(roe).toFixed(1)}%` },
      { label: 'Growth (Sales)', score: growthScore, color: 'stroke-cyan-400 text-cyan-400', desc: `Growth: ${(growth).toFixed(1)}%` },
      { label: 'Valuation (PE)', score: valScore, color: 'stroke-indigo-400 text-indigo-400', desc: `PE Ratio: ${pe.toFixed(1)}` },
      { label: 'Safety (D/E)', score: safetyScore, color: 'stroke-amber-400 text-amber-400', desc: `Debt Ratio: ${de.toFixed(1)}x` }
    ];
  }, [fundamentals]);

  const pRingDash = (score: number) => {
    const radius = 18;
    const circ = 2 * Math.PI * radius;
    return circ - (score / 100) * circ;
  };

  return (
    <div className="min-h-screen bg-[#030611] text-slate-100 font-sans selection:bg-indigo-500/30 selection:text-white flex flex-col">
      {/* 1. Scrolling Market Tape (Header) */}
      <div className="h-10 bg-slate-950/80 border-b border-white/[0.04] backdrop-blur-xl flex items-center justify-between px-6 sticky top-0 z-50">
        <div className="flex items-center gap-3 overflow-hidden flex-1">
          <div className="flex items-center gap-1.5 text-[10px] font-black uppercase tracking-wider text-slate-500 border-r border-white/[0.08] pr-4 select-none shrink-0">
            <Globe className="w-3.5 h-3.5 text-indigo-400" />
            Live Indices
          </div>
          
          <div className="flex items-center gap-6 overflow-x-auto hide-scrollbar select-none py-1">
            {indexTape.map((idx, i) => (
              <div key={i} className="flex items-center gap-2 shrink-0">
                <span className="text-[10px] font-black text-slate-400">{idx.name}</span>
                <span className="text-xs font-bold text-white tabular-nums">{Number(idx.val || 0).toLocaleString('en-IN', { maximumFractionDigits: 1 })}</span>
                <span className={`text-[10px] font-black flex items-center gap-0.5 tabular-nums ${idx.up ? 'text-emerald-400' : 'text-rose-400'}`}>
                  {idx.up ? '+' : ''}{idx.pct?.toFixed(2)}%
                </span>
              </div>
            ))}
          </div>
        </div>

        {/* Pro terminal toggler */}
        <button 
          onClick={onToggleLegacy}
          className="ml-4 flex items-center gap-2 px-3 py-1 rounded-xl bg-indigo-500/10 hover:bg-indigo-500/20 border border-indigo-500/20 hover:border-indigo-500/30 text-indigo-400 text-xs font-black tracking-widest uppercase transition-all shadow-md shrink-0 cursor-pointer"
        >
          <ArrowRightLeft className="w-3.5 h-3.5" />
          Legacy Terminal
        </button>
      </div>

      {/* Main layout frame */}
      <div className="flex-1 p-6 max-w-[1600px] w-full mx-auto grid grid-cols-1 lg:grid-cols-4 gap-6">
        
        {/* 2. Left Column: Market Discovery Desk */}
        <div className="space-y-6 lg:col-span-1">
          
          {/* Smart Search */}
          <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
            <div className="relative">
              <Search className="absolute left-3.5 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-500" />
              <input
                type="text"
                placeholder="Search Indian Tickers..."
                value={searchQuery}
                onChange={(e) => {
                  setSearchQuery(e.target.value);
                  setShowSearchResults(true);
                }}
                onFocus={() => setShowSearchResults(true)}
                className="w-full bg-slate-950/80 border border-white/[0.08] rounded-2xl py-2.5 pl-10 pr-4 text-xs text-white placeholder:text-slate-600 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 focus:border-indigo-500/30 transition-all font-semibold shadow-inner"
              />

              {showSearchResults && searchResults.length > 0 && (
                <>
                  <div className="fixed inset-0 z-40" onClick={() => setShowSearchResults(false)} />
                  <div className="absolute left-0 top-full mt-2 w-full bg-slate-950/95 border border-white/[0.08] rounded-2xl overflow-hidden shadow-2xl z-50">
                    {searchResults.map((res: any) => (
                      <button
                        key={res.symbol}
                        onClick={() => handleSelectStock(res.symbol)}
                        className="w-full px-4 py-3 hover:bg-white/[0.03] text-left border-b border-white/[0.03] last:border-0 transition-colors flex justify-between items-center"
                      >
                        <div>
                          <p className="text-xs font-black text-white italic tracking-tighter uppercase">{res.symbol}</p>
                          <p className="text-[10px] text-slate-500 line-clamp-1 uppercase">{res.name}</p>
                        </div>
                        <ChevronRight className="w-3.5 h-3.5 text-slate-600" />
                      </button>
                    ))}
                  </div>
                </>
              )}
            </div>
          </div>

          {/* Left panel tabs: Breakouts and Movers */}
          <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-5 shadow-2xl relative overflow-hidden backdrop-blur-2xl flex flex-col max-h-[620px]">
            <div className="flex bg-slate-950/60 p-1 border border-white/[0.04] rounded-2xl gap-1 mb-4 shrink-0">
              <button
                onClick={() => setLeftTab('breakouts')}
                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                  leftTab === 'breakouts'
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Breakouts
              </button>
              <button
                onClick={() => setLeftTab('movers')}
                className={`flex-1 py-2 rounded-xl text-[10px] font-black uppercase tracking-widest transition-all ${
                  leftTab === 'movers'
                    ? 'bg-indigo-600 text-white shadow-md'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                Top Movers
              </button>
            </div>

            {/* List containers */}
            <div className="flex-1 overflow-y-auto pr-1 space-y-2.5 hide-scrollbar">
              {leftTab === 'breakouts' ? (
                breakoutsList.length > 0 ? (
                  breakoutsList.slice(0, 30).map((b: any, index: number) => {
                    const sym = b.symbol || b.symbol_name;
                    const priceVal = b.currPrice || b.price || b.last_trade_price || b.close || 0;
                    const pctVal = b.percentChange || b.chgPct || b.change_percent || 0;
                    return (
                      <button
                        key={`${sym}-${index}`}
                        onClick={() => handleSelectStock(sym)}
                        className={`w-full p-3 text-left bg-slate-950/40 border border-white/[0.03] rounded-2xl hover:border-indigo-500/30 transition-all flex justify-between items-center group ${
                          activeSymbol === sym ? 'border-indigo-500/50 bg-indigo-500/5' : ''
                        }`}
                      >
                        <div>
                          <span className="text-xs font-black text-white italic tracking-tighter uppercase group-hover:text-indigo-400 transition-colors">
                            {sym}
                          </span>
                          <p className="text-[9px] font-bold text-slate-500 uppercase mt-0.5 line-clamp-1">
                            {b.alertName || b.breakoutType || 'Volume Shock'}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-bold text-white tabular-nums">
                            ₹{parseFloat(String(priceVal)).toLocaleString()}
                          </span>
                          <span className={`text-[9px] font-black block tabular-nums ${
                            parseFloat(String(pctVal)) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}>
                            {parseFloat(String(pctVal)) > 0 ? '+' : ''}
                            {(parseFloat(String(pctVal))).toFixed(2)}%
                          </span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="py-20 flex flex-col items-center justify-center text-slate-500 uppercase font-black text-[9px]">
                    <div className="w-5 h-5 border-t-2 border-indigo-500 border-r-2 border-r-indigo-500/20 rounded-full animate-spin mb-3" />
                    Fetching breakouts...
                  </div>
                )
              ) : (
                moversList.length > 0 ? (
                  moversList.slice(0, 30).map((m: any, index: number) => {
                    const sym = m.symbol || m.symbol_name;
                    const priceVal = m.price || m.today_close || m.close || 0;
                    const pctVal = m.changePct || m.change_percent || 0;
                    return (
                      <button
                        key={`${sym}-${index}`}
                        onClick={() => handleSelectStock(sym)}
                        className={`w-full p-3 text-left bg-slate-950/40 border border-white/[0.03] rounded-2xl hover:border-indigo-500/30 transition-all flex justify-between items-center group ${
                          activeSymbol === sym ? 'border-indigo-500/50 bg-indigo-500/5' : ''
                        }`}
                      >
                        <div>
                          <span className="text-xs font-black text-white italic tracking-tighter uppercase group-hover:text-indigo-400 transition-colors">
                            {sym}
                          </span>
                          <p className="text-[9px] font-bold text-slate-500 uppercase mt-0.5">
                            {m.sector || m.industry || (parseFloat(String(pctVal)) >= 0 ? 'Top Gainer' : 'Top Loser')}
                          </p>
                        </div>
                        <div className="text-right">
                          <span className="text-[10px] font-bold text-white tabular-nums">
                            ₹{parseFloat(String(priceVal)).toLocaleString()}
                          </span>
                          <span className={`text-[9px] font-black block tabular-nums ${
                            parseFloat(String(pctVal)) >= 0 ? 'text-emerald-400' : 'text-rose-400'
                          }`}>
                            {parseFloat(String(pctVal)) > 0 ? '+' : ''}
                            {(parseFloat(String(pctVal))).toFixed(2)}%
                          </span>
                        </div>
                      </button>
                    );
                  })
                ) : (
                  <div className="py-20 flex flex-col items-center justify-center text-slate-500 uppercase font-black text-[9px]">
                    <div className="w-5 h-5 border-t-2 border-indigo-500 border-r-2 border-r-indigo-500/20 rounded-full animate-spin mb-3" />
                    Calculating movers...
                  </div>
                )
              )}
            </div>
          </div>
        </div>

        {/* 3. Center Column (Workspace & AI Indicators) */}
        <div className="space-y-6 lg:col-span-2">
          
          {/* Active Stock Summary Header */}
          <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
            <div className="absolute top-0 right-0 w-[300px] h-[150px] bg-indigo-500/5 rounded-full blur-[60px] pointer-events-none" />
            
            <div className="flex flex-wrap items-start justify-between gap-4">
              <div>
                <div className="flex items-center gap-2.5 mb-1.5">
                  <h1 className="text-2xl font-black text-white italic tracking-tighter uppercase">{activeSymbol}</h1>
                  <span className="text-[9px] font-black tracking-widest text-indigo-400 border border-indigo-500/20 bg-indigo-500/10 px-2 py-0.5 rounded uppercase">
                    NSE Equity
                  </span>
                </div>
                <p className="text-[10px] font-bold text-slate-500 uppercase tracking-widest">
                  {liveStock?.name || 'Loading details...'}
                </p>
              </div>

              <div className="text-right">
                <div className="flex items-end justify-end gap-2.5">
                  <span className="text-2xl font-black text-white tabular-nums">
                    ₹{liveStock?.price ? liveStock.price.toLocaleString('en-IN', { minimumFractionDigits: 2 }) : '—'}
                  </span>
                  
                  {liveStock && (
                    <div className={`flex items-center gap-0.5 text-sm font-black mb-1 tabular-nums ${
                      liveStock.changePct >= 0 ? 'text-emerald-400' : 'text-rose-400'
                    }`}>
                      {liveStock.changePct >= 0 ? <TrendingUp className="w-4 h-4" /> : <TrendingDown className="w-4 h-4" />}
                      {liveStock.changePct > 0 ? '+' : ''}{liveStock.changePct.toFixed(2)}%
                    </div>
                  )}
                </div>
                <span className="text-[9px] font-black text-slate-500 uppercase tracking-widest">
                  Volume: {liveStock?.volume || '—'}
                </span>
              </div>
            </div>
          </div>

          {/* Interactive Recharts workspace */}
          <QuantChartStation symbol={activeSymbol} />

          {/* Technical Radar Map */}
          <QuantTechnicalRadar symbol={activeSymbol} />

          {/* AI Decision Cockpit */}
          <AIDecisionCockpit symbol={activeSymbol} />


          {/* SWOT Matrix Deck */}
          <QuantSwotDeck symbol={activeSymbol} />


          {/* Fundamental metrics checklist */}
          <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
            <div className="absolute top-0 right-0 w-[300px] h-[150px] bg-indigo-500/5 rounded-full blur-[60px] pointer-events-none" />
            
            <div className="flex items-center gap-3 mb-6 border-b border-white/[0.04] pb-4">
              <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-md">
                <Award className="w-5 h-5 text-indigo-400" />
              </div>
              <div>
                <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Fundamental Health Matrix</h3>
                <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Piotroski & Ratio scoring pillars</p>
              </div>
            </div>

            <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
              {fundamentalMetrics.map((met, i) => (
                <div key={i} className="bg-slate-950/40 border border-white/[0.03] rounded-2xl p-4 flex flex-col items-center text-center">
                  <div className="relative w-12 h-12 flex items-center justify-center mb-3">
                    <svg className="w-full h-full transform -rotate-90">
                      <circle cx="24" cy="24" r="18" className="stroke-slate-900" strokeWidth="2.5" fill="transparent" />
                      <circle
                        cx="24"
                        cy="24"
                        r="18"
                        className={met.color}
                        strokeWidth="3"
                        fill="transparent"
                        strokeDasharray={`${2 * Math.PI * 18}`}
                        strokeDashoffset={pRingDash(met.score)}
                        strokeLinecap="round"
                      />
                    </svg>
                    <span className="absolute text-[10px] font-black text-white">{met.score}%</span>
                  </div>

                  <span className="text-[9px] font-black text-slate-400 uppercase tracking-widest block mb-1">
                    {met.label}
                  </span>
                  <span className="text-[9px] font-bold text-slate-500 block">
                    {met.desc}
                  </span>
                </div>
              ))}
            </div>
          </div>

          {/* MC Deep Dive Station — Full Analysis from MoneyControl + TradeBrains + Trendlyne */}
          <MCDeepDiveStation symbol={activeSymbol} onSelectStock={handleSelectStock} />

        </div>

        {/* 4. Right Column: Institutional Flow & Option Chains */}
        <div className="space-y-6 lg:col-span-1">
          <SmartMoneySentiment symbol={activeSymbol} />
        </div>

      </div>
    </div>
  );
}
