import React, { useState } from 'react';
import { SmartMoneySentiment } from '../../components/v2/SmartMoneySentiment';
import { SentimentIntelligence } from '../../components/SentimentIntelligence';
import { Search, Flame } from 'lucide-react';

const SentimentPage: React.FC = () => {
  const [symbol, setSymbol] = useState<string>('RELIANCE');
  const [searchInput, setSearchInput] = useState<string>('');

  const handleSearch = (e: React.FormEvent) => {
    e.preventDefault();
    if (searchInput.trim()) {
      setSymbol(searchInput.trim().toUpperCase());
      setSearchInput('');
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out">
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-4">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            News & Smart Money Sentiment
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            FinBERT-powered news analysis and FII/DII flow tracking.
          </p>
        </div>

        <form onSubmit={handleSearch} className="relative w-full sm:w-64">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 w-4 h-4 text-slate-400" />
          <input
            type="text"
            placeholder="Analyze symbol (e.g. INFY)"
            value={searchInput}
            onChange={(e) => setSearchInput(e.target.value)}
            className="w-full bg-slate-900 border border-slate-800 rounded-lg py-2 pl-9 pr-4 text-sm text-slate-200 focus:outline-none focus:border-indigo-500 focus:ring-1 focus:ring-indigo-500 placeholder-slate-500"
          />
        </form>
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        {/* Left Col: Stock Specific Sentiment */}
        <div className="xl:col-span-1 space-y-6">
          <SmartMoneySentiment symbol={symbol} />
          
          <div className="bg-slate-900/50 backdrop-blur-md border border-slate-800/80 rounded-2xl p-6">
             <div className="flex items-center gap-2 mb-4">
                <Flame className="w-5 h-5 text-orange-500" />
                <h3 className="text-sm font-bold text-slate-200">Why {symbol}?</h3>
             </div>
             <p className="text-xs text-slate-400 leading-relaxed italic">
               The Smart Money Sentiment model uses advanced FinBERT sequence classification to extract nuanced sentiment from recent news articles related to {symbol}. FII/DII data provides the macro flow context.
             </p>
          </div>
        </div>

        {/* Right Col: General News / Intelligence */}
        <div className="xl:col-span-2 space-y-6">
          <SentimentIntelligence onSelectStock={() => {}} />
        </div>
      </div>
    </div>
  );
};

export default SentimentPage;
