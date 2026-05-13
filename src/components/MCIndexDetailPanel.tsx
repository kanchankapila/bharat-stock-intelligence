import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import {
  TrendingUp, TrendingDown, Activity, Info, BarChart3, 
  PieChart, ArrowUpRight, ArrowDownRight, Layers, Target, Zap
} from 'lucide-react';
import { motion } from 'motion/react';
import { Card, SentimentBadge, ValueDisplay, IndicatorRow } from './MCCommon';

interface MCIndexDetailPanelProps {
  indId: string;
  name: string;
  bridgeSymbol?: string;
}

type Timeframe = 'D' | 'W' | 'M';

export const MCIndexDetailPanel: React.FC<MCIndexDetailPanelProps> = ({ indId, name, bridgeSymbol }) => {
  const [timeframe, setTimeframe] = React.useState<Timeframe>('D');
  
  // Data Queries
  const { data: indexData, isLoading: loadingDetails } = trpc.getIndexFullData.useQuery(
    { indId, bridgeSymbol, timeframe },
    { enabled: !!indId }
  );
  
  const { data: constituents, isLoading: loadingStocks } = trpc.getIndexConstituents.useQuery(
    { indId, type: '0' },
    { enabled: !!indId }
  );

  const { data: advDec } = trpc.getAdvanceDecline.useQuery(
    { ex: bridgeSymbol?.includes('NSX') || name.toUpperCase().includes('NIFTY') ? 'N' : 'B' },
    { enabled: !!indId }
  );

  if (loadingDetails) {
    return (
      <div className="flex items-center justify-center p-20">
        <div className="animate-spin rounded-full h-12 w-12 border-t-2 border-b-2 border-blue-500"></div>
      </div>
    );
  }

  const details = indexData?.details?.indices;
  const fundamentals = indexData?.fundamentals;
  const technicals = indexData?.technicals;
  const ad = advDec?.data;

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-900/40 p-6 rounded-2xl border border-slate-800/50 backdrop-blur-xl">
        <div>
          <div className="flex items-center gap-3">
            <h2 className="text-2xl font-black text-white italic uppercase tracking-tight">{name}</h2>
            {details && (
              <span className={cn(
                "px-3 py-1 rounded-full text-[10px] font-black uppercase tracking-widest flex items-center gap-1",
                parseFloat(details.percentchange) >= 0 ? "bg-emerald-500/10 text-emerald-400" : "bg-rose-500/10 text-rose-400"
              )}>
                {parseFloat(details.percentchange) >= 0 ? <TrendingUp className="w-3 h-3" /> : <TrendingDown className="w-3 h-3" />}
                {details.percentchange}%
              </span>
            )}
          </div>
          <p className="text-slate-500 text-[10px] font-bold uppercase tracking-widest mt-1">
            {details?.exchange} • {details?.lastupdated}
          </p>
        </div>
        
        <div className="flex flex-col items-end">
          <span className="text-3xl font-black text-white tabular-nums tracking-tighter italic">
            {details?.lastprice || '—'}
          </span>
          <span className={cn(
            "text-sm font-bold italic",
            parseFloat(details?.change || '0') >= 0 ? "text-emerald-400" : "text-rose-400"
          )}>
            {parseFloat(details?.change || '0') >= 0 ? '+' : ''}{details?.change}
          </span>
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Market Breadth & Fundamentals */}
        <div className="lg:col-span-1 space-y-6">
          {/* Advance Decline */}
          {ad && (
            <Card title="Market Breadth" icon={Activity}>
              <div className="space-y-4">
                <div className="flex justify-between items-end mb-1">
                  <div className="text-center">
                    <span className="text-[10px] font-black text-emerald-500 uppercase">Adv</span>
                    <p className="text-lg font-black text-white">{ad.adv || '0'}</p>
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] font-black text-slate-500 uppercase">Unch</span>
                    <p className="text-lg font-black text-white">{ad.unch || '0'}</p>
                  </div>
                  <div className="text-center">
                    <span className="text-[10px] font-black text-rose-500 uppercase">Dec</span>
                    <p className="text-lg font-black text-white">{ad.dec || '0'}</p>
                  </div>
                </div>
                
                <div className="h-3 w-full bg-slate-900 rounded-full overflow-hidden flex">
                  <div 
                    className="h-full bg-emerald-500 transition-all duration-1000" 
                    style={{ width: `${(parseFloat(ad.adv || '0') / (parseFloat(ad.total || '1') || 1)) * 100}%` }}
                  />
                  <div 
                    className="h-full bg-slate-700 transition-all duration-1000" 
                    style={{ width: `${(parseFloat(ad.unch || '0') / (parseFloat(ad.total || '1') || 1)) * 100}%` }}
                  />
                  <div 
                    className="h-full bg-rose-500 transition-all duration-1000" 
                    style={{ width: `${(parseFloat(ad.dec || '0') / (parseFloat(ad.total || '1') || 1)) * 100}%` }}
                  />
                </div>
                <p className="text-[9px] text-center text-slate-600 font-bold uppercase tracking-widest">
                  Total Stocks: {ad.total || '—'}
                </p>
              </div>
            </Card>
          )}

          {/* Fundamentals */}
          {fundamentals && (
            <Card title="Index Valuation" icon={Target}>
              <div className="grid grid-cols-2 gap-3">
                <ValueDisplay label="PE Ratio" value={fundamentals.pe} sub="Trailing" />
                <ValueDisplay label="PB Ratio" value={fundamentals.pb} sub="Price/Book" />
                <ValueDisplay label="Div Yield" value={fundamentals.divYield ? `${fundamentals.divYield}%` : '—'} sub="Annual" />
              </div>
              
              {fundamentals.sectorWeights && fundamentals.sectorWeights.length > 0 && (
                <div className="mt-6">
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Top Sectoral Weights</p>
                   <div className="space-y-2">
                     {fundamentals.sectorWeights.slice(0, 5).map((sw: any, i: number) => (
                       <div key={i} className="flex justify-between items-center text-[10px]">
                         <span className="text-slate-400 font-bold">{sw.sector}</span>
                         <span className="text-white font-black italic">{sw.weight}%</span>
                       </div>
                     ))}
                   </div>
                </div>
              )}
            </Card>
          )}
        </div>

        {/* Performance & Technicals */}
        <div className="lg:col-span-2 space-y-6">
          <Card title="Performance Profile" icon={BarChart3}>
             <div className="grid grid-cols-2 md:grid-cols-4 lg:grid-cols-5 gap-3">
               <ValueDisplay label="YTD" value={details?.ytd ? `${details.ytd}%` : '—'} color={parseFloat(details?.ytd || '0') >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
               <ValueDisplay label="1 Week" value={details?.week1 ? `${details.week1}%` : '—'} color={parseFloat(details?.week1 || '0') >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
               <ValueDisplay label="1 Month" value={details?.month1 ? `${details.month1}%` : '—'} color={parseFloat(details?.month1 || '0') >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
               <ValueDisplay label="3 Month" value={details?.month3 ? `${details.month3}%` : '—'} color={parseFloat(details?.month3 || '0') >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
               <ValueDisplay label="1 Year" value={details?.year1 ? `${details.year1}%` : '—'} color={parseFloat(details?.year1 || '0') >= 0 ? 'text-emerald-400' : 'text-rose-400'} />
             </div>
             
             <div className="mt-6 grid grid-cols-1 md:grid-cols-2 gap-6">
                <div>
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">OHLC Stats</p>
                   <div className="grid grid-cols-2 gap-2">
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800/50">
                        <span className="text-[8px] text-slate-600 font-bold uppercase">Open</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.open}</p>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800/50">
                        <span className="text-[8px] text-slate-600 font-bold uppercase">High</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.high}</p>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800/50">
                        <span className="text-[8px] text-slate-600 font-bold uppercase">Low</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.low}</p>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800/50">
                        <span className="text-[8px] text-slate-600 font-bold uppercase">Prev Close</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.prevclose}</p>
                      </div>
                   </div>
                </div>
                
                <div>
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Range Analysis</p>
                   <div className="space-y-3">
                      <div>
                        <div className="flex justify-between text-[9px] mb-1">
                          <span className="text-slate-500 font-bold">52W LOW: {details?.yearlylow}</span>
                          <span className="text-slate-500 font-bold">52W HIGH: {details?.yearlyhigh}</span>
                        </div>
                        <div className="h-1 w-full bg-slate-900 rounded-full overflow-hidden relative">
                           {/* Simplified range indicator */}
                           <div className="absolute top-0 h-full bg-blue-500 w-1 left-1/2" />
                        </div>
                      </div>
                      <div className="bg-slate-950 p-2 rounded-lg border border-slate-800/50 flex justify-between">
                         <span className="text-[8px] text-slate-600 font-bold uppercase">Yrs Avg 200</span>
                         <p className="text-xs font-black text-blue-400 tabular-nums">{details?.dayavg200}</p>
                      </div>
                   </div>
                </div>
             </div>
          </Card>

          {/* Technicals */}
          {technicals && technicals.data && (
            <Card title="Technical Analysis" icon={Zap}>
              <div className="flex gap-2 mb-6 bg-slate-950 p-1 rounded-xl border border-slate-800 w-fit">
                {(['D', 'W', 'M'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setTimeframe(p)}
                    className={cn(
                      "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                      timeframe === p ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20" : "text-slate-500 hover:text-slate-300"
                    )}
                  >
                    {p === 'D' ? 'Daily' : p === 'W' ? 'Weekly' : 'Monthly'}
                  </button>
                ))}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <div>
                   <p className="text-[9px] font-black text-slate-500 uppercase tracking-widest mb-3">Pivot Levels</p>
                   <div className="space-y-1.5">
                     {technicals.data.pivotLevels?.[0]?.pivotLevel && (
                        Object.entries(technicals.data.pivotLevels[0].pivotLevel).map(([key, val]) => (
                          <div key={key} className="flex justify-between items-center text-[10px]">
                            <span className="text-slate-500 font-bold uppercase">{key}</span>
                            <span className="text-white font-black tabular-nums">{val as string}</span>
                          </div>
                        ))
                     )}
                   </div>
                 </div>
                 
                 <div className="space-y-3">
                    <IndicatorRow 
                      name="RSI (14)" 
                      value={technicals.data.indicators?.find((i: any) => i.id === 'rsi')?.value} 
                      sentiment={technicals.data.indicators?.find((i: any) => i.id === 'rsi')?.indication || ''} 
                    />
                    <IndicatorRow 
                      name="MACD" 
                      value={technicals.data.indicators?.find((i: any) => i.id === 'macd')?.value} 
                      sentiment={technicals.data.indicators?.find((i: any) => i.id === 'macd')?.indication || ''} 
                    />
                 </div>
              </div>
            </Card>
          )}

          {/* Constituents */}
          {constituents && constituents.item && (
            <Card title="Top Constituents" icon={Layers}>
              <div className="overflow-x-auto">
                <table className="w-full text-left">
                  <thead>
                    <tr className="border-b border-slate-800">
                      <th className="py-3 text-[9px] font-black text-slate-500 uppercase tracking-widest">Symbol</th>
                      <th className="py-3 text-[9px] font-black text-slate-500 uppercase tracking-widest text-right">LTP</th>
                      <th className="py-3 text-[9px] font-black text-slate-500 uppercase tracking-widest text-right">Change</th>
                    </tr>
                  </thead>
                  <tbody>
                    {constituents.item.slice(0, 10).map((s: any, i: number) => (
                      <tr key={i} className="border-b border-slate-800/30 hover:bg-slate-800/20 transition-colors cursor-pointer group">
                        <td className="py-3">
                          <p className="text-xs font-black text-white group-hover:text-blue-400 transition-colors uppercase italic">{s.shortname}</p>
                        </td>
                        <td className="py-3 text-right">
                          <p className="text-xs font-black text-white tabular-nums">{s.lastprice}</p>
                        </td>
                        <td className="py-3 text-right">
                          <span className={cn(
                            "text-[10px] font-black tabular-nums",
                            parseFloat(s.percentchange) >= 0 ? "text-emerald-400" : "text-rose-400"
                          )}>
                            {parseFloat(s.percentchange) >= 0 ? '+' : ''}{s.percentchange}%
                          </span>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </Card>
          )}
        </div>
      </div>
    </div>
  );
};
