import React, { useState } from 'react';
import { MarketOverviewWidget } from '../components/widgets/MarketOverviewWidget';
import { TopMoversWidget } from '../components/widgets/TopMoversWidget';
import { ScreenerWidget } from '../components/widgets/ScreenerWidget';
import { DerivativesIntelligenceWidget } from '../components/widgets/DerivativesIntelligenceWidget';
import { FiiDiiStrip } from '../components/widgets/FiiDiiStrip';
import { cn } from '../../lib/utils';

const DashboardPage: React.FC = () => {
  const [fnoSymbol, setFnoSymbol] = useState<'NIFTY 50' | 'BANKNIFTY'>('NIFTY 50');

  return (
    <div className="space-y-8 animate-fade-in">
      <div className="space-y-2">
        <h2 className="text-3xl font-bold text-slate-50 tracking-tight">Market Intelligence</h2>
        <p className="text-slate-500 text-base">Real-time quantitative edge for Indian markets</p>
      </div>

      {/* Indices overview */}
      <div className="animate-slide-up" style={{ animationDelay: '0.1s' }}>
        <MarketOverviewWidget />
      </div>

      {/* FII/DII Smart Money strip */}
      <div className="animate-slide-up" style={{ animationDelay: '0.2s' }}>
        <FiiDiiStrip />
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        {/* Market Movers */}
        <div className="lg:col-span-1 h-[400px] animate-slide-up" style={{ animationDelay: '0.3s' }}>
          <TopMoversWidget />
        </div>

        {/* Derivatives Intelligence */}
        <div className="lg:col-span-2 space-y-4 animate-slide-up" style={{ animationDelay: '0.4s' }}>
          <div className="flex items-center gap-2">
            {(['NIFTY 50', 'BANKNIFTY'] as const).map(sym => (
              <button
                key={sym}
                onClick={() => setFnoSymbol(sym)}
                className={cn(
                  'px-4 py-2 text-sm font-semibold rounded-lg interactive-base',
                  fnoSymbol === sym
                    ? 'bg-indigo-500/15 text-indigo-300 glow-accent border glass-border'
                    : 'text-slate-400 hover:text-slate-200 bg-slate-800/30 border glass-border'
                )}
              >
                {sym}
              </button>
            ))}
          </div>
          <div className="h-[352px]">
            <DerivativesIntelligenceWidget symbol={fnoSymbol} />
          </div>
        </div>
      </div>

      {/* Stock Discovery / Screeners */}
      <div className="animate-slide-up" style={{ animationDelay: '0.5s' }}>
        <ScreenerWidget />
      </div>
    </div>
  );
};

export default DashboardPage;
