import React from 'react';
import { Activity, Magnet, Repeat, AlertCircle } from 'lucide-react';
import { trpc } from '../lib/trpc';

const FONT_DISPLAY = "'Rajdhani', sans-serif";
const FONT_MONO = "'Space Mono', monospace";
const amber = '#f97316';
const emerald = '#22c55e';
const rose = '#ef4444';

export const V1FnOMicrostructureWidget: React.FC<{
  onSelectStock: (symbol: string) => void;
}> = ({ onSelectStock }) => {
  const { data: maxPainAlerts } = trpc.getMaxPainAlerts.useQuery();
  const { data: rollovers } = trpc.getRolloverPositioning.useQuery();

  return (
    <div className="glass border border-slate-800/50 rounded-xl p-4 shadow-md space-y-4">
      {/* Title */}
      <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-2">
          <Activity size={16} style={{ color: amber }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 2, color: amber, textTransform: 'uppercase' }}>
            DERIVATIVES & OPTION MICROSTRUCTURE
          </span>
        </div>
      </div>

      {/* Max Pain Magnet Alerts */}
      <div className="space-y-2">
        <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#94a3b8' }}>
          <Magnet size={12} className="text-amber-400" />
          <span>MAX PAIN MAGNET REVERSION TARGETS</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
          {maxPainAlerts?.slice(0, 4).map((item, idx) => (
            <div
              key={`${item.symbol}-${idx}`}
              onClick={() => onSelectStock(item.symbol)}
              className="p-2 rounded-lg bg-slate-900/60 border border-slate-800/80 hover:border-amber-500/40 transition-colors cursor-pointer flex items-center justify-between"
            >
              <div>
                <div style={{ fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: 700, color: '#f1f5f9' }}>
                  {item.symbol}
                </div>
                <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#64748b' }}>
                  LTP: ₹{item.ltp?.toFixed(1)} | Pain: ₹{item.maxPain?.toFixed(1)}
                </div>
              </div>
              <div className="text-right">
                <span className={`text-[9px] font-mono px-1.5 py-0.5 rounded border ${
                  item.diffPct > 0 ? 'bg-rose-500/15 text-rose-300 border-rose-500/30' : 'bg-emerald-500/15 text-emerald-300 border-emerald-500/30'
                }`}>
                  {item.diffPct > 0 ? '+' : ''}{item.diffPct.toFixed(1)}% Gap
                </span>
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Rollover & Positioning proxy */}
      <div className="space-y-2 pt-1 border-t border-slate-800/50">
        <div className="flex items-center gap-1.5" style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#94a3b8' }}>
          <Repeat size={12} className="text-indigo-400" />
          <span>SHORT ROLLOVER & POSITIONING PROXY</span>
        </div>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-2">
          {rollovers?.slice(0, 3).map((item, idx) => (
            <div
              key={`${item.symbol}-${idx}`}
              onClick={() => onSelectStock(item.symbol)}
              className="p-2 rounded bg-slate-900/40 border border-slate-800 flex flex-col justify-between cursor-pointer"
            >
              <div className="flex items-center justify-between">
                <span style={{ fontFamily: FONT_DISPLAY, fontSize: 11, fontWeight: 700, color: '#f1f5f9' }}>{item.symbol}</span>
                <span className={`text-[8px] font-mono px-1 rounded ${
                  item.positioning === 'SHORT_ROLL' ? 'bg-rose-500/20 text-rose-300' :
                  item.positioning === 'LONG_ROLL' ? 'bg-emerald-500/20 text-emerald-300' : 'bg-slate-700 text-slate-300'
                }`}>
                  {item.positioning}
                </span>
              </div>
              <div style={{ fontFamily: FONT_MONO, fontSize: 9, color: '#94a3b8' }} className="mt-1">
                Rollover: {item.rollover_pct?.toFixed(1)}%
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
