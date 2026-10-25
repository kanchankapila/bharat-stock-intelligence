import React, { useEffect, useRef, useCallback } from 'react';
import { createChart, CandlestickSeries, ColorType, IChartApi, ISeriesApi, type CandlestickData } from 'lightweight-charts';
import { cn } from '../../../lib/utils';

interface Candle {
  time: string; // 'YYYY-MM-DD'
  open: number;
  high: number;
  low: number;
  close: number;
}

interface PriceChartProps {
  data: Candle[];
  height?: number;
  symbol?: string | null;
  price?: number | null;
  className?: string;
}

export const PriceChart: React.FC<PriceChartProps> = ({
  data, height = 320, symbol, price, className,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const seriesRef = useRef<ISeriesApi<'Candlestick'> | null>(null);

  const sortedData = useCallback(() => [...data].sort((a, b) => a.time.localeCompare(b.time)).map(d => ({
    time: d.time,
    open: d.open,
    high: d.high,
    low: d.low,
    close: d.close,
  })), [data]);

  useEffect(() => {
    if (!containerRef.current) return;
    const chart = createChart(containerRef.current, {
      height,
      autoSize: true,
      layout: {
        background: { type: ColorType.Solid, color: '#050508' },
        textColor: '#cbd5e1',
      },
      grid: {
        vertLines: { color: '#1e293b' },
        horzLines: { color: '#1e293b' },
      },
      crosshair: {
        mode: 1,
        vertLine: { color: '#6366f1', width: 1, style: 2 },
        horzLine: { color: '#6366f1', width: 1, style: 2 },
      },
      rightPriceScale: {
        borderColor: '#1e293b',
        scaleMargins: { top: 0.1, bottom: 0.15 },
      },
      timeScale: {
        borderColor: '#1e293b',
        timeVisible: true,
        secondsVisible: false,
      },
      handleScroll: true,
    });
    const candlestickSeries = chart.addSeries(CandlestickSeries, {
      upColor: '#10b981',
      downColor: '#f43f5e',
      borderVisible: false,
      wickUpColor: '#10b981',
      wickDownColor: '#f43f5e',
    });
    candlestickSeries.setData(sortedData() as unknown as CandlestickData[]);
    chart.timeScale().fitContent();
    chartRef.current = chart;
    seriesRef.current = candlestickSeries;

    return () => {
      chart.remove();
      chartRef.current = null;
      seriesRef.current = null;
    };
  }, [height]);

  useEffect(() => {
    const chart = chartRef.current;
    const series = seriesRef.current;
    if (!chart || !series) return;
    series.setData(sortedData() as unknown as CandlestickData[]);
  }, [data, sortedData]);

  return (
    <div className={cn('relative w-full', className)}>
      <div ref={containerRef} className="w-full h-full bg-[#050508] rounded-lg border border-slate-800/50" />
    </div>
  );
};

export default PriceChart;
