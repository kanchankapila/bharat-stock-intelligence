import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { RefreshCw, AlertCircle } from 'lucide-react';

export default function OptionsIntelligence() {
  const { data: pcrData, isLoading, error, refetch } = trpc.getOptionsIntelligence.useQuery(undefined, {
    refetchInterval: 60000,
  });
  const fetchPcr = trpc.runPcrFetch.useMutation({ onSuccess: () => refetch() });

  if (isLoading) {
    return <div className="text-gray-400 p-8 text-center animate-pulse">Loading Options Intelligence...</div>;
  }

  if (error) {
    return <div className="text-red-400 p-8 text-center">Error loading PCR data: {error.message}</div>;
  }

  if (!pcrData || pcrData.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <AlertCircle className="w-12 h-12 text-gray-500" />
        <div>
          <p className="text-gray-300 font-medium mb-1">No PCR data available</p>
          <p className="text-gray-500 text-sm">Click below to fetch live Put-Call Ratio data from NSE via the Python engine.</p>
          <p className="text-gray-600 text-xs mt-1">Requires the Python backend to be running on port 8000.</p>
        </div>
        <button
          onClick={() => fetchPcr.mutate({})}
          disabled={fetchPcr.isPending}
          className="flex items-center gap-2 px-5 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 disabled:opacity-50 disabled:cursor-not-allowed text-white text-sm font-medium transition-colors"
        >
          <RefreshCw className={`w-4 h-4 ${fetchPcr.isPending ? 'animate-spin' : ''}`} />
          {fetchPcr.isPending ? 'Fetching…' : 'Fetch PCR Data'}
        </button>
        {fetchPcr.data && !fetchPcr.data.success && (
          <p className="text-red-400 text-xs">{fetchPcr.data.error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-purple-400 to-cyan-400">
            Options Intelligence
          </h2>
          <p className="text-gray-400 text-sm mt-1">Live Put-Call Ratios for Nifty 50 constituents.</p>
        </div>
        <button
          onClick={() => fetchPcr.mutate({})}
          disabled={fetchPcr.isPending}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-gray-800 hover:bg-gray-700 disabled:opacity-50 text-gray-300 text-sm transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${fetchPcr.isPending ? 'animate-spin' : ''}`} />
          {fetchPcr.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {pcrData.map((item: any, idx: number) => {
          const pcrValue = parseFloat(item.pcr);
          let pcrColor = 'text-gray-300';
          let bgColor = 'bg-gray-800/50';
          let statusText = 'Neutral';

          if (pcrValue > 1.5) {
            pcrColor = 'text-emerald-400';
            bgColor = 'bg-emerald-900/20';
            statusText = 'Oversold (Bullish)';
          } else if (pcrValue < 0.6) {
            pcrColor = 'text-red-400';
            bgColor = 'bg-red-900/20';
            statusText = 'Overbought (Bearish)';
          } else if (pcrValue >= 1.0 && pcrValue <= 1.5) {
            pcrColor = 'text-green-400';
            statusText = 'Mildly Bullish';
          } else if (pcrValue >= 0.6 && pcrValue < 1.0) {
            pcrColor = 'text-orange-400';
            statusText = 'Mildly Bearish';
          }

          return (
            <Card key={`${item.symbol}-${idx}`} className={`p-4 ${bgColor} border border-white/5`}>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-semibold text-lg text-white">{item.symbol}</h3>
                  <div className="text-xs text-gray-500">Exp: {item.expiry || 'N/A'}</div>
                </div>
                <div className={`text-right ${pcrColor}`}>
                  <div className="text-2xl font-bold">{pcrValue.toFixed(2)}</div>
                  <div className="text-xs uppercase tracking-wider">{statusText}</div>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Call OI:</span>
                  <span className="text-gray-200">{item.total_call_oi?.toLocaleString() || '0'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-gray-400">Total Put OI:</span>
                  <span className="text-gray-200">{item.total_put_oi?.toLocaleString() || '0'}</span>
                </div>
                <div className="flex justify-between pt-2 mt-2 border-t border-white/5">
                  <span className="text-gray-400">Market PCR:</span>
                  <span className="text-gray-200">{item.market_pcr ? parseFloat(item.market_pcr).toFixed(2) : 'N/A'}</span>
                </div>
              </div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
