import React, { useState, useEffect, useMemo } from 'react';
import { trpc } from '../lib/trpc';
import { cn } from '../lib/utils';
import { Activity, ShieldAlert, Target, Zap, ArrowUp, ArrowDown, ChevronRight } from 'lucide-react';

interface OptionChainViewProps {
  defaultSymbol?: string;
  onSymbolSelect?: (symbol: string) => void;
}

const BUILDUP_META: Record<string, { color: string; icon: string }> = {
  'Long Build Up':   { color: 'text-emerald-400 bg-emerald-500/10', icon: '▲' },
  'Short Build Up':  { color: 'text-rose-400 bg-rose-500/10',       icon: '▼' },
  'Short Covering':  { color: 'text-sky-400 bg-sky-500/10',         icon: '↑' },
  'Put Long Covering': { color: 'text-sky-400 bg-sky-500/10',       icon: '↑' },
  'Call Long Covering': { color: 'text-sky-400 bg-sky-500/10',      icon: '↑' },
  'Long Unwinding':  { color: 'text-amber-400 bg-amber-500/10',     icon: '↓' },
};

export const OptionChainView: React.FC<OptionChainViewProps> = ({ defaultSymbol, onSymbolSelect }) => {
  const { data: symbolsData } = trpc.getFnoSymbols.useQuery();
  const fnoSymbols = useMemo(() => {
    if (!symbolsData) return [];
    return (symbolsData as any)?.resultData?.map((s: any) => s.symbol_name) || [];
  }, [symbolsData]);

  const [selectedSymbol, setSelectedSymbol] = useState(defaultSymbol || 'NIFTY');

  useEffect(() => {
    if (defaultSymbol && defaultSymbol !== selectedSymbol) {
      setSelectedSymbol(defaultSymbol);
    }
  }, [defaultSymbol]);

  const { data: chainData, isLoading } = trpc.getOptionChain.useQuery(
    { symbol: selectedSymbol.toLowerCase() },
    { refetchInterval: 30000, enabled: !!selectedSymbol }
  );

  const parsedData = useMemo(() => {
    if (!chainData) return null;
    return (chainData as any)?.data;
  }, [chainData]);

  // Derived metrics
  const opDatas = parsedData?.optionChain || [];
  
  const { maxCallOI, maxPutOI, totalPCR, atmStrike } = useMemo(() => {
    if (!opDatas.length) return { maxCallOI: 0, maxPutOI: 0, totalPCR: 1, atmStrike: 0 };
    let cMax = 0, pMax = 0, atm = opDatas[0]?.strikePrice;
    const spot = parsedData?.spotPrice || 0;
    let minDiff = Infinity;
    
    opDatas.forEach((row: any) => {
      if (row.callOi > cMax) cMax = row.callOi;
      if (row.putOi > pMax) pMax = row.putOi;
      const diff = Math.abs(row.strikePrice - spot);
      if (diff < minDiff) {
        minDiff = diff;
        atm = row.strikePrice;
      }
    });

    return { maxCallOI: cMax, maxPutOI: pMax, totalPCR: parsedData?.pcr || 1, atmStrike: atm };
  }, [opDatas, parsedData]);

  const formatNumber = (num: number) => {
    if (!num) return '0';
    if (num >= 10000000) return (num / 10000000).toFixed(2) + 'Cr';
    if (num >= 100000) return (num / 100000).toFixed(2) + 'L';
    return num.toLocaleString('en-IN');
  };

  return (
    <div className="flex flex-col h-full space-y-6 animate-in fade-in duration-500">
      
      {/* ── Header & Search ──────────────────────────────────────────────────────── */}
      <div className="flex flex-col md:flex-row justify-between items-center gap-4 bg-slate-900/40 p-4 rounded-xl border border-slate-800/50 backdrop-blur-sm">
        <div className="flex items-center gap-3">
          <Activity className="w-6 h-6 text-indigo-400" />
          <div>
            <h2 className="text-xl font-bold font-['Rajdhani'] text-slate-100 uppercase tracking-widest">Options Chain Intelligence</h2>
            <p className="text-[10px] text-slate-400 font-mono tracking-widest uppercase">Live Derivatives Data</p>
          </div>
        </div>

        <div className="flex gap-2">
          <select 
            value={selectedSymbol}
            onChange={(e) => {
              setSelectedSymbol(e.target.value);
              onSymbolSelect?.(e.target.value);
            }}
            className="bg-slate-950 border border-slate-800 text-slate-200 text-xs font-mono font-bold rounded-lg px-4 py-2 focus:ring-1 focus:ring-indigo-500 outline-none"
          >
            {fnoSymbols.map((sym: string) => (
              <option key={sym} value={sym}>{sym}</option>
            ))}
            {!fnoSymbols.includes(selectedSymbol) && <option value={selectedSymbol}>{selectedSymbol}</option>}
          </select>
        </div>
      </div>

      {isLoading ? (
        <div className="flex justify-center items-center h-64 text-indigo-500">
          <Activity className="w-8 h-8 animate-pulse" />
        </div>
      ) : !parsedData ? (
        <div className="text-center p-8 text-slate-500 font-mono text-xs">No Option Chain Data Available</div>
      ) : (
        <>
          {/* ── Sentiment & Levels ────────────────────────────────────────────────── */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
            
            {/* Spot & PCR Dial */}
            <div className="p-5 bg-slate-900/30 border border-slate-800/50 rounded-xl backdrop-blur-md relative overflow-hidden">
              <div className="absolute top-0 right-0 p-4 opacity-10"><Target className="w-16 h-16" /></div>
              <p className="text-[10px] font-black text-slate-500 uppercase tracking-widest mb-1">Underlying Spot</p>
              <p className="text-3xl font-black text-slate-100 font-mono tracking-tighter">
                ₹{parsedData?.spotPrice?.toLocaleString('en-IN', { minimumFractionDigits: 2 })}
              </p>
              
              <div className="mt-4 pt-4 border-t border-slate-800/50 flex justify-between items-center">
                <div>
                  <p className="text-[9px] font-bold text-slate-500 uppercase">ATM PCR</p>
                  <p className={cn(
                    "text-lg font-black font-mono",
                    totalPCR > 1 ? "text-emerald-400" : "text-rose-400"
                  )}>{totalPCR.toFixed(2)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-bold text-slate-500 uppercase">Status</p>
                  <p className={cn(
                    "text-[10px] font-bold uppercase tracking-wider px-2 py-1 rounded mt-1",
                    totalPCR > 1 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
                  )}>
                    {totalPCR > 1 ? 'Bullish' : 'Bearish'}
                  </p>
                </div>
              </div>
            </div>

            {/* Resistance Visualizer */}
            <div className="p-5 bg-slate-900/30 border border-rose-500/20 rounded-xl backdrop-blur-md">
              <div className="flex justify-between items-center mb-4">
                <p className="text-[10px] font-black text-rose-400 uppercase tracking-widest flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> Major Resistance
                </p>
                <span className="text-[9px] font-mono text-slate-500">CALL OI</span>
              </div>
              <div className="space-y-3">
                {opDatas.sort((a: any, b: any) => b.callOi - a.callOi).slice(0, 3).map((row: any, i: number) => (
                  <div key={row.strikePrice} className="relative">
                    <div className="flex justify-between text-xs font-mono mb-1 relative z-10">
                      <span className="text-slate-200">{row.strikePrice}</span>
                      <span className="text-rose-300">{formatNumber(row.callOi)}</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-rose-500/50 rounded-full" 
                        style={{ width: `${(row.callOi / maxCallOI) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Support Visualizer */}
            <div className="p-5 bg-slate-900/30 border border-emerald-500/20 rounded-xl backdrop-blur-md">
              <div className="flex justify-between items-center mb-4">
                <p className="text-[10px] font-black text-emerald-400 uppercase tracking-widest flex items-center gap-1">
                  <ShieldAlert className="w-3 h-3" /> Major Support
                </p>
                <span className="text-[9px] font-mono text-slate-500">PUT OI</span>
              </div>
              <div className="space-y-3">
                {opDatas.sort((a: any, b: any) => b.putOi - a.putOi).slice(0, 3).map((row: any, i: number) => (
                  <div key={row.strikePrice} className="relative">
                    <div className="flex justify-between text-xs font-mono mb-1 relative z-10">
                      <span className="text-slate-200">{row.strikePrice}</span>
                      <span className="text-emerald-300">{formatNumber(row.putOi)}</span>
                    </div>
                    <div className="h-1.5 bg-slate-800 rounded-full overflow-hidden">
                      <div 
                        className="h-full bg-emerald-500/50 rounded-full" 
                        style={{ width: `${(row.putOi / maxPutOI) * 100}%` }}
                      />
                    </div>
                  </div>
                ))}
              </div>
            </div>

          </div>

          {/* ── Option Chain Grid ─────────────────────────────────────────────────── */}
          <div className="bg-slate-900/40 border border-slate-800/50 rounded-xl backdrop-blur-md overflow-hidden">
            <div className="overflow-x-auto hide-scrollbar">
              <table className="w-full text-left border-collapse">
                <thead>
                  <tr>
                    <th colSpan={4} className="p-3 text-center bg-rose-950/20 border-b border-r border-slate-800/50 text-[10px] font-bold text-rose-400 uppercase tracking-widest">CALLS</th>
                    <th className="p-3 text-center bg-slate-900 border-b border-slate-800/50 text-[10px] font-bold text-slate-400 uppercase tracking-widest">STRIKE</th>
                    <th colSpan={4} className="p-3 text-center bg-emerald-950/20 border-b border-l border-slate-800/50 text-[10px] font-bold text-emerald-400 uppercase tracking-widest">PUTS</th>
                  </tr>
                  <tr className="bg-slate-900/80">
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-right font-medium">OI (L)</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-right font-medium">Chg OI</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-center font-medium">Build Up</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-right font-medium border-r border-slate-800/50">LTP</th>
                    
                    <th className="p-3 text-xs text-slate-200 font-black font-mono text-center border-x border-slate-800/50 bg-slate-800/20">PRICE</th>
                    
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-left font-medium border-l border-slate-800/50">LTP</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-center font-medium">Build Up</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-left font-medium">Chg OI</th>
                    <th className="p-3 text-[10px] text-slate-400 font-mono text-left font-medium">OI (L)</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-slate-800/30">
                  {[...opDatas].sort((a, b) => a.strikePrice - b.strikePrice).map((row: any) => {
                    const isATM = row.strikePrice === atmStrike;
                    const cMeta = BUILDUP_META[row.callBuiltup] || { color: 'text-slate-400', icon: '-' };
                    const pMeta = BUILDUP_META[row.putBuiltup] || { color: 'text-slate-400', icon: '-' };

                    return (
                      <tr key={row.strikePrice} className={cn(
                        "hover:bg-slate-800/40 transition-colors group",
                        isATM ? "bg-indigo-950/20 border-y border-indigo-500/30 shadow-[0_0_15px_rgba(99,102,241,0.1)]" : ""
                      )}>
                        {/* Calls */}
                        <td className="p-3 text-[11px] font-mono text-slate-300 text-right">{formatNumber(row.callOi)}</td>
                        <td className={cn("p-3 text-[11px] font-mono text-right", row.callOiChange > 0 ? "text-emerald-400" : "text-rose-400")}>
                          {row.callOiChange > 0 ? '+' : ''}{formatNumber(row.callOiChange)}
                        </td>
                        <td className="p-3 text-center">
                          <span className={cn("text-[9px] px-2 py-0.5 rounded font-bold uppercase", cMeta.color)}>
                            {row.callBuiltup || '-'}
                          </span>
                        </td>
                        <td className="p-3 text-[11px] font-mono text-right font-semibold border-r border-slate-800/50 text-slate-200">
                          {row.callLtp?.toFixed(2)}
                        </td>
                        
                        {/* Strike */}
                        <td className={cn(
                          "p-3 text-sm font-black font-mono text-center border-x border-slate-800/50",
                          isATM ? "text-indigo-400 bg-indigo-950/40" : "text-slate-200 bg-slate-900/30"
                        )}>
                          {row.strikePrice}
                          {isATM && <div className="text-[8px] font-sans uppercase tracking-widest text-indigo-300 mt-0.5">ATM</div>}
                        </td>
                        
                        {/* Puts */}
                        <td className="p-3 text-[11px] font-mono text-left font-semibold border-l border-slate-800/50 text-slate-200">
                          {row.putLtp?.toFixed(2)}
                        </td>
                        <td className="p-3 text-center">
                          <span className={cn("text-[9px] px-2 py-0.5 rounded font-bold uppercase", pMeta.color)}>
                            {row.putBuiltup || '-'}
                          </span>
                        </td>
                        <td className={cn("p-3 text-[11px] font-mono text-left", row.putOiChange > 0 ? "text-emerald-400" : "text-rose-400")}>
                          {row.putOiChange > 0 ? '+' : ''}{formatNumber(row.putOiChange)}
                        </td>
                        <td className="p-3 text-[11px] font-mono text-slate-300 text-left">{formatNumber(row.putOi)}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>
        </>
      )}
    </div>
  );
};
