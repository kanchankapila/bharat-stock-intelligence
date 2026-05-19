import React, { useEffect, useRef } from 'react';
import { LineChart } from 'lucide-react';

interface V3QuantChartWidgetProps {
  symbol: string;
}

export const V3QuantChartWidget: React.FC<V3QuantChartWidgetProps> = ({ symbol }) => {
  const container = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!container.current) return;
    container.current.innerHTML = '';
    const script = document.createElement('script');
    script.src = 'https://s3.tradingview.com/tv.js';
    script.async = true;
    script.onload = () => {
      if (typeof window !== 'undefined' && (window as any).TradingView) {
        new (window as any).TradingView.widget({
          autosize: true,
          symbol: `BSE:${symbol}`,
          interval: 'D',
          timezone: 'Asia/Kolkata',
          theme: 'dark',
          style: '1',
          locale: 'in',
          enable_publishing: false,
          backgroundColor: 'rgba(15, 23, 42, 0)',
          gridColor: 'rgba(30, 41, 59, 0.4)',
          hide_top_toolbar: false,
          hide_legend: false,
          save_image: false,
          container_id: container.current?.id,
          studies: [
            'RSI@tv-basicstudies',
            'MASimple@tv-basicstudies',
            'MACD@tv-basicstudies'
          ],
        });
      }
    };
    container.current.appendChild(script);
  }, [symbol]);

  return (
    <div className="bg-slate-900/60 backdrop-blur-xl border border-slate-800 rounded-2xl overflow-hidden h-[500px] flex flex-col shadow-2xl">
      <div className="p-4 border-b border-slate-800/60 flex items-center justify-between bg-slate-800/20">
        <div className="flex items-center gap-2 text-indigo-400">
           <LineChart className="w-5 h-5" />
           <h3 className="font-bold text-sm uppercase tracking-widest">Algorithmic Chart Station</h3>
        </div>
        <div className="flex items-center gap-2">
          <span className="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></span>
          <span className="text-[10px] text-emerald-500 font-bold uppercase tracking-wider">Live</span>
        </div>
      </div>
      <div className="flex-1 w-full" id={`tv_chart_${symbol}`} ref={container} />
    </div>
  );
};
