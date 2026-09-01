import React, { useEffect, useRef } from 'react';
import { createChart, IChartApi, ISeriesApi, CandlestickSeries } from 'lightweight-charts';

interface ChartDataPoint {
  time: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume?: number;
}

interface V2LightweightChartProps {
  data: ChartDataPoint[];
  height?: number;
  symbol: string;
}

export const V2LightweightChart: React.FC<V2LightweightChartProps> = ({ data, height = 300, symbol }) => {
  const chartContainerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const candleSeriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  useEffect(() => {
    if (!chartContainerRef.current) return;

    // Create Chart instance
    const chart = createChart(chartContainerRef.current, {
      width: chartContainerRef.current.clientWidth,
      height: height,
      layout: {
        background: { color: '#07090e' },
        textColor: '#94a3b8',
      },
      grid: {
        vertLines: { color: '#161b22' },
        horzLines: { color: '#161b22' },
      },
      crosshair: {
        mode: 1, // Normal crosshair
      },
      rightPriceScale: {
        borderColor: '#21262d',
      },
      timeScale: {
        borderColor: '#21262d',
        timeVisible: true,
      },
    });

    // Add candlestick series
    const candleSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#00e676',
      downColor: '#ff1744',
      borderDownColor: '#ff1744',
      borderUpColor: '#00e676',
      wickDownColor: '#ff1744',
      wickUpColor: '#00e676',
    });

    chartRef.current = chart;
    candleSeriesRef.current = candleSeries;

    // Handle resize
    const handleResize = () => {
      if (chartContainerRef.current && chartRef.current) {
        chartRef.current.applyOptions({
          width: chartContainerRef.current.clientWidth,
        });
      }
    };
    window.addEventListener('resize', handleResize);

    return () => {
      window.removeEventListener('resize', handleResize);
      chart.remove();
    };
  }, [height]);

  useEffect(() => {
    if (candleSeriesRef.current && data.length > 0) {
      // lightweight-charts needs data sorted by time asc and unique times
      // Convert timestamps to lightweight-charts format (YYYY-MM-DD or Unix timestamp)
      const formatted = data.map((d, index) => {
        // Parse time: if format is not YYYY-MM-DD, generate a sequential day to prevent errors
        let timeVal: any = d.time;
        if (typeof d.time === 'number' || /^\d+$/.test(d.time)) {
          timeVal = typeof d.time === 'number' ? d.time : parseInt(d.time, 10);
        } else if (!/^\d{4}-\d{2}-\d{2}$/.test(d.time)) {
          // Fallback sequential dates sliding back from today
          const totalDays = data.length;
          const date = new Date();
          date.setDate(date.getDate() - (totalDays - index));
          timeVal = date.toISOString().split('T')[0];
        }


        return {
          time: timeVal,
          open: d.open,
          high: d.high,
          low: d.low,
          close: d.close,
        };
      });
      candleSeriesRef.current.setData(formatted);
    }
  }, [data]);

  return (
    <div className="w-full relative glass border border-terminal-border rounded-2xl overflow-hidden p-4 bg-terminal-panel">
      <div className="flex justify-between items-center mb-3">
        <span className="text-xs font-black text-slate-200 tracking-wider uppercase font-mono">{symbol} Real-Time Candle Feed</span>
        <span className="text-[9px] font-bold text-emerald-400 font-mono tracking-widest bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">60 FPS</span>
      </div>
      <div ref={chartContainerRef} className="w-full" />
    </div>
  );
};
