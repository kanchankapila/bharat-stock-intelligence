
import React from 'react';

import { AgentStrategyPickCard } from './AgentStrategyPickCard';

import { ConfluenceSignalCard } from './ConfluenceSignalCard';
import { DLPredictionCard } from './DLPredictionCard';

interface AiInsightsTabProps {
  insights: any; // TODO: Define a proper type for the insights
}

export const AiInsightsTab: React.FC<AiInsightsTabProps> = ({ insights }) => {
  if (!insights) {
    return <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl text-slate-400">Loading AI insights...</div>;
  }

  const { agentPicks, dlPredictions, confluenceSignals } = insights;

  return (
    <div className="space-y-6">
      {/* Agent Strategy Picks */}
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
        <h3 className="text-lg font-bold text-slate-200 mb-4">Agent Strategy Picks</h3>
        {agentPicks?.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {agentPicks.map((pick: any) => (
              <AgentStrategyPickCard key={pick.id} pick={pick} />
            ))}
          </div>
        ) : (
          <p className="text-slate-400">No agent picks available.</p>
        )}
      </div>

      {/* Deep Learning Predictions */}
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
        <h3 className="text-lg font-bold text-slate-200 mb-4">Deep Learning Predictions</h3>
        {dlPredictions?.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {dlPredictions.map((prediction: any) => (
              <DLPredictionCard key={prediction.id} prediction={prediction} />
            ))}
          </div>
        ) : (
          <p className="text-slate-400">No deep learning predictions available.</p>
        )}
      </div>

      {/* Confluence Signals */}
      <div className="p-6 bg-terminal-panel border border-terminal-border rounded-2xl">
        <h3 className="text-lg font-bold text-slate-200 mb-4">Confluence Signals</h3>
        {confluenceSignals?.length > 0 ? (
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
            {confluenceSignals.map((signal: any) => (
              <ConfluenceSignalCard key={signal.id} signal={signal} />
            ))}
          </div>
        ) : (
          <p className="text-slate-400">No confluence signals available.</p>
        )}
      </div>
    </div>
  );
};
