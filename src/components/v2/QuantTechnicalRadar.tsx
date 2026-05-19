import React, { useState } from 'react';
import { 
  TrendingUp, 
  TrendingDown, 
  Activity, 
  Sliders, 
  HelpCircle,
  Clock
} from 'lucide-react';
import { trpc } from '../../lib/trpc';

interface QuantTechnicalRadarProps {
  symbol: string;
}

type DurationType = 'D' | 'W' | 'M';

export const QuantTechnicalRadar: React.FC<QuantTechnicalRadarProps> = ({ symbol }) => {
  const [dur, setDur] = useState<DurationType>('D');

  // tRPC Queries
  const { data: liveQuote } = trpc.getLiveStockQuote.useQuery({ symbol }, { refetchInterval: 30000 });
  const { data: techData, isLoading } = trpc.getTechnicalDetails.useQuery(
    { symbol, dur },
    { enabled: !!symbol, refetchInterval: 60000 }
  );

  const price = liveQuote?.price || 0;
  const actualTech = techData?.data;

  // Extract Pivot Levels
  const pivotInfo = React.useMemo(() => {
    if (!actualTech || !actualTech.pivotLevels || actualTech.pivotLevels.length === 0) {
      return null;
    }
    
    // Classic/Standard pivot levels (usually first index)
    const level = actualTech.pivotLevels[0]?.pivotLevel;
    if (!level) return null;

    return {
      pivotPoint: parseFloat(level.pivotPoint),
      s1: parseFloat(level.s1),
      s2: parseFloat(level.s2),
      s3: parseFloat(level.s3),
      r1: parseFloat(level.r1),
      r2: parseFloat(level.r2),
      r3: parseFloat(level.r3),
      type: actualTech.pivotLevels[0]?.key || 'Classic'
    };
  }, [actualTech]);

  // Extract RSI and MACD
  const momentumStats = React.useMemo(() => {
    if (!actualTech || !actualTech.indicators) {
      return { rsi: null, rsiIndication: 'N/A', macd: null, macdIndication: 'N/A' };
    }
    
    const findInd = (id: string) => actualTech.indicators.find((i: any) => i.id?.toLowerCase().includes(id) || i.displayName?.toLowerCase().includes(id));
    const rsiObj = findInd('rsi');
    const macdObj = findInd('macd');

    return {
      rsi: rsiObj ? parseFloat(rsiObj.value) : null,
      rsiIndication: rsiObj?.indication || 'Neutral',
      macd: macdObj ? parseFloat(macdObj.value) : null,
      macdIndication: macdObj?.indication || 'Neutral'
    };
  }, [actualTech]);

  // MA Sentiments
  const maSentiments = React.useMemo(() => {
    if (!actualTech || !actualTech.sentiments) {
      return { bullish: 0, bearish: 0, neutral: 0, overall: 'NEUTRAL' };
    }
    const sent = actualTech.sentiments;
    return {
      bullish: sent.totalBullish || 0,
      bearish: sent.totalBearish || 0,
      neutral: sent.totalNeutral || 0,
      overall: sent.indication || 'NEUTRAL'
    };
  }, [actualTech]);

  // Calculate Pivot Slider thumb percentage
  const pivotPercentage = React.useMemo(() => {
    if (!pivotInfo || price === 0) return 50;
    const min = pivotInfo.s3;
    const max = pivotInfo.r3;
    if (min === max) return 50;

    const pct = ((price - min) / (max - min)) * 100;
    return Math.min(100, Math.max(0, pct));
  }, [pivotInfo, price]);

  const overallBullish = maSentiments.overall.toUpperCase().includes('BULLISH');
  const overallBearish = maSentiments.overall.toUpperCase().includes('BEARISH');

  return (
    <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
      <div className="absolute top-0 right-0 w-[300px] h-[150px] bg-cyan-500/5 rounded-full blur-[60px] pointer-events-none" />
      
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 border-b border-white/[0.04] pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 shadow-md">
            <Activity className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Technical Radar</h3>
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Pivots, Moving Averages & Momentum Scans</p>
          </div>
        </div>

        {/* Timeframe selector */}
        <div className="flex bg-slate-950/60 p-0.5 border border-white/[0.04] rounded-lg gap-0.5">
          {['D', 'W', 'M'].map((d) => (
            <button
              key={d}
              onClick={() => setDur(d as DurationType)}
              className={`px-2.5 py-1 rounded text-[9px] font-black transition-all ${
                dur === d
                  ? 'bg-cyan-600 text-white shadow-sm'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {d === 'D' ? 'DAILY' : d === 'W' ? 'WEEKLY' : 'MONTHLY'}
            </button>
          ))}
        </div>
      </div>

      {isLoading ? (
        <div className="py-12 flex flex-col items-center justify-center">
          <div className="w-7 h-7 border-t-2 border-cyan-500 border-r-2 border-r-cyan-500/20 rounded-full animate-spin mb-3" />
          <p className="text-[10px] font-bold text-slate-500 tracking-widest uppercase animate-pulse">Syncing technical models...</p>
        </div>
      ) : (
        <div className="space-y-6">
          {/* Pivot points slider */}
          {pivotInfo ? (
            <div className="space-y-4">
              <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-400 tracking-wider">
                <span>Pivot Channel ({pivotInfo.type})</span>
                <span className="text-white tabular-nums">Current: ₹{price.toLocaleString()}</span>
              </div>

              <div className="relative pt-2 pb-1">
                {/* Horizontal scale */}
                <div className="h-1.5 bg-slate-950 border border-white/[0.04] rounded-full relative">
                  {/* Tick markers */}
                  <div className="absolute left-0 -top-1 w-0.5 h-3.5 bg-rose-500" title={`S3: ₹${pivotInfo.s3}`} />
                  <div className="absolute left-[16.6%] -top-1 w-0.5 h-3.5 bg-rose-400/60" title={`S2: ₹${pivotInfo.s2}`} />
                  <div className="absolute left-[33.3%] -top-1 w-0.5 h-3.5 bg-rose-300/40" title={`S1: ₹${pivotInfo.s1}`} />
                  <div className="absolute left-1/2 -top-1 w-0.5 h-3.5 bg-cyan-400" title={`PP: ₹${pivotInfo.pivotPoint}`} />
                  <div className="absolute left-[66.6%] -top-1 w-0.5 h-3.5 bg-emerald-300/40" title={`R1: ₹${pivotInfo.r1}`} />
                  <div className="absolute left-[83.3%] -top-1 w-0.5 h-3.5 bg-emerald-400/60" title={`R2: ₹${pivotInfo.r2}`} />
                  <div className="absolute left-full -top-1 w-0.5 h-3.5 bg-emerald-500" title={`R3: ₹${pivotInfo.r3}`} />
                </div>

                {/* Live price pointer */}
                <div 
                  className="absolute top-0 w-3 h-3 bg-cyan-400 border border-slate-950 rounded-full shadow-[0_0_8px_rgba(34,211,238,0.8)] transform -translate-x-1/2 transition-all duration-700"
                  style={{ left: `${pivotPercentage}%` }}
                />
              </div>

              {/* Labels grid */}
              <div className="grid grid-cols-7 text-[8px] font-black text-slate-500 uppercase tracking-widest text-center mt-1">
                <span className="text-rose-500">S3<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.s3)}</span></span>
                <span>S2<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.s2)}</span></span>
                <span>S1<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.s1)}</span></span>
                <span className="text-cyan-400">PP<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.pivotPoint)}</span></span>
                <span>R1<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.r1)}</span></span>
                <span>R2<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.r2)}</span></span>
                <span className="text-emerald-500">R3<span className="block text-[7px] text-slate-600 mt-0.5">₹{Math.round(pivotInfo.r3)}</span></span>
              </div>
            </div>
          ) : (
            <div className="text-center py-4 text-[9px] font-black text-slate-500 uppercase">
              Pivot levels offline
            </div>
          )}

          {/* Indicators grid */}
          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 border-t border-white/[0.04] pt-4">
            
            {/* Momentum (RSI) */}
            <div className="bg-slate-950/40 border border-white/[0.03] rounded-2xl p-4 space-y-3">
              <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-400 tracking-wider">
                <span>Momentum (RSI 14)</span>
                <span className={
                  momentumStats.rsi && momentumStats.rsi >= 70 ? 'text-rose-400' :
                  momentumStats.rsi && momentumStats.rsi <= 30 ? 'text-emerald-400' : 'text-slate-300'
                }>
                  {momentumStats.rsi ? momentumStats.rsi.toFixed(1) : 'N/A'}
                </span>
              </div>

              {momentumStats.rsi !== null ? (
                <div className="space-y-2">
                  <div className="h-1.5 bg-slate-900 border border-white/[0.03] rounded-full overflow-hidden flex">
                    <div className="w-[30%] bg-emerald-500/20" /> {/* Oversold */}
                    <div className="w-[40%] bg-slate-800" />       {/* Neutral */}
                    <div className="w-[30%] bg-rose-500/20" />    {/* Overbought */}
                  </div>
                  
                  {/* Thumb indicator on RSI */}
                  <div className="relative h-1">
                    <div 
                      className={`absolute -top-3.5 w-2 h-2 rounded-full border border-slate-950 transform -translate-x-1/2 transition-all duration-700 ${
                        momentumStats.rsi >= 70 ? 'bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.6)]' :
                        momentumStats.rsi <= 30 ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : 'bg-cyan-400'
                      }`}
                      style={{ left: `${momentumStats.rsi}%` }}
                    />
                  </div>

                  <div className="flex justify-between text-[8px] font-black text-slate-600 uppercase tracking-widest pt-1">
                    <span>Oversold</span>
                    <span>Neutral</span>
                    <span>Overbought</span>
                  </div>
                </div>
              ) : (
                <div className="text-center py-2 text-[9px] text-slate-600 uppercase">
                  RSI scanning offline
                </div>
              )}
            </div>

            {/* Moving Average Sentiments */}
            <div className="bg-slate-950/40 border border-white/[0.03] rounded-2xl p-4 flex flex-col justify-between space-y-2">
              <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-400 tracking-wider">
                <span>Moving Averages (MA)</span>
                <span className={`px-2 py-0.5 rounded text-[8px] font-black ${
                  overallBullish ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/20 glow-up' :
                  overallBearish ? 'text-rose-400 bg-rose-500/10 border border-rose-500/20 glow-down' : 'text-slate-400 bg-slate-500/10 border border-slate-500/20'
                }`}>
                  {maSentiments.overall}
                </span>
              </div>

              <div className="grid grid-cols-3 gap-2 text-center pt-1.5">
                <div className="bg-emerald-500/5 border border-emerald-500/10 rounded-xl p-1.5">
                  <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">Bullish</span>
                  <span className="text-xs font-black text-emerald-400 tabular-nums">{maSentiments.bullish}</span>
                </div>
                <div className="bg-rose-500/5 border border-rose-500/10 rounded-xl p-1.5">
                  <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">Bearish</span>
                  <span className="text-xs font-black text-rose-400 tabular-nums">{maSentiments.bearish}</span>
                </div>
                <div className="bg-slate-500/5 border border-slate-500/10 rounded-xl p-1.5">
                  <span className="text-[7px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">Neutral</span>
                  <span className="text-xs font-black text-slate-400 tabular-nums">{maSentiments.neutral}</span>
                </div>
              </div>
            </div>

          </div>
        </div>
      )}
    </div>
  );
};
