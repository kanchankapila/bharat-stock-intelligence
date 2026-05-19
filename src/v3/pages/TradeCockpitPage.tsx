import React, { useState } from 'react';
import { V3AIDecisionWidget } from '../components/trade/V3AIDecisionWidget';
import { V3QuantChartWidget } from '../components/trade/V3QuantChartWidget';
import { V3QuantRadarWidget } from '../components/trade/V3QuantRadarWidget';
import { V3QuantSwotWidget } from '../components/trade/V3QuantSwotWidget';
import { Search } from 'lucide-react';

interface TradeCockpitPageProps {
  initialSymbol?: string;
}

const TradeCockpitPage: React.FC<TradeCockpitPageProps> = ({ initialSymbol }) => {
  const [symbol, setSymbol] = useState<string>(initialSymbol ?? 'RELIANCE');
  const [searchInput, setSearchInput] = useState<string>('');

  React.useEffect(() => {
    if (initialSymbol) setSymbol(initialSymbol);
  }, [initialSymbol]);

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSymbol(searchInput.trim().toUpperCase());
      setSearchInput('');
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            Trade Cockpit
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Deep Neural Scoring & Execution for {symbol}
          </p>
        </div>

        <form onSubmit={handleSearch} className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Search symbol (e.g. RELIANCE)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 pl-9 pr-4 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder-slate-500 transition-colors"
          />
        </form>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Main Left Column (Chart & Decisions) */}
        <div className="lg:col-span-2 space-y-6">
          <V3AIDecisionWidget symbol={symbol} />
          <V3QuantChartWidget symbol={symbol} />
        </div>

        {/* Right Column (Radar & SWOT) */}
        <div className="lg:col-span-1 space-y-6">
          <V3QuantRadarWidget symbol={symbol} />
          <V3QuantSwotWidget symbol={symbol} />
        </div>
      </div>
    </div>
  );
};

export default TradeCockpitPage;
