import React, { useState } from 'react';
import { Calculator, ShieldAlert, Target, Percent } from 'lucide-react';

const FONT_DISPLAY = "'Rajdhani', sans-serif";
const FONT_MONO = "'Space Mono', monospace";
const amber = '#f97316';
const emerald = '#22c55e';
const rose = '#ef4444';

export const V1TradeRiskCalculatorWidget: React.FC<{
  initialEntry?: number;
  symbol?: string;
}> = ({ initialEntry = 1000, symbol = 'NIFTY STOCK' }) => {
  const [portfolioSize, setPortfolioSize] = useState<number>(500000);
  const [riskPct, setRiskPct] = useState<number>(1.5);
  const [entryPrice, setEntryPrice] = useState<number>(initialEntry);
  const [stopLossPct, setStopLossPct] = useState<number>(3.0);

  const maxRiskRupees = (portfolioSize * riskPct) / 100;
  const stopLossPrice = entryPrice * (1 - stopLossPct / 100);
  const riskPerShare = Math.max(0.1, entryPrice - stopLossPrice);
  const recommendedQty = Math.floor(maxRiskRupees / riskPerShare);
  const totalPositionVal = recommendedQty * entryPrice;
  const target12Price = entryPrice + riskPerShare * 2;
  const target13Price = entryPrice + riskPerShare * 3;

  return (
    <div className="glass border border-slate-800/50 rounded-xl p-4 shadow-md space-y-3">
      <div className="flex items-center justify-between border-b border-slate-800/60 pb-2">
        <div className="flex items-center gap-2">
          <Calculator size={16} style={{ color: amber }} />
          <span style={{ fontFamily: FONT_MONO, fontSize: 10, letterSpacing: 2, color: amber, textTransform: 'uppercase' }}>
            POSITION SIZING & RISK CALCULATOR
          </span>
        </div>
        <span style={{ fontFamily: FONT_DISPLAY, fontSize: 12, fontWeight: 700, color: '#94a3b8' }}>
          {symbol}
        </span>
      </div>

      {/* Input Controls Grid */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 text-xs">
        <div>
          <label style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>PORTFOLIO (₹)</label>
          <input
            type="number"
            value={portfolioSize}
            onChange={e => setPortfolioSize(Number(e.target.value))}
            className="w-full bg-slate-900 border border-slate-700 rounded p-1.5 font-mono text-slate-100 text-xs focus:border-amber-500 outline-none"
          />
        </div>
        <div>
          <label style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>RISK / TRADE (%)</label>
          <input
            type="number"
            step="0.5"
            value={riskPct}
            onChange={e => setRiskPct(Number(e.target.value))}
            className="w-full bg-slate-900 border border-slate-700 rounded p-1.5 font-mono text-slate-100 text-xs focus:border-amber-500 outline-none"
          />
        </div>
        <div>
          <label style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>ENTRY PRICE (₹)</label>
          <input
            type="number"
            value={entryPrice}
            onChange={e => setEntryPrice(Number(e.target.value))}
            className="w-full bg-slate-900 border border-slate-700 rounded p-1.5 font-mono text-slate-100 text-xs focus:border-amber-500 outline-none"
          />
        </div>
        <div>
          <label style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>STOP LOSS (%)</label>
          <input
            type="number"
            step="0.5"
            value={stopLossPct}
            onChange={e => setStopLossPct(Number(e.target.value))}
            className="w-full bg-slate-900 border border-slate-700 rounded p-1.5 font-mono text-slate-100 text-xs focus:border-amber-500 outline-none"
          />
        </div>
      </div>

      {/* Output Results Cards */}
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2 pt-2 border-t border-slate-800">
        <div className="p-2 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>SUGGESTED SHARES</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: amber }}>
            {recommendedQty.toLocaleString()} Qty
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#94a3b8' }}>Val: ₹{(totalPositionVal / 1000).toFixed(1)}k</span>
        </div>

        <div className="p-2 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>MAX RUPEE RISK</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: rose }}>
            ₹{maxRiskRupees.toFixed(0)}
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#94a3b8' }}>{riskPct}% of capital</span>
        </div>

        <div className="p-2 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>STOP LOSS (EXIT)</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: rose }}>
            ₹{stopLossPrice.toFixed(1)}
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#94a3b8' }}>-{stopLossPct}% limit</span>
        </div>

        <div className="p-2 rounded bg-slate-900/60 border border-slate-800">
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#64748b' }}>TARGET 1:2 R:R</span>
          <div style={{ fontFamily: FONT_MONO, fontSize: 14, fontWeight: 700, color: emerald }}>
            ₹{target12Price.toFixed(1)}
          </div>
          <span style={{ fontFamily: FONT_MONO, fontSize: 8, color: '#94a3b8' }}>+{(stopLossPct * 2).toFixed(1)}% profit</span>
        </div>
      </div>
    </div>
  );
};
