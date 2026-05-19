import React, { useState } from 'react';
import {
  ResponsiveContainer,
  ComposedChart,
  Area,
  Line,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  CartesianGrid,
} from 'recharts';
import { Activity, Eye, EyeOff, Calendar } from 'lucide-react';
import { trpc } from '../../lib/trpc';

interface QuantChartStationProps {
  symbol: string;
}

export const QuantChartStation: React.FC<QuantChartStationProps> = ({ symbol }) => {
  const [duration, setDuration] = useState<string>('1y');
  const [showEMA20, setShowEMA20] = useState<boolean>(true);
  const [showEMA50, setShowEMA50] = useState<boolean>(false);
  const [showBands, setShowBands] = useState<boolean>(false);

  const { data: ohlcRes, isLoading } = trpc.getOHLCData.useQuery(
    { symbol, dur: duration },
    { refetchInterval: duration === '1d' ? 60000 : 300000 }
  );

  const chartData = React.useMemo(() => {
    if (!ohlcRes || ohlcRes.success !== 1 || !ohlcRes.data) return [];
    
    // Process data to calculate EMA and Bollinger Bands
    const raw = [...ohlcRes.data];
    if (raw.length === 0) return [];

    // Sort chronologically just in case
    raw.sort((a: any, b: any) => a.time - b.time);

    // Format timestamps to human-readable strings
    const formatted = raw.map((d: any) => {
      const date = new Date(d.time * 1000);
      let dateStr = '';
      if (duration === '1d' || duration === '5d' || duration === '1m') {
        dateStr = date.toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
      } else {
        dateStr = date.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
      }
      return {
        ...d,
        formattedTime: dateStr,
      };
    });

    // Helper: calculate Simple Moving Average
    const calcSMA = (data: any[], period: number, idx: number) => {
      if (idx < period - 1) return null;
      let sum = 0;
      for (let i = 0; i < period; i++) {
        sum += data[idx - i].close;
      }
      return sum / period;
    };

    // Helper: calculate Exponential Moving Average
    const calcEMA = (data: any[], period: number) => {
      const k = 2 / (period + 1);
      const ema: (number | null)[] = new Array(data.length).fill(null);
      
      // Seed with SMA
      let firstSMA = 0;
      for (let i = 0; i < period; i++) {
        firstSMA += data[i]?.close || 0;
      }
      firstSMA = firstSMA / period;
      ema[period - 1] = firstSMA;

      for (let i = period; i < data.length; i++) {
        ema[i] = (data[i].close * k) + (ema[i - 1]! * (1 - k));
      }
      return ema;
    };

    // Helper: Standard Deviation
    const calcStdDev = (data: any[], period: number, mean: number, idx: number) => {
      let sumOfSquares = 0;
      for (let i = 0; i < period; i++) {
        const diff = data[idx - i].close - mean;
        sumOfSquares += diff * diff;
      }
      return Math.sqrt(sumOfSquares / period);
    };

    // Compute EMAs
    let ema20List: (number | null)[] = [];
    let ema50List: (number | null)[] = [];
    if (formatted.length >= 20) ema20List = calcEMA(formatted, 20);
    if (formatted.length >= 50) ema50List = calcEMA(formatted, 50);

    // Compute Bollinger Bands (using SMA 20 + 2 Standard Deviations)
    return formatted.map((d: any, idx: number) => {
      const ema20 = ema20List[idx] ? Number(ema20List[idx]!.toFixed(2)) : null;
      const ema50 = ema50List[idx] ? Number(ema50List[idx]!.toFixed(2)) : null;

      // Bands
      let bandUpper: number | null = null;
      let bandLower: number | null = null;
      let bandBasis: number | null = null;

      if (idx >= 19) {
        const basis = calcSMA(formatted, 20, idx);
        if (basis) {
          bandBasis = Number(basis.toFixed(2));
          const stdDev = calcStdDev(formatted, 20, basis, idx);
          bandUpper = Number((basis + 2 * stdDev).toFixed(2));
          bandLower = Number((basis - 2 * stdDev).toFixed(2));
        }
      }

      // Check if price went up or down compared to open for volume coloring
      const wentUp = d.close >= d.open;

      return {
        ...d,
        ema20,
        ema50,
        bandUpper,
        bandLower,
        bandBasis,
        isUp: wentUp,
        volumeColor: wentUp ? 'rgba(16, 185, 129, 0.45)' : 'rgba(244, 63, 94, 0.45)',
      };
    });
  }, [ohlcRes, duration]);

  const latestData = chartData[chartData.length - 1];

  const durationOptions = [
    { value: '1d', label: '1D' },
    { value: '5d', label: '5D' },
    { value: '1m', label: '1M' },
    { value: '6m', label: '6M' },
    { value: '1y', label: '1Y' },
    { value: 'max', label: 'MAX' },
  ];

  return (
    <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl p-6 shadow-2xl relative overflow-hidden backdrop-blur-2xl">
      <div className="absolute top-0 right-0 w-[400px] h-[200px] bg-indigo-500/5 rounded-full blur-[80px] pointer-events-none" />
      
      {/* Chart controls */}
      <div className="flex flex-wrap items-center justify-between gap-4 mb-6 relative z-10 border-b border-white/[0.04] pb-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-indigo-500/10 flex items-center justify-center border border-indigo-500/20 shadow-md">
            <Activity className="w-5 h-5 text-indigo-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white tracking-widest uppercase italic">Workspace Price Stream</h3>
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">Interactive Technical Indicators Overlay</p>
          </div>
        </div>

        {/* Timeframe selector */}
        <div className="flex bg-slate-950/70 p-1 border border-white/[0.06] rounded-xl shadow-inner gap-1">
          {durationOptions.map((opt) => (
            <button
              key={opt.value}
              onClick={() => setDuration(opt.value)}
              className={`px-3 py-1.5 rounded-lg text-xs font-black transition-all ${
                duration === opt.value
                  ? 'bg-indigo-600 text-white shadow-md'
                  : 'text-slate-500 hover:text-slate-300'
              }`}
            >
              {opt.label}
            </button>
          ))}
        </div>
      </div>

      {/* Overlay Toggles */}
      <div className="flex flex-wrap items-center gap-3 mb-4 relative z-10">
        <button
          onClick={() => setShowEMA20(!showEMA20)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
            showEMA20
              ? 'bg-cyan-500/10 text-cyan-400 border-cyan-500/30'
              : 'bg-slate-950/40 text-slate-600 border-transparent hover:text-slate-400'
          }`}
        >
          {showEMA20 ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          EMA 20
        </button>
        <button
          onClick={() => setShowEMA50(!showEMA50)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
            showEMA50
              ? 'bg-amber-500/10 text-amber-400 border-amber-500/30'
              : 'bg-slate-950/40 text-slate-600 border-transparent hover:text-slate-400'
          }`}
        >
          {showEMA50 ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          EMA 50
        </button>
        <button
          onClick={() => setShowBands(!showBands)}
          className={`flex items-center gap-2 px-3 py-1.5 rounded-xl border text-xs font-semibold transition-all ${
            showBands
              ? 'bg-violet-500/10 text-violet-400 border-violet-500/30'
              : 'bg-slate-950/40 text-slate-600 border-transparent hover:text-slate-400'
          }`}
        >
          {showBands ? <Eye className="w-3.5 h-3.5" /> : <EyeOff className="w-3.5 h-3.5" />}
          Bollinger Bands
        </button>
      </div>

      {/* Main Chart Screen */}
      <div className="h-[360px] w-full relative z-10">
        {isLoading ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/20 backdrop-blur-sm rounded-2xl">
            <div className="w-10 h-10 border-t-2 border-indigo-500 border-r-2 border-r-indigo-500/20 rounded-full animate-spin mb-4" />
            <p className="text-xs font-bold text-slate-500 tracking-widest uppercase animate-pulse">Syncing stock coordinates...</p>
          </div>
        ) : chartData.length === 0 ? (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-slate-950/20 rounded-2xl border border-white/[0.04]">
            <Calendar className="w-10 h-10 text-slate-700 mb-3" />
            <p className="text-xs font-bold text-slate-500 tracking-widest uppercase">No pricing history found for {symbol}</p>
          </div>
        ) : (
          <ResponsiveContainer width="100%" height="100%">
            <ComposedChart data={chartData} margin={{ top: 10, right: 5, left: -25, bottom: 0 }}>
              <defs>
                <linearGradient id="priceGradient" x1="0" y1="0" x2="0" y2="1">
                  <stop offset="0%" stopColor="#6366f1" stopOpacity={0.25} />
                  <stop offset="100%" stopColor="#6366f1" stopOpacity={0.0} />
                </linearGradient>
              </defs>
              
              <CartesianGrid strokeDasharray="3 3" stroke="rgba(255,255,255,0.02)" vertical={false} />
              
              <XAxis 
                dataKey="formattedTime" 
                stroke="rgba(255,255,255,0.2)" 
                fontSize={9} 
                fontWeight="700" 
                tickLine={false} 
                axisLine={false}
              />
              
              <YAxis 
                yAxisId="price"
                domain={['auto', 'auto']}
                stroke="rgba(255,255,255,0.2)"
                fontSize={9}
                fontWeight="700"
                tickLine={false}
                axisLine={false}
                orientation="right"
                tickFormatter={(val) => `₹${val.toLocaleString()}`}
              />

              <YAxis 
                yAxisId="volume"
                domain={[0, (dataMax) => dataMax * 5]}
                stroke="rgba(255,255,255,0.2)"
                fontSize={9}
                tickLine={false}
                axisLine={false}
                display="none"
              />

              <Tooltip
                contentStyle={{
                  background: 'rgba(7, 10, 19, 0.92)',
                  backdropFilter: 'blur(20px)',
                  border: '1px solid rgba(255, 255, 255, 0.08)',
                  borderRadius: '16px',
                  boxShadow: '0 12px 24px rgba(0, 0, 0, 0.5)',
                }}
                labelStyle={{ fontSize: '10px', fontWeight: '900', color: '#94a3b8', textTransform: 'uppercase', letterSpacing: '0.05em' }}
                itemStyle={{ fontSize: '11px', fontWeight: '700', color: '#ffffff', padding: '1px 0' }}
                formatter={(value: any, name: string) => {
                  if (name === 'close') return [`₹${value.toLocaleString()}`, 'Close Price'];
                  if (name === 'open') return [`₹${value.toLocaleString()}`, 'Open Price'];
                  if (name === 'high') return [`₹${value.toLocaleString()}`, 'Day High'];
                  if (name === 'low') return [`₹${value.toLocaleString()}`, 'Day Low'];
                  if (name === 'volume') return [value.toLocaleString(), 'Volume'];
                  if (name === 'ema20') return [`₹${value.toLocaleString()}`, 'EMA 20'];
                  if (name === 'ema50') return [`₹${value.toLocaleString()}`, 'EMA 50'];
                  if (name === 'bandUpper') return [`₹${value.toLocaleString()}`, 'Upper Band'];
                  if (name === 'bandLower') return [`₹${value.toLocaleString()}`, 'Lower Band'];
                  return [value, name];
                }}
              />

              {/* Bollinger Bands Fill */}
              {showBands && (
                <Area 
                  yAxisId="price" 
                  dataKey="bandUpper" 
                  stroke="transparent" 
                  fill="rgba(139, 92, 246, 0.03)" 
                  legendType="none" 
                  tooltipType="none"
                />
              )}

              {/* Price Area */}
              <Area
                yAxisId="price"
                type="monotone"
                dataKey="close"
                stroke="#6366f1"
                strokeWidth={2}
                fillOpacity={1}
                fill="url(#priceGradient)"
              />

              {/* Volume Bars */}
              <Bar 
                yAxisId="volume" 
                dataKey="volume" 
                fill="rgba(99, 102, 241, 0.2)" 
                radius={[4, 4, 0, 0]}
              >
                {chartData.map((entry: any, index: number) => (
                  <rect key={`rect-${index}`} fill={entry.volumeColor} />
                ))}
              </Bar>

              {/* Bollinger Upper & Lower Bounds */}
              {showBands && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="bandUpper"
                  stroke="rgba(139, 92, 246, 0.5)"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  dot={false}
                  tooltipType="none"
                />
              )}
              {showBands && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="bandLower"
                  stroke="rgba(139, 92, 246, 0.5)"
                  strokeWidth={1}
                  strokeDasharray="4 4"
                  dot={false}
                  tooltipType="none"
                />
              )}

              {/* EMAs */}
              {showEMA20 && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="ema20"
                  stroke="#22d3ee"
                  strokeWidth={1.5}
                  dot={false}
                />
              )}

              {showEMA50 && (
                <Line
                  yAxisId="price"
                  type="monotone"
                  dataKey="ema50"
                  stroke="#f59e0b"
                  strokeWidth={1.5}
                  dot={false}
                />
              )}

            </ComposedChart>
          </ResponsiveContainer>
        )}
      </div>

      {/* Ticker footer info */}
      {latestData && (
        <div className="mt-4 flex flex-wrap items-center justify-between text-[10px] font-black uppercase text-slate-500 tracking-wider relative z-10 border-t border-white/[0.04] pt-4">
          <div className="flex gap-4">
            <span>O: <span className="text-white font-bold">₹{latestData.open?.toLocaleString()}</span></span>
            <span>H: <span className="text-white font-bold text-emerald-400">₹{latestData.high?.toLocaleString()}</span></span>
            <span>L: <span className="text-white font-bold text-rose-400">₹{latestData.low?.toLocaleString()}</span></span>
            <span>C: <span className="text-white font-bold">₹{latestData.close?.toLocaleString()}</span></span>
          </div>
          <div className="mt-1 sm:mt-0">
            <span>Vol: <span className="text-slate-300 font-bold">{latestData.volume?.toLocaleString()}</span></span>
          </div>
        </div>
      )}
    </div>
  );
};
