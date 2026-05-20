import React, { useMemo } from 'react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { Layers, TrendingUp, TrendingDown, Activity, ShieldAlert, Crosshair } from 'lucide-react';

interface DerivativesIntelligenceWidgetProps {
  symbol?: string;
}

export const DerivativesIntelligenceWidget: React.FC<DerivativesIntelligenceWidgetProps> = ({ symbol = 'NIFTY 50' }) => {
  const fnoSymbol = symbol.toUpperCase() === 'NIFTY 50' ? 'NIFTY' : symbol;
  
  const { data: callData, isLoading: lCall } = trpc.getTrendlyneFnoScanners.useQuery({ mtype: 'options', screenType: 'oi-gainers-call', instType: 'index' });
  const { data: putData, isLoading: lPut } = trpc.getTrendlyneFnoScanners.useQuery({ mtype: 'options', screenType: 'oi-gainers-put', instType: 'index' });

  const { pcr, maxCallStrike, maxPutStrike, sentiment } = useMemo(() => {
    if (!callData || !putData) return { pcr: 0, maxCallStrike: 0, maxPutStrike: 0, sentiment: 'Neutral' };
    
    const callRows = callData.tableData?.filter((r: any[]) => r[0]?.name === fnoSymbol) || [];
    const putRows = putData.tableData?.filter((r: any[]) => r[0]?.name === fnoSymbol) || [];

    const getNum = (r: any[], idx: number) => typeof r[idx] === 'number' ? r[idx] : 0;
    
    const callOI = callRows.reduce((acc: number, r: any[]) => acc + getNum(r, 8), 0);
    const putOI = putRows.reduce((acc: number, r: any[]) => acc + getNum(r, 8), 0);
    
    const pcrVal = callOI > 0 ? putOI / callOI : 0;

    let maxCall = 0;
    let maxCallStrike = 0;
    callRows.forEach((r: any[]) => {
      const oi = getNum(r, 8);
      if (oi > maxCall) { maxCall = oi; maxCallStrike = getNum(r, 2); }
    });

    let maxPut = 0;
    let maxPutStrike = 0;
    putRows.forEach((r: any[]) => {
      const oi = getNum(r, 8);
      if (oi > maxPut) { maxPut = oi; maxPutStrike = getNum(r, 2); }
    });

    let sentimentStr = 'Neutral';
    if (pcrVal > 1.2) sentimentStr = 'Bullish';
    if (pcrVal > 1.5) sentimentStr = 'Very Bullish';
    if (pcrVal < 0.8) sentimentStr = 'Bearish';
    if (pcrVal < 0.5) sentimentStr = 'Very Bearish';

    return { pcr: pcrVal, maxCallStrike, maxPutStrike, sentiment: sentimentStr };
  }, [callData, putData, fnoSymbol]);

  if (lCall || lPut) {
    return (
      <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-xl p-6 h-64 flex flex-col items-center justify-center shadow-lg">
        <div className="w-8 h-8 border-4 border-indigo-500/30 border-t-indigo-500 rounded-full animate-spin" />
        <p className="mt-4 text-sm text-slate-400 font-medium animate-pulse">Analyzing Options Chain...</p>
      </div>
    );
  }

  return (
    <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800 rounded-xl p-6 shadow-lg h-full flex flex-col">
      <div className="flex items-center gap-2 mb-6">
        <Layers className="text-indigo-400 w-5 h-5" />
        <h2 className="text-xl font-bold text-slate-100">Derivatives Intelligence</h2>
        <span className="ml-auto px-2.5 py-1 bg-slate-800 rounded-md text-xs font-bold text-slate-300">
          {fnoSymbol}
        </span>
      </div>

      <div className="grid grid-cols-2 gap-4 flex-1">
        {/* PCR Box */}
        <div className="bg-slate-800/40 rounded-lg p-4 border border-slate-700/50 flex flex-col justify-center relative overflow-hidden group hover:border-indigo-500/30 transition-colors">
          <div className="absolute -right-4 -bottom-4 opacity-5 group-hover:opacity-10 transition-opacity">
            <Activity className="w-24 h-24" />
          </div>
          <p className="text-xs font-bold text-slate-400 uppercase tracking-wider mb-1">Put-Call Ratio</p>
          <div className="flex items-end gap-3">
            <span className={cn(
              "text-4xl font-black tabular-nums tracking-tighter",
              pcr > 1 ? "text-emerald-400" : pcr < 0.8 ? "text-rose-400" : "text-slate-200"
            )}>
              {pcr.toFixed(2)}
            </span>
          </div>
          <div className="mt-2 flex items-center gap-1.5">
            {pcr > 1 ? <TrendingUp className="w-4 h-4 text-emerald-500" /> : <TrendingDown className="w-4 h-4 text-rose-500" />}
            <span className={cn(
              "text-xs font-bold",
              pcr > 1 ? "text-emerald-500" : pcr < 0.8 ? "text-rose-500" : "text-slate-400"
            )}>{sentiment} Bias</span>
          </div>
        </div>

        {/* Support/Resistance */}
        <div className="space-y-4">
          <div className="bg-emerald-500/5 rounded-lg p-3 border border-emerald-500/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <ShieldAlert className="w-4 h-4 text-emerald-400" />
              <div>
                <p className="text-[10px] font-bold text-emerald-500 uppercase tracking-widest">Max Put OI</p>
                <p className="text-sm font-bold text-emerald-100">Support Level</p>
              </div>
            </div>
            <span className="text-lg font-black text-emerald-400 tabular-nums">
              {maxPutStrike > 0 ? maxPutStrike.toLocaleString('en-IN') : '—'}
            </span>
          </div>

          <div className="bg-rose-500/5 rounded-lg p-3 border border-rose-500/10 flex items-center justify-between">
            <div className="flex items-center gap-2">
              <Crosshair className="w-4 h-4 text-rose-400" />
              <div>
                <p className="text-[10px] font-bold text-rose-500 uppercase tracking-widest">Max Call OI</p>
                <p className="text-sm font-bold text-rose-100">Resistance Level</p>
              </div>
            </div>
            <span className="text-lg font-black text-rose-400 tabular-nums">
              {maxCallStrike > 0 ? maxCallStrike.toLocaleString('en-IN') : '—'}
            </span>
          </div>
        </div>
      </div>
      
      <div className="mt-6 pt-4 border-t border-slate-800/60">
        <p className="text-xs text-slate-400 leading-relaxed">
          {sentiment === 'Bullish' || sentiment === 'Very Bullish' 
            ? `Options data suggests strong put writing at lower levels, forming a solid base. The market is positioned for potential upside with support at ${maxPutStrike}.` 
            : sentiment === 'Bearish' || sentiment === 'Very Bearish'
            ? `Aggressive call writing indicates overhead supply. The market is facing heavy resistance near ${maxCallStrike}, suggesting a cautious approach.`
            : `Balanced OI distribution indicates a lack of clear directional conviction. The market is likely to consolidate between ${maxPutStrike} and ${maxCallStrike}.`}
        </p>
      </div>
    </div>
  );
};
