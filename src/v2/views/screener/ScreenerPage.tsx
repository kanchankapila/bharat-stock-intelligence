
import React, { useState } from 'react';
import { Card } from '../../../components/Card';
import { trpc } from '../../../lib/trpc';

export const ScreenerPage = () => {
  const { data: criteria } = trpc.getScreenerCriteria.useQuery();
  const [selectedFilters, setSelectedFilters] = useState<any[]>([]);
  const runScreenerMutation = trpc.runScreener.useMutation();

  const handleRunScreener = () => {
    runScreenerMutation.mutate(selectedFilters);
  };

  const addFilter = () => {
    setSelectedFilters([...selectedFilters, { id: '', operator: 'gt', value: '' }]);
  };

  const updateFilter = (index: number, field: string, value: any) => {
    const newFilters = [...selectedFilters];
    newFilters[index][field] = value;
    setSelectedFilters(newFilters);
  };

  return (
    <div className="p-6 space-y-6">
      <h2 className="text-2xl font-bold text-slate-100">Advanced Stock Screener</h2>

      <Card title="Filter Criteria">
        <div className="space-y-4">
          {selectedFilters.map((filter, index) => (
            <div key={index} className="grid grid-cols-1 md:grid-cols-4 gap-4">
              <select
                value={filter.id}
                onChange={(e) => updateFilter(index, 'id', e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-md px-3 py-2 text-sm"
              >
                <option value="" disabled>Select a criterion</option>
                {criteria && Object.entries(criteria).map(([group, items]: [string, any[]]) => (
                  <optgroup key={group} label={group}>
                    {items.map((item: any) => (
                      <option key={item.id} value={item.id}>{item.name}</option>
                    ))}
                  </optgroup>
                ))}
              </select>
              <select
                value={filter.operator}
                onChange={(e) => updateFilter(index, 'operator', e.target.value)}
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-md px-3 py-2 text-sm"
              >
                <option value="gt">&gt;</option>
                <option value="lt">&lt;</option>
                <option value="eq">=</option>
                <option value="gte">&gt;=</option>
                <option value="lte">&lt;=</option>
              </select>
              <input
                type="number"
                value={filter.value}
                onChange={(e) => updateFilter(index, 'value', e.target.value)}
                placeholder="e.g., 10"
                className="w-full bg-slate-800 border border-slate-700 text-white rounded-md px-3 py-2 text-sm"
              />
              <button
                onClick={() => setSelectedFilters(selectedFilters.filter((_, i) => i !== index))}
                className="px-4 py-2 rounded-md text-sm font-medium bg-rose-600 hover:bg-rose-700 text-white transition-colors"
              >
                Remove
              </button>
            </div>
          ))}
          <div className="flex gap-3">
            <button
              onClick={addFilter}
              className="px-4 py-2 rounded-md text-sm font-medium bg-slate-800 hover:bg-slate-700 text-white transition-colors"
            >
              Add Filter
            </button>
            <button
              onClick={handleRunScreener}
              disabled={selectedFilters.length === 0 || runScreenerMutation.isPending}
              className="px-4 py-2 rounded-md text-sm font-medium bg-indigo-600 hover:bg-indigo-700 text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
            >
              Run Screener
            </button>
          </div>
        </div>
      </Card>

      <Card title="Screener Results">
        {runScreenerMutation.isPending && <div className="text-slate-400">Loading...</div>}
        {runScreenerMutation.isError && <div className="text-red-500">Error: {runScreenerMutation.error.message}</div>}
        {runScreenerMutation.isSuccess && (
          <div className="overflow-x-auto">
            <table className="w-full text-sm text-left">
              <thead>
                <tr className="border-b border-slate-800 text-slate-400">
                  <th className="py-2 pr-4 font-medium">Symbol</th>
                  <th className="py-2 pr-4 font-medium">Overall Score</th>
                  <th className="py-2 pr-4 font-medium">Momentum Score</th>
                  <th className="py-2 pr-4 font-medium">Value Score</th>
                  <th className="py-2 pr-4 font-medium">Quality Score</th>
                </tr>
              </thead>
              <tbody>
                {runScreenerMutation.data?.map((stock: any) => (
                  <tr key={stock.symbol} className="border-b border-slate-800/50">
                    <td className="py-2 pr-4 text-slate-200">{stock.symbol}</td>
                    <td className="py-2 pr-4 text-slate-300">{stock.rank_composite}</td>
                    <td className="py-2 pr-4 text-slate-300">{stock.momentum_score}</td>
                    <td className="py-2 pr-4 text-slate-300">{stock.valuation_score}</td>
                    <td className="py-2 pr-4 text-slate-300">{stock.rank_quality}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
        {!runScreenerMutation.isPending && !runScreenerMutation.isError && !runScreenerMutation.data && (
          <div className="h-64 flex items-center justify-center text-slate-500">
            No results yet. Run the screener to see stocks.
          </div>
        )}
      </Card>
    </div>
  );
};
