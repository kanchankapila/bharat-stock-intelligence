import React from 'react';
import { V3FnoIntelligenceWidget } from '../components/fno/V3FnoIntelligenceWidget';

const FnoIntelligencePage: React.FC = () => {
  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4 duration-500 ease-out h-full flex flex-col">
      <div className="flex items-center justify-between shrink-0">
        <div>
          <h2 className="text-2xl font-bold text-slate-100 flex items-center gap-2">
            F&O Intelligence Center
          </h2>
          <p className="text-slate-400 text-sm mt-1">
            Real-time derivatives buildup, PCR dynamics, and momentum scoring.
          </p>
        </div>
      </div>
      
      <div className="flex-1 min-h-0">
        <V3FnoIntelligenceWidget onSelectStock={(symbol) => console.log('Navigate to:', symbol)} />
      </div>
    </div>
  );
};

export default FnoIntelligencePage;
