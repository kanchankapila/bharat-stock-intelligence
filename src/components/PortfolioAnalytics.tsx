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
    <div className="v1-page space-y-6">
      <div className="v1-header">
        <div className="v1-header-left">
          <h1 className="v1-title-page flex items-center gap-2.5">
            <BarChart2 className="w-6 h-6 text-indigo-400" />
            Portfolio Analytics
          </h1>
          <p className="text-slate-400 text-sm mt-1">Calculate risk metrics and correlation matrices for a custom portfolio.</p>
        </div>
      </div>

      <div className="v1-card p-6">
        <div className="flex flex-col md:flex-row gap-4 items-end">
          <div className="flex-1 space-y-2">
            <label className="v1-data-label">Portfolio Symbols (comma-separated)</label>
            <input 
              type="text" 
              value={symbolsInput}
              onChange={(e) => setSymbolsInput(e.target.value)}
              className="v1-input text-sm"
              placeholder="e.g. RELIANCE, TCS, INFY"
            />
          </div>
          <button 
            onClick={handleAnalyze}
            disabled={analyzeMutation.isPending}
            className="v1-btn-primary"
          >
            {analyzeMutation.isPending ? 'Analyzing...' : 'Analyze Portfolio'}
          </button>
        </div>
      </div>

      {analyzeMutation.error && (
        <div className="v1-card v1-card-down p-4 text-xs text-rose-400">
          Error: {analyzeMutation.error.message}
        </div>
      )}

      {analyzeMutation.data && !analyzeMutation.data.error && (
        <div className="space-y-6">
          <div className="v1-grid-4">
            <div className="v1-stat-pill v1-stat-pill-up">
              <div className="flex items-center gap-2 text-slate-400 mb-2">
                <Target className="w-5 h-5 text-indigo-400" />
                <h3 className="v1-data-label">Sharpe Ratio</h3>
              </div>
              <div className="v1-data-value text-white">
                {analyzeMutation.data.sharpe_ratio}
              </div>
              <div className="text-xs text-slate-500 mt-1">Risk-adjusted return vs Nifty 50</div>
            </div>

            <div className="v1-stat-pill">
              <div className="flex items-center gap-2 text-slate-400 mb-2">
                <Activity className="w-5 h-5 text-amber-400" />
                <h3 className="v1-data-label">Portfolio Beta</h3>
              </div>
              <div className="v1-data-value text-white">
                {analyzeMutation.data.beta}
              </div>
              <div className="text-xs text-slate-500 mt-1">Volatility relative to market</div>
            </div>

            <div className="v1-stat-pill v1-stat-pill-up">
              <div className="flex items-center gap-2 text-slate-400 mb-2">
                <TrendingUp className="w-5 h-5 text-emerald-400" />
                <h3 className="v1-data-label">Ann. Return</h3>
              </div>
              <div className="v1-data-value text-emerald-400">
                {(analyzeMutation.data.annualized_return * 100).toFixed(2)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Expected yearly return</div>
            </div>

            <div className="v1-stat-pill v1-stat-pill-down">
              <div className="flex items-center gap-2 text-slate-400 mb-2">
                <BarChart2 className="w-5 h-5 text-rose-400" />
                <h3 className="v1-data-label">VaR (95%)</h3>
              </div>
              <div className="v1-data-value text-rose-400">
                {(analyzeMutation.data.var_95 * 100).toFixed(2)}%
              </div>
              <div className="text-xs text-slate-500 mt-1">Max daily loss (95% confidence)</div>
            </div>
          </div>

          <div className="v1-card p-6">
            <h3 className="v1-title-card mb-4">Correlation Matrix</h3>
            <div className="overflow-x-auto">
              <table className="w-full text-sm text-left text-slate-400">
                <thead className="text-xs text-slate-300 uppercase border-b border-white/10 font-display">
                  <tr>
                    <th className="px-4 py-3">Symbol</th>
                    {Object.keys(analyzeMutation.data.correlation_matrix || {}).map(sym => (
                      <th key={sym} className="px-4 py-3 text-center">{sym}</th>
                    ))}
                  </tr>
                </thead>
                <tbody className="divide-y divide-white/5 font-data">
                  {Object.entries(analyzeMutation.data.correlation_matrix || {}).map(([rowSym, cols]: [string, any]) => (
                    <tr key={rowSym} className="hover:bg-white/5 transition-colors">
                      <td className="px-4 py-3 font-bold text-slate-200">{rowSym}</td>
                      {Object.keys(analyzeMutation.data.correlation_matrix || {}).map(colSym => {
                        const val = cols[colSym];
                        const isHigh = val > 0.7 && rowSym !== colSym;
                        const isLow = val < 0.3;
                        return (
                          <td key={colSym} className={`px-4 py-3 text-center ${isHigh ? 'text-rose-400' : isLow ? 'text-emerald-400' : 'text-slate-400'}`}>
                            {val.toFixed(2)}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
