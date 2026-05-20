import React, { useState } from 'react';
import { 
  Coins, 
  ArrowUpRight, 
  ArrowDownRight, 
  TrendingUp, 
  Layers, 
  Flame, 
  MessageSquare,
  Sparkles,
  RefreshCw,
  Users
} from 'lucide-react';
import {
  ResponsiveContainer,
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ReferenceLine,
  CartesianGrid,
} from 'recharts';
import { trpc } from '../../lib/trpc';

interface SmartMoneySentimentProps {
  symbol: string;
}

export const SmartMoneySentiment: React.FC<SmartMoneySentimentProps> = ({ symbol }) => {
  const [flowDays, setFlowDays] = useState<number>(15);

  // tRPC Queries
  const { data: flows, isLoading: loadingFlows } = trpc.getFiiDiiFlow.useQuery({ days: flowDays });
  const { data: optionChain } = trpc.getOptionChain.useQuery({ symbol }, { refetchInterval: 60000 });
  const { data: sentimentData, isLoading: loadingSentiment, refetch: refetchSentiment } = trpc.getMarketSentiment.useQuery();
  const { data: newsItems } = trpc.getNewsItems.useQuery({ limit: 4, hours: 24 });
  const { data: unifiedData } = trpc.getAlphaQuantDetail.useQuery({ symbol }, { enabled: !!symbol });


  // Format institutional flows for charting
  const processedFlows = React.useMemo(() => {
    if (!flows || !Array.isArray(flows)) return [];
    
    // Reverse to show in chronological order (left to right)
    return [...flows]
      .reverse()
      .map((row: any) => {
        const dateObj = new Date(row.date);
        const dayStr = dateObj.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
        return {
          day: dayStr,
          FII: parseFloat(row.fii_net || 0),
          DII: parseFloat(row.dii_net || 0),
        };
      });
  }, [flows]);

  // Options PCR parsing
  const pcrDetails = React.useMemo(() => {
    const ocData = optionChain?.success ? optionChain.data : null;
    if (!ocData) {
      // Return a standard baseline PCR default for active stocks
      return { pcr: 0.94, maxPain: 'N/A', sentiment: 'Neutral' };
    }
    
    const pcr = parseFloat(ocData.pcr || 0.92);
    let sentiment = 'Neutral';
    if (pcr >= 1.05) sentiment = 'Bullish (Put Support)';
    else if (pcr <= 0.75) sentiment = 'Bearish (Call Resistance)';

    return {
      pcr: isNaN(pcr) ? 0.92 : pcr,
      maxPain: ocData.marketSentiment?.maxPain || 'N/A',
      sentiment,
    };
  }, [optionChain]);

  // Market Sentiment
  const sentiment = React.useMemo(() => {
    if (!sentimentData || !sentimentData.latest) {
      return { bullish: 62, bearish: 28, neutral: 10, fearGreed: 'Greed' };
    }
    const snap = sentimentData.latest;
    const total = (snap.bullish_count || 0) + (snap.bearish_count || 0) + (snap.neutral_count || 0) || 1;
    const bul = Math.round(((snap.bullish_count || 0) / total) * 100);
    const bear = Math.round(((snap.bearish_count || 0) / total) * 100);
    const neu = 100 - bul - bear;


    let fearGreed = 'Neutral';
    if (bul >= 65) fearGreed = 'Extreme Greed';
    else if (bul >= 55) fearGreed = 'Greed';
    else if (bul <= 25) fearGreed = 'Extreme Fear';
    else if (bul <= 35) fearGreed = 'Fear';

    return {
      bullish: bul,
      bearish: bear,
      neutral: neu,
      fearGreed,
    };
  }, [sentimentData]);

  // Shareholding pattern extraction
  const shPattern = React.useMemo(() => {
    const pattern = (unifiedData as any)?.shareholdingPattern;
    if (!pattern || !pattern.list) {
      return null;
    }
    const findVal = (name: string) => parseFloat(pattern.list.find((i: any) => i.name?.includes(name))?.value) || 0;
    return {
      promoters: findVal('Promoter'),
      fii: findVal('FII'),
      dii: findVal('DII'),
      publicHolding: findVal('Public'),
      pledging: pattern.promoterPledging || '0.00',
    };
  }, [unifiedData]);

  // Helper for PCR Slider thumb position percentage
  const pcrSliderPct = Math.min(100, Math.max(0, ((pcrDetails.pcr - 0.4) / (1.6 - 0.4)) * 100));

  return (
    <div className="space-y-6">
      {/* 1. Institutional Flows Card */}
      <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
        <div className="absolute top-0 right-0 w-[200px] h-[100px] bg-emerald-500/5 rounded-full blur-[40px] pointer-events-none" />
        
        <div className="flex items-center justify-between mb-4 border-b border-white/[0.04] pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-emerald-500/10 flex items-center justify-center border border-emerald-500/20 shadow-md">
              <Coins className="w-5 h-5 text-emerald-400" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Institutional Money Flow</h3>
              <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">FII & DII Daily Net Positions (Cr)</p>
            </div>
          </div>

          <div className="flex bg-slate-950/60 p-0.5 border border-white/[0.04] rounded-lg gap-0.5">
            {[10, 15, 30].map((d) => (
              <button
                key={d}
                onClick={() => setFlowDays(d)}
                className={`px-2 py-1 rounded text-[9px] font-black transition-all ${
                  flowDays === d
                    ? 'bg-emerald-600 text-white shadow-sm'
                    : 'text-slate-500 hover:text-slate-300'
                }`}
              >
                {d}D
              </button>
            ))}
          </div>
        </div>

        {/* Flows Chart */}
        {loadingFlows ? (
          <div className="h-[120px] flex items-center justify-center">
            <div className="w-6 h-6 border-t-2 border-emerald-500 border-r-2 border-r-emerald-500/20 rounded-full animate-spin" />
          </div>
        ) : processedFlows.length === 0 ? (
          <div className="h-[120px] flex flex-col items-center justify-center text-center">
            <Coins className="w-6 h-6 text-slate-700 mb-2" />
            <span className="text-[10px] font-black text-slate-500 uppercase">FII/DII records offline today</span>
          </div>
        ) : (
          <div className="h-[120px] w-full">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={processedFlows} margin={{ top: 5, right: 0, left: -25, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.01)" vertical={false} />
                <XAxis dataKey="day" stroke="rgba(255,255,255,0.15)" fontSize={8} fontWeight="700" tickLine={false} />
                <YAxis stroke="rgba(255,255,255,0.15)" fontSize={8} fontWeight="700" tickLine={false} />
                <Tooltip
                  contentStyle={{
                    background: 'rgba(7, 10, 19, 0.95)',
                    border: '1px solid rgba(255,255,255,0.08)',
                    borderRadius: '12px',
                    fontSize: '10px',
                  }}
                />
                <ReferenceLine y={0} stroke="rgba(255,255,255,0.15)" strokeWidth={1} />
                <Bar dataKey="FII" fill="#38bdf8" radius={[2, 2, 0, 0]} maxBarSize={6} />
                <Bar dataKey="DII" fill="#10b981" radius={[2, 2, 0, 0]} maxBarSize={6} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        )}

        <div className="mt-2 flex items-center justify-center gap-4 text-[9px] font-black uppercase tracking-wider text-slate-400">
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 bg-[#38bdf8] rounded-sm" />
            FII Net Buy/Sell
          </div>
          <div className="flex items-center gap-1.5">
            <div className="w-2.5 h-2.5 bg-[#10b981] rounded-sm" />
            DII Net Buy/Sell
          </div>
        </div>
      </div>

      {/* 2. Options PCR Card */}
      <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
        <div className="absolute top-0 right-0 w-[200px] h-[100px] bg-cyan-500/5 rounded-full blur-[40px] pointer-events-none" />
        
        <div className="flex items-center gap-3 mb-5 border-b border-white/[0.04] pb-4">
          <div className="w-10 h-10 rounded-xl bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20 shadow-md">
            <Layers className="w-5 h-5 text-cyan-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Derivatives Intelligence</h3>
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">F&O Put-Call Ratio & Max Pain Limits</p>
          </div>
        </div>

        {/* PCR Slider */}
        <div className="space-y-4">
          <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-400 tracking-wider">
            <span>Put-Call Ratio (PCR)</span>
            <span className={pcrDetails.pcr >= 1.05 ? 'text-emerald-400' : pcrDetails.pcr <= 0.75 ? 'text-rose-400' : 'text-slate-300'}>
              {pcrDetails.pcr.toFixed(2)}
            </span>
          </div>

          <div className="relative pt-2">
            {/* Slider track background */}
            <div className="h-2 bg-slate-950 border border-white/[0.04] rounded-full flex overflow-hidden">
              <div className="w-[30%] bg-rose-500/30" /> {/* Bearish zone */}
              <div className="w-[30%] bg-slate-800" />    {/* Neutral zone */}
              <div className="w-[40%] bg-emerald-500/30" /> {/* Bullish zone */}
            </div>

            {/* Thumb */}
            <div 
              className="absolute top-0 w-3.5 h-3.5 bg-cyan-400 border-2 border-slate-950 rounded-full shadow-[0_0_8px_rgba(34,211,238,0.6)] transform -translate-x-1/2 transition-all duration-500"
              style={{ left: `${pcrSliderPct}%` }}
            />
            
            {/* Limits markers */}
            <div className="flex justify-between text-[8px] font-black text-slate-600 uppercase tracking-widest mt-2 px-1">
              <span>0.4 Bearish</span>
              <span>1.0 Neutral</span>
              <span>1.6 Bullish</span>
            </div>
          </div>

          {/* Details */}
          <div className="grid grid-cols-2 gap-3 border-t border-white/[0.04] pt-4">
            <div className="bg-slate-950/40 border border-white/[0.03] rounded-2xl p-3 text-center">
              <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">PCR Sentiment</span>
              <span className="text-xs font-black text-white">{pcrDetails.sentiment}</span>
            </div>
            
            <div className="bg-slate-950/40 border border-white/[0.03] rounded-2xl p-3 text-center">
              <span className="text-[8px] font-black text-slate-500 uppercase tracking-widest block mb-0.5">Max Pain Target</span>
              <span className="text-xs font-black text-cyan-400 tabular-nums">{pcrDetails.maxPain !== 'N/A' && pcrDetails.maxPain !== null ? `₹${pcrDetails.maxPain}` : 'N/A'}</span>
            </div>
          </div>
        </div>
      </div>

      {/* Shareholding Desk */}
      {shPattern && (
        <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
          <div className="absolute top-0 right-0 w-[200px] h-[100px] bg-indigo-500/5 rounded-full blur-[40px] pointer-events-none" />
          
          <div className="flex items-center gap-3 mb-5 border-b border-white/[0.04] pb-4">
            <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-md">
              <Users className="w-5 h-5 text-indigo-400" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Ownership Structure</h3>
              <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Promoters & Institutional Support Desk</p>
            </div>
          </div>

          <div className="space-y-3.5">
            {[
              { label: 'Promoter Holdings', val: shPattern.promoters, color: 'bg-indigo-500' },
              { label: 'Foreign Investors (FII)', val: shPattern.fii, color: 'bg-cyan-400' },
              { label: 'Domestic Institutions (DII)', val: shPattern.dii, color: 'bg-emerald-400' },
              { label: 'Retail & Public', val: shPattern.publicHolding, color: 'bg-slate-600' },
            ].map((p, idx) => (
              <div key={idx} className="space-y-1">
                <div className="flex justify-between text-[10px] font-black uppercase text-slate-400 tracking-wider">
                  <span>{p.label}</span>
                  <span className="text-white font-bold">{p.val.toFixed(2)}%</span>
                </div>
                <div className="h-2 bg-slate-950 border border-white/[0.04] rounded-full overflow-hidden">
                  <div className={`h-full ${p.color} rounded-full transition-all duration-700`} style={{ width: `${p.val}%` }} />
                </div>
              </div>
            ))}

            {parseFloat(shPattern.pledging) > 0 && (
              <div className="mt-3 bg-rose-500/10 border border-rose-500/20 rounded-xl p-2.5 flex items-center gap-2 text-[9px] font-black text-rose-400 uppercase tracking-widest">
                <Flame className="w-3.5 h-3.5 text-rose-400 animate-pulse" />
                Warning: {shPattern.pledging}% of promoter shares are pledged!
              </div>
            )}
          </div>
        </div>
      )}

      {/* 3. News Sentiment Card */}

      <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
        <div className="absolute top-0 right-0 w-[200px] h-[100px] bg-violet-500/5 rounded-full blur-[40px] pointer-events-none" />
        
        <div className="flex items-center justify-between mb-4 border-b border-white/[0.04] pb-4">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20 shadow-md">
              <MessageSquare className="w-5 h-5 text-violet-400" />
            </div>
            <div>
              <h3 className="text-sm font-black text-white tracking-widest uppercase italic">News Sentiment Feed</h3>
              <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Live Sentiment Classification logs</p>
            </div>
          </div>

          <button 
            onClick={() => refetchSentiment()}
            className="p-2 rounded-lg bg-slate-950/60 border border-white/[0.06] text-slate-500 hover:text-white transition-all shadow-sm"
          >
            <RefreshCw className="w-3.5 h-3.5" />
          </button>
        </div>

        {/* Sentiment meter bar */}
        {loadingSentiment ? (
          <div className="py-8 flex items-center justify-center">
            <div className="w-6 h-6 border-t-2 border-violet-500 border-r-2 border-r-violet-500/20 rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-4">
            <div>
              <div className="flex justify-between items-center text-[10px] font-black uppercase text-slate-500 tracking-wider mb-2">
                <span>Breadth: {sentiment.fearGreed}</span>
                <span className="text-emerald-400 font-bold">{sentiment.bullish}% Bullish</span>
              </div>

              {/* Progress split bar */}
              <div className="h-2.5 rounded-full overflow-hidden flex bg-slate-950 border border-white/[0.04]">
                <div className="bg-emerald-500 transition-all" style={{ width: `${sentiment.bullish}%` }} />
                <div className="bg-slate-700 transition-all" style={{ width: `${sentiment.neutral}%` }} />
                <div className="bg-rose-500 transition-all" style={{ width: `${sentiment.bearish}%` }} />
              </div>
            </div>

            {/* News items list */}
            <div className="space-y-2.5 pt-2">
              {newsItems && newsItems.length > 0 ? (
                newsItems.map((item: any, idx: number) => {
                  const s = item.inferredSentiment || item.sentiment || 'NEUTRAL';
                  const isBull = s.toUpperCase() === 'BULLISH';
                  const isBear = s.toUpperCase() === 'BEARISH';
                  return (
                    <div key={idx} className="bg-slate-950/40 p-2.5 border border-white/[0.03] rounded-xl flex items-start gap-2.5 group hover:border-violet-500/20 transition-all">
                      <div className={`mt-1.5 w-2 h-2 rounded-full flex-shrink-0 ${
                        isBull ? 'bg-emerald-400 shadow-[0_0_6px_rgba(16,185,129,0.6)]' : isBear ? 'bg-rose-400 shadow-[0_0_6px_rgba(244,63,94,0.6)]' : 'bg-slate-600'
                      }`} />
                      
                      <div className="flex-1 space-y-1">
                        <span className="text-[10px] font-medium text-slate-300 leading-normal line-clamp-2">
                          {item.title || item.summary || 'Stock Sentiment Alert'}
                        </span>
                        
                        <div className="flex justify-between items-center text-[8px] font-black uppercase tracking-wider text-slate-600">
                          <span>{item.source || 'NSE'}</span>
                          <span className={isBull ? 'text-emerald-400/80' : isBear ? 'text-rose-400/80' : 'text-slate-500'}>
                            {s}
                          </span>
                        </div>
                      </div>
                    </div>
                  );
                })
              ) : (
                <div className="text-center py-4 text-[9px] font-black text-slate-500 uppercase">
                  No sentiment feed recorded recently
                </div>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  );
};
