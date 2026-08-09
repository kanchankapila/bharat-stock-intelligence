import React from 'react';
import { cn } from '../lib/utils';
import { trpc } from '../lib/trpc';
import {
  TrendingUp, TrendingDown, Info, BarChart3,
  PieChart, ArrowUpRight, ArrowDownRight, Target, Zap
} from 'lucide-react';
import { motion } from 'motion/react';
import {
  LineChart, Line, AreaChart, Area, BarChart, Bar, XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer, Legend, ComposedChart
} from 'recharts';
import { Card, SentimentBadge, ValueDisplay, IndicatorRow } from './MCCommon';
import { MarketBreadthIntraday } from './MarketBreadthIntraday';
import { resolveConstituentSymbol } from '../lib/resolveConstituentSymbol';

export { resolveConstituentSymbol };

interface MCIndexDetailPanelProps {
  indId: string;
  name: string;
  bridgeSymbol?: string;
}

type Timeframe = 'D' | 'W' | 'M';

export const MCIndexDetailPanel: React.FC<MCIndexDetailPanelProps> = ({ indId, name, bridgeSymbol }) => {
  const [timeframe, setTimeframe] = React.useState<Timeframe>('D');
  const [graphRange, setGraphRange] = React.useState<string>('1d');
  const [graphType, setGraphType] = React.useState<string>('line');
  
  // Data Queries
  const { data: indexData, isLoading: loadingDetails } = trpc.getIndexFullData.useQuery(
    { indId, bridgeSymbol, timeframe },
    { enabled: !!indId }
  );
  
  const breadthEx: 'N' | 'B' = bridgeSymbol?.includes('NSX') || name.toUpperCase().includes('NIFTY') ? 'N' : 'B';

  const { data: peChart } = trpc.getIndexPeChart.useQuery(
    { indId },
    { enabled: !!indId, staleTime: 3600000 }
  );

  const { data: pbChart } = trpc.getIndexPbChart.useQuery(
    { indId },
    { enabled: !!indId, staleTime: 3600000 }
  );
  
  const { data: graphData, isLoading: loadingGraph } = trpc.getIndexGraph.useQuery(
    { indId, range: graphRange, type: graphType },
    { enabled: !!indId, staleTime: 60000 }
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

  return (
    <div className="space-y-6">
      {/* Header Info */}
      <div className="flex flex-col md:flex-row justify-between items-start md:items-center gap-4 bg-slate-900/40 p-6 rounded-2xl border border-slate-800/30 backdrop-blur-xl">
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
          <p className="text-slate-400 text-[10px] font-bold uppercase tracking-widest mt-1">
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
      
      {/* Price Graph Section */}
      <Card title="Market Performance" icon={TrendingUp}>
        <div className="space-y-4">
          <div className="flex flex-wrap justify-between items-center gap-4">
            <div className="flex gap-1 glass-strong p-1 rounded-xl border border-slate-800/50">
              {['1d', '5d', '1m', '3m', '6m', '1yr', '2yr', '5yr'].map((r) => (
                <button
                  key={r}
                  onClick={() => setGraphRange(r)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                    graphRange === r ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:text-slate-300"
                  )}
                >
                  {r}
                </button>
              ))}
            </div>
            
            <div className="flex gap-1 glass-strong p-1 rounded-xl border border-slate-800/50">
              {['line', 'area', 'stick', 'ohlc'].map((t) => (
                <button
                  key={t}
                  onClick={() => setGraphType(t)}
                  className={cn(
                    "px-3 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                    graphType === t ? "bg-blue-600 text-white shadow-lg" : "text-slate-400 hover:text-slate-300"
                  )}
                >
                  {t}
                </button>
              ))}
            </div>
          </div>

          <div className="h-[350px] w-full glass-strong/50 rounded-2xl border border-slate-800/20 p-4">
            {loadingGraph ? (
              <div className="h-full flex items-center justify-center">
                <div className="animate-spin rounded-full h-8 w-8 border-t-2 border-b-2 border-blue-500"></div>
              </div>
            ) : graphData?.graph?.values ? (
              <ResponsiveContainer width="100%" height="100%">
                {graphType === 'area' ? (
                  <AreaChart data={graphData.graph.values}>
                    <defs>
                      <linearGradient id="colorValue" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="5%" stopColor="#3b82f6" stopOpacity={0.3}/>
                        <stop offset="95%" stopColor="#3b82f6" stopOpacity={0}/>
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis 
                      dataKey="_time" 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      minTickGap={30}
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', fontSize: '10px' }}
                      itemStyle={{ color: '#fff', fontWeight: 'bold' }}
                      labelStyle={{ color: '#64748b', marginBottom: '4px' }}
                      formatter={(v: any) => [parseFloat(v).toLocaleString(), 'Price']}
                    />
                    <Area type="monotone" dataKey="_value" stroke="#3b82f6" strokeWidth={2} fillOpacity={1} fill="url(#colorValue)" />
                  </AreaChart>
                ) : graphType === 'stick' ? (
                  <BarChart data={graphData.graph.values}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis 
                      dataKey="_time" 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      minTickGap={30}
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', fontSize: '10px' }}
                      formatter={(v: any) => [parseFloat(v).toLocaleString(), 'Price']}
                    />
                    <Bar dataKey="_value" fill="#3b82f6" radius={[2, 2, 0, 0]} />
                  </BarChart>
                ) : (
                  <LineChart data={graphData.graph.values}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                    <XAxis 
                      dataKey="_time" 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      minTickGap={30}
                    />
                    <YAxis 
                      domain={['auto', 'auto']} 
                      tick={{ fontSize: 9, fill: '#64748b' }} 
                      axisLine={false}
                      tickLine={false}
                      width={40}
                    />
                    <Tooltip
                      contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', fontSize: '10px' }}
                      formatter={(v: any) => [parseFloat(v).toLocaleString(), 'Price']}
                    />
                    <Line type="monotone" dataKey="_value" stroke="#3b82f6" strokeWidth={2} dot={false} />
                  </LineChart>
                )}
              </ResponsiveContainer>
            ) : (
              <div className="h-full flex items-center justify-center text-slate-400 text-sm font-bold">
                No graph data available
              </div>
            )}
          </div>
        </div>
      </Card>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Market Breadth & Fundamentals */}
        <div className="lg:col-span-1 space-y-6">
          {/* Advance Decline — intraday breadth chart (shared widget, 10s refresh) */}
          <MarketBreadthIntraday ex={breadthEx} refetchInterval={10000} />

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
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Top Sectoral Weights</p>
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
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">OHLC Stats</p>
                   <div className="grid grid-cols-2 gap-2">
                      <div className="glass-strong p-2 rounded-lg border border-slate-800/30">
                        <span className="text-[9.5px] text-slate-400 font-bold uppercase">Open</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.open}</p>
                      </div>
                      <div className="glass-strong p-2 rounded-lg border border-slate-800/30">
                        <span className="text-[9.5px] text-slate-400 font-bold uppercase">High</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.high}</p>
                      </div>
                      <div className="glass-strong p-2 rounded-lg border border-slate-800/30">
                        <span className="text-[9.5px] text-slate-400 font-bold uppercase">Low</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.low}</p>
                      </div>
                      <div className="glass-strong p-2 rounded-lg border border-slate-800/30">
                        <span className="text-[9.5px] text-slate-400 font-bold uppercase">Prev Close</span>
                        <p className="text-xs font-black text-white tabular-nums">{details?.prevclose}</p>
                      </div>
                   </div>
                </div>
                
                <div>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Range Analysis</p>
                   <div className="space-y-3">
                      <div>
                        <div className="flex justify-between text-[10px] mb-1">
                          <span className="text-slate-400 font-bold">52W LOW: {details?.yearlylow}</span>
                          <span className="text-slate-400 font-bold">52W HIGH: {details?.yearlyhigh}</span>
                        </div>
                        <div className="h-1 w-full glass rounded-full overflow-hidden relative">
                           {/* Simplified range indicator */}
                           <div className="absolute top-0 h-full bg-blue-500 w-1 left-1/2" />
                        </div>
                      </div>
                      <div className="glass-strong p-2 rounded-lg border border-slate-800/30 flex justify-between">
                         <span className="text-[9.5px] text-slate-400 font-bold uppercase">Yrs Avg 200</span>
                         <p className="text-xs font-black text-blue-400 tabular-nums">{details?.dayavg200}</p>
                      </div>
                   </div>
                </div>
             </div>
          </Card>

          {/* Technicals */}
          {technicals && technicals.data && (
            <Card title="Technical Analysis" icon={Zap}>
              <div className="flex gap-2 mb-6 glass-strong p-1 rounded-xl border border-slate-800/50 w-fit">
                {(['D', 'W', 'M'] as const).map((p) => (
                  <button
                    key={p}
                    onClick={() => setTimeframe(p)}
                    className={cn(
                      "px-4 py-1.5 rounded-lg text-[10px] font-black uppercase tracking-widest transition-all",
                      timeframe === p ? "bg-blue-600 text-white shadow-lg shadow-blue-900/20" : "text-slate-400 hover:text-slate-300"
                    )}
                  >
                    {p === 'D' ? 'Daily' : p === 'W' ? 'Weekly' : 'Monthly'}
                  </button>
                ))}
              </div>
              
              <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
                 <div>
                   <p className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-3">Pivot Levels</p>
                   <div className="space-y-1.5">
                     {technicals.data.pivotLevels?.[0]?.pivotLevel && (
                        Object.entries(technicals.data.pivotLevels[0].pivotLevel).map(([key, val]) => (
                          <div key={key} className="flex justify-between items-center text-[10px]">
                            <span className="text-slate-400 font-bold uppercase">{key}</span>
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

          {/* PE/PB Valuation Time Series Charts */}
          {(peChart || pbChart) && (
            <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
              {peChart && peChart.length > 0 && (
                <Card title="PE Ratio — 1 Year History" icon={BarChart3}>
                  <div className="h-48 mt-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={peChart.slice(-60)} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="date" hide />
                        <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#64748b' }} width={40} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '10px' }}
                          formatter={(v: any) => [v.toFixed(2), 'PE']}
                          labelFormatter={(l) => l}
                        />
                        <Line type="monotone" dataKey="value" stroke="#3b82f6" strokeWidth={2} dot={false} name="PE" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex justify-between mt-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    <span>Current: <span className="text-white">{peChart[peChart.length - 1]?.value?.toFixed(2)}</span></span>
                    <span>Min: <span className="text-emerald-400">{Math.min(...peChart.map(d => d.value)).toFixed(2)}</span></span>
                    <span>Max: <span className="text-rose-400">{Math.max(...peChart.map(d => d.value)).toFixed(2)}</span></span>
                  </div>
                </Card>
              )}
              {pbChart && pbChart.length > 0 && (
                <Card title="PB Ratio — 1 Year History" icon={BarChart3}>
                  <div className="h-48 mt-3">
                    <ResponsiveContainer width="100%" height="100%">
                      <LineChart data={pbChart.slice(-60)} margin={{ top: 4, right: 4, bottom: 0, left: -20 }}>
                        <CartesianGrid strokeDasharray="3 3" stroke="#1e293b" vertical={false} />
                        <XAxis dataKey="date" hide />
                        <YAxis domain={['auto', 'auto']} tick={{ fontSize: 9, fill: '#64748b' }} width={40} />
                        <Tooltip
                          contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '8px', fontSize: '10px' }}
                          formatter={(v: any) => [v.toFixed(2), 'PB']}
                          labelFormatter={(l) => l}
                        />
                        <Line type="monotone" dataKey="value" stroke="#a855f7" strokeWidth={2} dot={false} name="PB" />
                      </LineChart>
                    </ResponsiveContainer>
                  </div>
                  <div className="flex justify-between mt-2 text-[10px] font-black text-slate-400 uppercase tracking-widest">
                    <span>Current: <span className="text-white">{pbChart[pbChart.length - 1]?.value?.toFixed(2)}</span></span>
                    <span>Min: <span className="text-emerald-400">{Math.min(...pbChart.map(d => d.value)).toFixed(2)}</span></span>
                    <span>Max: <span className="text-rose-400">{Math.max(...pbChart.map(d => d.value)).toFixed(2)}</span></span>
                  </div>
                </Card>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
};
