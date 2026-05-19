import React, { useState } from 'react';
import { 
  BarChart3, Layers, ChevronDown, ChevronUp
} from 'lucide-react';
import { MCStockInfoPanel } from '../MCStockInfoPanel';
import stockData from '../../data/stocklist';

interface MCDeepDiveStationProps {
  symbol: string;
  onSelectStock?: (symbol: string) => void;
}

type SectionKey = 'all' | 'overview' | 'fundamental' | 'technical' | 'insights' | 'shareholding' | 'trendlyne';

const SECTIONS: { key: SectionKey; label: string; desc: string }[] = [
  { key: 'all',          label: 'Full Analysis',   desc: 'Complete deep-dive with all tabs' },
  { key: 'overview',     label: 'Overview',         desc: 'Scores, key stats & signals' },
  { key: 'fundamental',  label: 'Financials',       desc: 'Valuation, returns & forecasts' },
  { key: 'technical',    label: 'Technical',        desc: 'Charts, indicators & pivots' },
  { key: 'insights',     label: 'Analysis',         desc: 'SWOT, strengths & risks' },
  { key: 'shareholding', label: 'Shareholding',     desc: 'Ownership patterns & FII/DII' },
  { key: 'trendlyne',    label: 'Trendlyne',        desc: 'RSI, MACD, momentum & MFI' },
];

export const MCDeepDiveStation: React.FC<MCDeepDiveStationProps> = ({ symbol, onSelectStock }) => {
  const [activeSection, setActiveSection] = useState<SectionKey>('all');
  const [isCollapsed, setIsCollapsed] = useState(false);

  const stockMapping = stockData.find(s => s.symbol.toUpperCase() === symbol.toUpperCase());
  const scId = stockMapping?.mcsymbol || symbol;

  return (
    <div className="bg-slate-900/50 border border-white/[0.06] rounded-3xl shadow-2xl relative overflow-hidden backdrop-blur-2xl">
      {/* Decorative glow */}
      <div className="absolute top-0 left-0 w-[200px] h-[100px] bg-violet-500/5 rounded-full blur-[60px] pointer-events-none" />
      
      {/* Header */}
      <div className="flex items-center justify-between px-6 py-4 border-b border-white/[0.04]">
        <div className="flex items-center gap-3">
          <div className="w-9 h-9 rounded-xl bg-violet-500/10 flex items-center justify-center border border-violet-500/20 shadow-md">
            <Layers className="w-4.5 h-4.5 text-violet-400" />
          </div>
          <div>
            <h3 className="text-sm font-black text-white tracking-widest uppercase italic flex items-center gap-2">
              Deep Dive Station
              <span className="text-[8px] font-black text-violet-400 bg-violet-500/10 border border-violet-500/20 px-1.5 py-0.5 rounded tracking-widest">
                MC + TB + TL
              </span>
            </h3>
            <p className="text-[10px] font-bold text-slate-500 tracking-wider uppercase">
              MoneyControl · TradeBrains · Trendlyne Intelligence
            </p>
          </div>
        </div>

        <button 
          onClick={() => setIsCollapsed(!isCollapsed)}
          className="p-2 rounded-xl bg-slate-950/60 border border-white/[0.04] hover:border-violet-500/20 transition-all text-slate-400 hover:text-violet-400"
        >
          {isCollapsed ? <ChevronDown className="w-4 h-4" /> : <ChevronUp className="w-4 h-4" />}
        </button>
      </div>

      {!isCollapsed && (
        <>
          {/* Section Selector Pills */}
          <div className="px-6 py-3 border-b border-white/[0.04] overflow-x-auto hide-scrollbar">
            <div className="flex gap-1.5">
              {SECTIONS.map(sec => (
                <button
                  key={sec.key}
                  onClick={() => setActiveSection(sec.key)}
                  className={`px-3 py-1.5 rounded-xl text-[9px] font-black uppercase tracking-widest whitespace-nowrap transition-all ${
                    activeSection === sec.key
                      ? 'bg-violet-600 text-white shadow-lg shadow-violet-500/20'
                      : 'text-slate-500 hover:text-slate-300 bg-slate-950/40 border border-white/[0.03] hover:border-violet-500/20'
                  }`}
                  title={sec.desc}
                >
                  {sec.label}
                </button>
              ))}
            </div>
          </div>

          {/* MC Panel Content */}
          <div className="p-5">
            <MCStockInfoPanel 
              symbol={symbol}
              scId={scId}
              section={activeSection}
              onSelectStock={onSelectStock}
            />
          </div>
        </>
      )}
    </div>
  );
};

export default MCDeepDiveStation;
