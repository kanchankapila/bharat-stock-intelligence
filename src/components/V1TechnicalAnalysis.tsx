import React, { useState } from 'react';
import { motion } from 'motion/react';
import { Zap, Activity, Info, TrendingUp, TrendingDown, Filter } from 'lucide-react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import { detectCandlestickPatterns, Candlestick } from '../lib/candlestickUtils';
import { Card } from './Card';

// Extracted from App.tsx (2026-08-02 perf pass) so it's lazy-loaded instead of always
// bundled into the main entry chunk -- this tab only mounts when a user opens a stock's
// Technicals tab.
export const V1TechnicalAnalysis: React.FC<{ symbol: string }> = ({ symbol }) => {
  const [timeframe, setTimeframe] = useState<'D' | 'W' | 'M'>('D');
  const [maType, setMaType] = useState<'SMA' | 'EMA'>('SMA');
  const { data: tech, isLoading } = trpc.getTechnicalDetails.useQuery({ symbol, dur: timeframe });
  const { data: technicalScan, isLoading: scanLoading } = trpc.getTechnicalScan.useQuery({ symbol });
  const { data: ohlcData, isLoading: ohlcLoading } = trpc.getOHLCData.useQuery({ symbol, dur: '1y' });
  const { data: tvTa } = trpc.getTvTa.useQuery({ symbol });

  if (isLoading || scanLoading || ohlcLoading) return <div className="p-20 text-center animate-pulse text-slate-400">Processing signals...</div>;

  const indicators = tech?.data?.indicators?.map((i: any) => ({ name: i.displayName, value: i.value, sentiment: i.indication })) || [];
  const movingAverages = tech?.data?.[maType.toLowerCase()]?.map((i: any) => ({ name: `${maType} ${i.key}`, value: i.value, sentiment: i.indication })) || [];
  const crossovers = tech?.data?.crossover || [];
  const macdData = indicators.find((i: any) => i.name.includes('MACD')) || { value: 'N/A', sentiment: 'Neutral' };

  // Map OHLC to Candlestick format for detection
  const candles: Candlestick[] = ohlcData?.data?.map((d: any) => ({
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
    timestamp: d.time
  })) || [];

  const detectedPatterns = detectCandlestickPatterns(candles);

  return (
    <div className="space-y-6">
      {/* Timeframe Selector */}
      <div className="flex justify-end gap-2 mb-4">
        {[
          { id: 'D', label: 'Daily' },
          { id: 'W', label: 'Weekly' },
          { id: 'M', label: 'Monthly' }
        ].map(tf => (
          <button
            key={tf.id}
            onClick={() => setTimeframe(tf.id as any)}
            className={cn(
              "px-4 py-1.5 rounded-lg text-[10px] font-black font-display uppercase tracking-widest transition-all border",
              timeframe === tf.id ? "bg-blue-600 border-blue-600 text-white shadow-lg" : "glass-strong border-slate-800/50 text-slate-400 hover:text-white"
            )}
          >
            {tf.label}
          </button>
        ))}
      </div>

      {tvTa && tvTa.summary && (
        <Card title="TradingView Advanced TA" icon={Zap}>
          <div className="grid grid-cols-3 gap-4 text-center mb-6">
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-2">Oscillators</p>
              <p className={cn("text-xl font-black italic tracking-tighter uppercase",
                tvTa.oscillators?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.oscillators?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.oscillators?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-2">Summary</p>
              <p className={cn("text-2xl font-black italic tracking-tighter uppercase",
                tvTa.summary?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.summary?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.summary?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
            <div className="p-4 glass-strong rounded-2xl border border-slate-800/50">
              <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-2">Moving Averages</p>
              <p className={cn("text-xl font-black italic tracking-tighter uppercase",
                tvTa.moving_averages?.RECOMMENDATION?.includes('BUY') ? 'text-emerald-500' :
                tvTa.moving_averages?.RECOMMENDATION?.includes('SELL') ? 'text-rose-500' : 'text-amber-500'
              )}>{tvTa.moving_averages?.RECOMMENDATION || 'NEUTRAL'}</p>
            </div>
          </div>
        </Card>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card title="Momentum Indicators" icon={Activity}>
           <div className="space-y-4">
              {indicators.map((ind: any) => (
                <div key={ind.name} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30">
                  <div>
                    <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest">{ind.name}</p>
                    {Array.isArray(ind.value) ? (
                      <p className="text-xs font-bold text-slate-400 mt-0.5">Multiple Bands</p>
                    ) : (
                      <p className="text-xs font-bold text-white mt-0.5">{ind.value}</p>
                    )}
                  </div>
                  <span className={cn(
                    "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter whitespace-nowrap",
                    ind.sentiment.includes('Bullish') ? "bg-emerald-500/10 text-emerald-500" :
                    ind.sentiment.includes('Bearish') ? "bg-rose-500/10 text-rose-500" :
                    ind.sentiment.includes('Overbought') || ind.sentiment.includes('High') ? "bg-purple-500/10 text-purple-400" :
                    ind.sentiment.includes('Oversold') ? "bg-amber-500/10 text-amber-500" : "bg-slate-800 text-slate-400"
                  )}>
                    {ind.sentiment}
                  </span>
                </div>
              ))}
           </div>
        </Card>

        <div className="space-y-6">
          <Card title="MACD Analysis" icon={Zap}>
             <div className="space-y-5">
                <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
                   <div className="flex justify-between items-end mb-4">
                      <div>
                         <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">Momentum Oscillator</p>
                         <h4 className="text-xl font-black text-white italic tracking-tighter">MACD Line</h4>
                      </div>
                      <span className={cn(
                         "text-[10px] font-black px-3 py-1 rounded uppercase italic tracking-tighter",
                         macdData.sentiment === 'Bullish' ? "bg-emerald-500/20 text-emerald-500 border border-emerald-500/30" : "bg-rose-500/20 text-rose-500 border border-rose-500/30"
                      )}>
                         {macdData.sentiment}
                      </span>
                   </div>

                   <div className="space-y-3">
                      <div className="flex justify-between text-[11px] font-bold">
                         <span className="text-slate-400">Current Value:</span>
                         <span className="text-white">{macdData.value}</span>
                      </div>
                      <div className="flex justify-between text-[11px] font-bold">
                         <span className="text-slate-400">Signal Crossover:</span>
                         <span className={macdData.sentiment === 'Bullish' ? "text-emerald-400" : "text-rose-400"}>
                            {macdData.sentiment === 'Bullish' ? 'Bullish Crossover' : 'Bearish Crossover'}
                         </span>
                      </div>
                   </div>

                   <div className="mt-5 pt-5 border-t border-slate-900">
                      <div className="flex items-start gap-3">
                         <Info className="w-4 h-4 text-blue-500 mt-0.5 shrink-0" />
                         <p className="text-[11px] text-slate-400 leading-relaxed italic">
                            MACD is a trend-following momentum indicator. A <span className="text-slate-200 font-bold">Bullish Crossover</span> occurs when the MACD line passes above the signal line.
                         </p>
                      </div>
                   </div>
                </div>

                <div className="space-y-3">
                   <h5 className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest pl-1">Scanner Insights</h5>
                   {technicalScan?.signals?.filter((s: any) => s.type === 'MACD').map((signal: any, idx: number) => (
                      <div key={idx} className="p-3 bg-blue-500/5 border border-blue-500/10 rounded-xl">
                         <p className="text-[10px] font-black text-blue-400 font-display uppercase tracking-widest mb-1">{signal.label}</p>
                         <p className="text-[11px] text-slate-400 leading-relaxed italic">{signal.description}</p>
                      </div>
                   ))}
                </div>
             </div>
          </Card>

          <Card title="Moving Average Crossovers" icon={Activity}>
             <div className="space-y-4">
                {crossovers.map((cross: any) => (
                   <div key={cross.key} className="p-4 glass-strong border border-slate-800/50 rounded-2xl flex items-center justify-between">
                      <div>
                         <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">{cross.period}</p>
                         <p className="text-sm font-bold text-white leading-tight">{cross.displayValue}</p>
                      </div>
                      <span className={cn(
                         "text-[9px] font-black px-2 py-1 rounded uppercase tracking-tighter whitespace-nowrap",
                         cross.indication === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" :
                         cross.indication === 'Bearish' ? "bg-rose-500/10 text-rose-500" : "bg-slate-800 text-slate-400"
                      )}>
                         {cross.indication}
                      </span>
                   </div>
                ))}
             </div>
          </Card>
        </div>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
        <Card
          title="Moving Averages"
          icon={TrendingUp}
          action={
            <div className="flex glass rounded-lg p-0.5 border border-slate-800/50">
              <button
                onClick={() => setMaType('SMA')}
                className={cn("px-3 py-1 rounded-md text-[9px] font-black font-display uppercase tracking-widest transition-all", maType === 'SMA' ? "bg-slate-800 text-white" : "text-slate-400")}
              >
                SMA
              </button>
              <button
                onClick={() => setMaType('EMA')}
                className={cn("px-3 py-1 rounded-md text-[9px] font-black font-display uppercase tracking-widest transition-all", maType === 'EMA' ? "bg-slate-800 text-white" : "text-slate-400")}
              >
                EMA
              </button>
            </div>
          }
        >
           <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              {movingAverages.map((ma: any) => (
                 <div key={ma.name} className="flex justify-between items-center p-3 glass-strong rounded-xl border border-slate-800/30">
                    <div>
                      <p className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest">{ma.name}</p>
                      <p className="text-xs font-bold text-white mt-0.5">₹{ma.value}</p>
                    </div>
                    <span className={cn(
                      "text-[9px] font-black px-2 py-0.5 rounded uppercase tracking-tighter",
                      ma.sentiment === 'Bullish' ? "bg-emerald-500/10 text-emerald-500" : "bg-rose-500/10 text-rose-500"
                    )}>
                      {ma.sentiment}
                    </span>
                 </div>
              ))}
           </div>
        </Card>

        <Card title="Live Technical Scanner" icon={Zap}>
           <div className="space-y-4">
              {/* Custom patterns detected from chart data */}
              {detectedPatterns.length > 0 && (
                <div className="space-y-3">
                  <h5 className="text-[10px] font-black text-slate-400 font-display uppercase tracking-widest pl-1">Chart Patterns Identified</h5>
                  {detectedPatterns.map((pattern, idx) => (
                    <div key={idx} className={cn(
                      "p-4 glass-strong border rounded-2xl relative overflow-hidden",
                      pattern.sentiment === 'bullish' ? 'border-emerald-500/20' : pattern.sentiment === 'bearish' ? 'border-rose-500/20' : 'border-slate-800/50'
                    )}>
                      <div className="absolute top-0 right-0 p-2 opacity-10">
                        {pattern.sentiment === 'bullish' ? <TrendingUp className="text-emerald-500 w-12 h-12" /> : <TrendingDown className="text-rose-500 w-12 h-12" />}
                      </div>
                      <div className="relative z-10">
                        <div className="flex items-center gap-2 mb-2">
                           <Zap className={cn("w-3 h-3", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')} />
                           <span className={cn("text-[9px] font-black uppercase tracking-[0.2em]", pattern.sentiment === 'bullish' ? 'text-emerald-400' : 'text-rose-400')}>
                             {pattern.sentiment} SIGNAL (Confidence: {pattern.confidence})
                           </span>
                        </div>
                        <h4 className="text-lg font-black text-white italic tracking-tighter mb-1 uppercase">
                           {pattern.name} Identified
                        </h4>
                        <p className="text-[11px] text-slate-400 leading-relaxed italic font-medium">
                           {pattern.description}
                        </p>
                      </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="p-4 glass-strong border border-emerald-500/20 rounded-2xl relative overflow-hidden">
                 <div className="absolute top-0 right-0 p-2 opacity-10">
                    <Activity className="w-12 h-12 text-emerald-500" />
                 </div>
                 <div className="relative z-10">
                    <div className="flex items-center gap-2 mb-3">
                       <Zap className="w-4 h-4 text-emerald-400" />
                       <span className="text-[10px] font-black text-emerald-400 uppercase tracking-[0.2em]">Real-time Analysis</span>
                    </div>
                    <h4 className="text-lg font-black text-white italic tracking-tighter mb-2">
                       {technicalScan?.candlestickAnalysis?.pattern}
                    </h4>
                    <p className="text-xs text-slate-400 leading-relaxed italic font-medium">
                       {technicalScan?.candlestickAnalysis?.explanation}
                    </p>
                 </div>
              </div>

              <div className="p-4 glass-strong border border-slate-800/50 rounded-2xl">
                 <div className="flex justify-between items-center mb-1">
                    <span className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest">Volatility Status</span>
                    <span className="text-[10px] font-black text-white uppercase">{technicalScan?.volatility?.label}</span>
                 </div>
                 <div className="h-1 bg-slate-800 rounded-full overflow-hidden">
                    <motion.div
                       initial={{ width: 0 }}
                       animate={{ width: `${technicalScan?.volatility?.score}%` }}
                       className="h-full bg-blue-500"
                    />
                 </div>
                 <p className="text-[9px] text-slate-400 mt-2 italic uppercase tracking-tighter">{technicalScan?.volatility?.description}</p>
              </div>
           </div>
        </Card>
      </div>

      <Card title="Pivot Levels (Standard)" icon={Filter}>
         <div className="grid grid-cols-2 md:grid-cols-5 gap-4">
            {[
              { label: 'R2', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.r2 || '---' },
              { label: 'R1', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.r1 || '---' },
              { label: 'Pivot', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.pivotPoint || '---' },
              { label: 'S1', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.s1 || '---' },
              { label: 'S2', val: (tech as any)?.data?.pivotLevels?.find((p: any) => p.key === 'Classic')?.pivotLevel?.s2 || '---' },
            ].map(p => {
              const displayVal = typeof p.val === 'number' ? `₹${p.val.toFixed(2)}` : p.val;
              return (
                <div key={p.label} className="p-4 glass-strong rounded-2xl border border-slate-800/50 text-center">
                   <p className="text-[9px] font-black text-slate-400 font-display uppercase tracking-widest mb-1">{p.label}</p>
                   <p className="text-sm font-black text-white italic">{displayVal}</p>
                </div>
              );
            })}
         </div>
      </Card>
    </div>
  );
};

export default V1TechnicalAnalysis;
