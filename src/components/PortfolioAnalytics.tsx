import React, { useState } from 'react';
import { trpc } from '../lib/trpc';
import { Card } from './Card';
import { Target, TrendingUp, Activity, BarChart2 } from 'lucide-react';

export default function PortfolioAnalytics() {
  const [symbolsInput, setSymbolsInput] = useState('RELIANCE, TCS, HDFCBANK, INFY');
  
  const analyzeMutation = trpc.analyzePortfolio.useMutation();

  const handleAnalyze = () => {
    const symbols = symbolsInput.split(',').map(s => s.trim().toUpperCase()).filter(s => s);
    if (symbols.length === 0) return;

    // Equal weights for now
    const weights = symbols.map(() => 1 / symbols.length);

    analyzeMutation.mutate({ symbols, weights });
  };

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-2xl font-bold bg-clip-text text-transparent bg-gradient-to-r from-emerald-400 to-indigo-500">
          Portfolio Analytics
        </h2>
        <p className="text-slate-400 text-sm mt-1">Calculate risk metrics and correlation matrices for a custom portfolio.</p>
      </div>

      <Card className="p-6 bg-slate-900 border border-white/10">
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1">
            <label className="block text-sm font-medium text-slate-400 mb-2">Portfolio Symbols (comma-separated)</label>
            <input 
              type="text" 
              value={symbolsInput}
              onChange={(e) => setSymbolsInput(e.target.value)}
              className="w-full bg-slate-800 border border-slate-700 rounded-lg px-4 py-2 text-white focus:outline-none focus:ring-2 focus:ring-indigo-500"
              placeholder="e.g. RELIANCE, TCS, INFY"
            />
          </div>
          <button 
            onClick={handleAnalyze}
            disabled={analyzeMutation.isPending}
            className="px-6 py-2 bg-indigo-600 hover:bg-indigo-700 text-white rounded-lg font-medium transition-colors disabled:opacity-50"
          >
            {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze Portfolio'}
          </button>
        </div>
      </Card>

      {analyzeMutation.error && (
        <div className="p-4 bg-rose-900/20 text-rose-400 border border-rose-500/20 rounded-lg">
          Error: {analyzeMutation.error.message}
        </div>
      )}

      {analyzeMutation.data && !analyzeMutation.data.error && (
        <div className="space-y-6">
          <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-4 gap-4">
            <Card className="p-5 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
              <div className="flex items-center space-x-3 text-slate-400 mb-2">
                <Target className="w-5 h-5 text-indigo-400" />
                <h3 className="font-medium">Sharpe Ratio</h3>
              </div>
              <div className="text-3xl font-bold text-white">
                {analyzeMutation.data.sharpe_ratio}
              </div>
              <div className="text-xs text-slate-500 mt-1">Risk-adjusted return vs Nifty 50</div>
            </Card>

            <Card className="p-5 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
              <div className="flex items-center space-x-3 text-slate-400 mb-2">
                <Activity className="w-5 h-5 text-orange-400" />
                <h3 className="font-medium">Portfolio Beta</h3>
              </div>
              <div className="text-3xl font-bold text-white">
                {analyzeMutation.data.beta}
              </div>
              <div className="text-xs text-slate-500 mt-1">Volatility relative to market</div>
            </Card>

            <Card className="p-5 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
              <div className="flex items-center space-x-3 text-slate-400 mb-2">
                <TrendingUp className="w-5 h-5 text-emerald-400" />
                <h3 className="font-medium">Ann. Return</h3>
              </div>
              <div className="text-3xl font-bold text-white">
                {(analyzeMutation.data.annualized_return * 100).toFixed(2)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Expected yearly return</div>
            </Card>

            <Card className="p-5 bg-gradient-to-br from-slate-800 to-slate-900 border border-white/5">
              <div className="flex items-center space-x-3 text-slate-400 mb-2">
                <BarChart2 className="w-5 h-5 text-rose-400" />
                <h3 className="font-medium">VaR (95%)</h3>
              </div>
              <div className="text-3xl font-bold text-white">
                {(analyzeMutation.data.var_95 * 100).toFixed(2)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Max daily loss (95% confidence)</div>
            </Card>
          </div>

          <Card className="p-6 bg-slate-900 border border-white/5">
            <h3 className="text-lg font-bold text-white mb-4">Correlation Matrix</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left text-slate-400">
                <thead className="text-xs text-slate-300 uppercase bg-slate-800">
                  <tr>
                    <th className="px-6 py-3 rounded-tl-lg">Symbol</th>
                    {Object.keys(analyzeMutation.data.correlation_matrix || {}).map(sym => (
                      <th key={sym} className="px-6 py-3">{sym}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {Object.entries(analyzeMutation.data.correlation_matrix || {}).map(([rowSym, cols]: [string, any]) => (
                    <tr key={rowSym} className="border-b border-slate-800">
                      <td className="px-6 py-4 font-medium text-white">{rowSym}</td>
                      {Object.keys(analyzeMutation.data.correlation_matrix || {}).map(colSym => {
                        const val = cols[colSym];
                        const isHigh = val > 0.7 && rowSym !== colSym;
                        const isLow = val < 0.3;
                        return (
                          <td key={colSym} className={`px-6 py-4 font-data ${isHigh ? 'text-rose-400' : isLow ? 'text-emerald-400' : 'text-slate-400'}`}>
                            {val.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </div>
      )}
    </div>
  );
}
