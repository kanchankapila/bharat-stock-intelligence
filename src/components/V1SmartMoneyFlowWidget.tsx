import React from 'react';
import { Activity, ArrowUpRight, ShieldCheck, DollarSign } from 'lucide-react';
import { trpc } from '../lib/trpc';

const FONT_DISPLAY = "'Rajdhani', sans-serif";
const FONT_MONO = "'Space Mono', monospace";
const amber = '#f97316';
const emerald = '#22c55e';
const rose = '#ef4444';

export const V1SmartMoneyFlowWidget: React.FC<{
  onSelectStock: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const { data: flows } = trpc.getInstitutionalFlows.useQuery();
  const { data: topPicks } = trpc.getTopRatedStocks.useQuery({ limit: 6 });

  const instList = flows?.data?.institutionalDetails ?? [];

  return (
    <div className="glass border border-slate-800/50 rounded-xl p-4 shadow-md space-y-3">
      {/* Title */}
      <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-2">
          <DollarSign size={16} style={{ color: emerald }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 2, color: emerald, textTransform: 'uppercase' }}>
            INSTITUTIONAL & SMART MONEY MONITOR
          </span>
        </div>
      </div>

      {/* Institutional Flow Cards */}
      <div className="grid grid-cols-2 gap-2">
        {instList.map((item, idx) => {
          const val = Number(item.netBuySell ?? 0);
          const isPos = val >= 0;
          return (
            <div key={idx} className="p-2.5 rounded-lg bg-slate-900/60 border border-slate-800 flex flex-col justify-between">
              <div className="flex items-center justify-between">
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#94a3b8' }}>{item.category}</span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>{item.date}</span>
              </div>
              <div className="mt-1">
                <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700 }} className={isPos ? 'text-emerald-400' : 'text-rose-400'}>
                  {isPos ? '+' : ''}{item.netBuySell} Cr
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>
                  Buy: ₹{item.buyValue}Cr | Sell: ₹{item.sellValue}Cr
                </div>
              </div>
            </div>
          );
        })}
      </div>

      {/* High Delivery / Smart Money Picks */}
      <div>
        <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: amber, letterSpacing: 1 }} className="mb-2 uppercase">
          HIGH DELIVERY & QUANT QUALITY PICKS
        </div>
        <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
          {topPicks?.slice(0, 6).map((stock: any) => (
            <div
              key={stock.symbol ?? stock.id}
              onClick={() => stock.symbol && onSelectStock(stock.symbol)}
              className="p-2 rounded bg-slate-900/40 border border-slate-800/80 hover:border-emerald-500/40 transition-colors cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <span style={{ fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>
                  {stock.symbol}
                </span>
                <ArrowUpRight size={12} className="text-emerald-400" />
              </div>
              <div className="flex items-baseline justify-between mt-1">
                <span style={{ fontFamily: FONT_MONO, fontSize: 11, color: '#cbd5e1' }}>
                  {stock.timeframe ? stock.timeframe : 'SWING'}
                </span>
                <span style={{ fontFamily: FONT_MONO, fontSize: 9, color: emerald }}>
                  Score {stock.score ?? 85}
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
