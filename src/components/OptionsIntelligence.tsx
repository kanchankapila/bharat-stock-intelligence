import { trpc } from '../lib/trpc';
import { RefreshCw, AlertCircle } from 'lucide-react';
import { cn } from '../lib/utils';

export default function OptionsIntelligence() {
  const { data: pcrData, isLoading, error, refetch } = trpc.getOptionsIntelligence.useQuery(undefined, {
    refetchInterval: 60000,
  });
  const fetchPcr = trpc.runPcrFetch.useMutation({ onSuccess: () => refetch() });

  if (isLoading) {
    return <div className="text-slate-400 p-8 text-center animate-pulse">Loading Options Intelligence...</div>;
  }

  if (error) {
    return <div className="text-rose-400 p-8 text-center">Error loading PCR data: {error.message}</div>;
  }

  if (!pcrData || pcrData.length === 0) {
    return (
      <div className="flex flex-col items-center gap-4 p-12 text-center">
        <AlertCircle className="w-12 h-12 text-slate-500" />
        <div>
          <p className="text-slate-300 font-medium mb-1">No PCR data available</p>
          <p className="text-slate-500 text-sm">Click below to fetch live Put-Call Ratio data from NSE via the Python engine.</p>
          <p className="text-slate-600 text-xs mt-1">Requires the Python backend to be running on port 8000.</p>
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
          <p className="text-rose-400 text-xs">{fetchPcr.data.error}</p>
        )}
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between">
        <div>
          <h2 className="text-2xl font-bold text-white font-display">
            Options Intelligence
          </h2>
          <p className="text-slate-400 text-sm mt-1">Live Put-Call Ratios for Nifty 50 constituents.</p>
        </div>
        <button
          onClick={() => fetchPcr.mutate({})}
          disabled={fetchPcr.isPending}
          className="flex items-center gap-2 px-3 py-1.5 rounded-lg bg-slate-800 hover:bg-slate-700 disabled:opacity-50 text-slate-300 text-sm transition-colors"
        >
          <RefreshCw className={`w-3.5 h-3.5 ${fetchPcr.isPending ? 'animate-spin' : ''}`} />
          {fetchPcr.isPending ? 'Refreshing…' : 'Refresh'}
        </button>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-4">
        {pcrData.map((item: any, idx: number) => {
          const pcrValue = parseFloat(item.pcr);
          let pcrColor = 'text-slate-300';
          let cardClass = 'v1-card-neutral';
          let statusText = 'Neutral';

          if (pcrValue > 1.5) {
            pcrColor = 'text-emerald-400';
            cardClass = 'v1-card-up';
            statusText = 'Oversold (Bullish)';
          } else if (pcrValue < 0.6) {
            pcrColor = 'text-rose-400';
            cardClass = 'v1-card-down';
            statusText = 'Overbought (Bearish)';
          } else if (pcrValue >= 1.0 && pcrValue <= 1.5) {
            pcrColor = 'text-emerald-400';
            cardClass = 'v1-card-up';
            statusText = 'Mildly Bullish';
          } else if (pcrValue >= 0.6 && pcrValue < 1.0) {
            pcrColor = 'text-orange-400';
            cardClass = 'v1-card-neutral';
            statusText = 'Mildly Bearish';
          }

          return (
            <div key={`${item.symbol}-${idx}`} className={cn(cardClass, 'p-4')}>
              <div className="flex justify-between items-start mb-4">
                <div>
                  <h3 className="font-semibold text-lg text-white">{item.symbol}</h3>
                  <div className="text-xs text-slate-500">Exp: {item.expiry || 'N/A'}</div>
                </div>
                <div className={`text-right ${pcrColor}`}>
                  <div className="text-2xl font-bold">{pcrValue.toFixed(2)}</div>
                  <div className="text-xs font-display uppercase tracking-wider">{statusText}</div>
                </div>
              </div>

              <div className="space-y-2 text-sm">
                <div className="flex justify-between">
                  <span className="text-slate-400">Total Call OI:</span>
                  <span className="text-slate-200">{item.total_call_oi?.toLocaleString() || '0'}</span>
                </div>
                <div className="flex justify-between">
                  <span className="text-slate-400">Total Put OI:</span>
                  <span className="text-slate-200">{item.total_put_oi?.toLocaleString() || '0'}</span>
                </div>
                <div className="flex justify-between pt-2 mt-2 border-t border-white/5">
                  <span className="text-slate-400">Market PCR:</span>
                  <span className="text-slate-200">{item.market_pcr ? parseFloat(item.market_pcr).toFixed(2) : 'N/A'}</span>
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
