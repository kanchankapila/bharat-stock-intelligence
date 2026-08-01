import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Loader2, TrendingUp, Shield, Zap, Target, Activity, CheckCircle2 } from 'lucide-react';
import { cn } from '../lib/utils';
import { LegacyScoreBanner } from './CanonicalSourceNote';

export function InvestmentStrategy({ onSelectStock }: { onSelectStock: (symbol: string) => void }) {
  const [activeTab, setActiveTab] = useState<'INVESTMENT' | 'INTRADAY'>('INVESTMENT');
  const { data: strategies, isLoading } = trpc.getStrategyPicks.useQuery(undefined, { refetchInterval: 5 * 60 * 1000 });

  if (isLoading) {
    return (
      <div className="p-8 flex flex-col items-center justify-center text-slate-400 min-h-[400px]">
        <Loader2 className="w-8 h-8 animate-spin mb-4 text-indigo-500" />
        <p className="font-bold">Analyzing cross-platform screeners...</p>
        <p className="text-xs mt-2">Computing fundamental and technical confluence</p>
      </div>
    );
  }

  const investmentPicks = strategies?.investmentPicks || [];
  const intradayPicks = strategies?.intradayPicks || [];

  return (
    <div className="p-4 md:p-6 space-y-6 max-w-7xl mx-auto">
      {/* Header */}
      <div className="flex flex-col md:flex-row md:items-end justify-between gap-4">
        <div>
          <h2 className="text-3xl font-black text-white tracking-tight flex items-center gap-3">
            <Target className="w-8 h-8 text-indigo-400" />
            Strategy Builder Hub
          </h2>
          <p className="text-slate-400 text-sm mt-1 max-w-2xl">
            Multi-screener confluence engine. We cross-reference ET Now, MoneyControl, and Trendlyne scanners to find high-probability setups.
          </p>
        </div>
        
        {/* Tabs */}
        <div className="flex items-center gap-2 glass/50 p-1 rounded-xl border border-slate-800/50">
          <button
            onClick={() => setActiveTab('INVESTMENT')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2",
              activeTab === 'INVESTMENT' ? "bg-indigo-600 text-white shadow-lg shadow-indigo-500/20" : "text-slate-400 hover:text-white"
            )}
          >
            <Shield className="w-4 h-4" /> Quality Compounders
          </button>
          <button
            onClick={() => setActiveTab('INTRADAY')}
            className={cn(
              "px-4 py-2 rounded-lg text-sm font-bold transition-all flex items-center gap-2",
              activeTab === 'INTRADAY' ? "bg-rose-600 text-white shadow-lg shadow-rose-500/20" : "text-slate-400 hover:text-white"
            )}
          >
            <Zap className="w-4 h-4" /> Intraday Momentum
          </button>
        </div>
      </div>

      <LegacyScoreBanner note="Ranked by an independent screener-confluence formula (ET/MoneyControl/Trendlyne membership counts), not the unified cross-engine model -- check Alpha / Buy Recs for the canonical, regime-aware view of the same stocks." />

      {/* Content */}
      {activeTab === 'INVESTMENT' && (
        <div className="space-y-4">
          <div className="bg-emerald-500/10 border border-emerald-500/20 rounded-xl p-4 flex items-start gap-3">
            <CheckCircle2 className="w-5 h-5 text-emerald-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-emerald-400">The Bharat Core Compounder Strategy</h3>
              <p className="text-xs text-slate-300 mt-1">
                Looks for stocks with zero debt, monopoly characteristics, and strong cash flows that are currently trading at attractive technical entry points (Buy on Dips, RSI Oversold). Perfect for medium to long-term holding.
              </p>
            </div>
          </div>

          {investmentPicks.length === 0 ? (
            <div className="text-center py-12 text-slate-400 bg-slate-950/30 rounded-xl border border-slate-800/50">
              No stocks currently meet the strict quality + value criteria.
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {investmentPicks.map((pick: any) => (
                <div key={pick.symbol} className="bg-slate-900/40 border border-slate-800/50 hover:border-indigo-500/50 transition-colors rounded-xl p-4 flex flex-col">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <button onClick={() => onSelectStock(pick.symbol)} className="text-lg font-black text-white hover:text-indigo-400 transition-colors text-left">
                        {pick.symbol}
                      </button>
                      <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold truncate max-w-[150px]">{pick.sector || 'Unknown Sector'}</p>
                      {pick.price != null && (
                        <p className="text-sm font-bold text-white mt-0.5">
                          ₹{pick.price.toLocaleString('en-IN')}
                          <span className={cn("ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded", pick.priceSource === 'live' ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700/60 text-slate-400")}>
                            {pick.priceSource === 'live' ? 'LIVE' : 'EOD'}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-2xl font-black text-emerald-400">{pick.score}</span>
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Conviction</span>
                    </div>
                  </div>
                  
                  <div className="mt-auto space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {pick.reasons.map((r: string, i: number) => (
                        <span key={i} className={cn(
                          "text-[10px] font-bold px-2 py-0.5 rounded border",
                          r.includes('Debt') || r.includes('Cash') || r.includes('Monopoly') || r.includes('Bluechip') || r.includes('Fundamental')
                            ? "bg-indigo-500/10 border-indigo-500/20 text-indigo-300" 
                            : "bg-emerald-500/10 border-emerald-500/20 text-emerald-300"
                        )}>
                          {r}
                        </span>
                      ))}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      {activeTab === 'INTRADAY' && (
        <div className="space-y-4">
          <div className="bg-rose-500/10 border border-rose-500/20 rounded-xl p-4 flex items-start gap-3">
            <Activity className="w-5 h-5 text-rose-400 shrink-0 mt-0.5" />
            <div>
              <h3 className="text-sm font-bold text-rose-400">Intraday Momentum Engine</h3>
              <p className="text-xs text-slate-300 mt-1">
                Aggregates live intraday triggers from Trendlyne (MACD, CCI, Supertrend crossovers) and MoneyControl Tech scanners. High scores indicate confluence across multiple timeframes.
              </p>
            </div>
          </div>

          {intradayPicks.length === 0 ? (
            <div className="text-center py-12 text-slate-400 bg-slate-950/30 rounded-xl border border-slate-800/50">
              No intraday momentum triggers detected right now. (Wait for market hours)
            </div>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {intradayPicks.map((pick: any) => (
                <div key={pick.symbol} className="bg-slate-900/40 border border-slate-800/50 hover:border-rose-500/50 transition-colors rounded-xl p-4 flex flex-col">
                  <div className="flex justify-between items-start mb-3">
                    <div>
                      <button onClick={() => onSelectStock(pick.symbol)} className="text-lg font-black text-white hover:text-rose-400 transition-colors text-left">
                        {pick.symbol}
                      </button>
                      <p className="text-[10px] text-slate-400 uppercase tracking-widest font-bold truncate max-w-[150px]">{pick.sector || 'Unknown Sector'}</p>
                      {pick.price != null && (
                        <p className="text-sm font-bold text-white mt-0.5">
                          ₹{pick.price.toLocaleString('en-IN')}
                          <span className={cn("ml-1.5 text-[10px] font-bold px-1.5 py-0.5 rounded", pick.priceSource === 'live' ? "bg-emerald-500/20 text-emerald-400" : "bg-slate-700/60 text-slate-400")}>
                            {pick.priceSource === 'live' ? 'LIVE' : 'EOD'}
                          </span>
                        </p>
                      )}
                    </div>
                    <div className="flex flex-col items-end">
                      <span className="text-2xl font-black text-rose-400">{pick.score}</span>
                      <span className="text-[10px] uppercase tracking-wider text-slate-400 font-bold">Strength</span>
                    </div>
                  </div>
                  
                  <div className="mt-auto space-y-2">
                    <div className="flex flex-wrap gap-1.5">
                      {pick.reasons.map((r: string, i: number) => {
                        const isTl = r.includes('Trendlyne');
                        // TL IDs: 5693, etc. Try to map them or just show them.
                        const label = isTl ? r.replace('Trendlyne Intraday ID: ', 'TL Scan: ') : r;
                        return (
                          <span key={i} className={cn(
                            "text-[10px] font-bold px-2 py-0.5 rounded border",
                            isTl ? "bg-amber-500/10 border-amber-500/20 text-amber-300" : "bg-rose-500/10 border-rose-500/20 text-rose-300"
                          )}>
                            {label}
                          </span>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
