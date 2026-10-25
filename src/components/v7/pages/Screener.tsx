import React, { useState, useCallback, useMemo } from 'react';
import { Filter, Plus, Trash2, Search, RefreshCw, Play, BarChart3, AlertTriangle, List } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { cn } from '../../../lib/utils';
import { formatPct, DASH } from '../lib';
import { DataTable, DataTableColumn } from '../components/DataTable';
import { AsOfBanner } from '../components/AsOfBanner';
import { EmptyState } from '../components/EmptyState';
import { QueryError } from '../components/QueryError';

const CRITERIA_GROUPS: Record<string, { id: string; name: string; type: 'number' | 'boolean' }[]> = {
  Fundamental: [
    { id: 'trailing_pe', name: 'Trailing P/E', type: 'number' },
    { id: 'forward_pe', name: 'Forward P/E', type: 'number' },
    { id: 'debt_to_equity', name: 'Debt to Equity', type: 'number' },
    { id: 'return_on_equity', name: 'Return on Equity', type: 'number' },
  ],
  Technical: [
    { id: 'return_1m', name: '1-Month Return', type: 'number' },
    { id: 'return_3m', name: '3-Month Return', type: 'number' },
    { id: 'above_sma200', name: 'Above 200-Day SMA', type: 'boolean' },
  ],
  Quantitative: [
    { id: 'momentum_score', name: 'Momentum Score', type: 'number' },
    { id: 'valuation_score', name: 'Value Score', type: 'number' },
    { id: 'rank_quality', name: 'Quality Score', type: 'number' },
    { id: 'rank_composite', name: 'Overall Score', type: 'number' },
  ],
};

export const ScreenerPage: React.FC = () => {
  const { data: criteriaMeta, isLoading: criteriaLoading, isError: criteriaError } = trpc.getScreenerCriteria.useQuery(undefined, {
    staleTime: 10 * 60 * 1000,
  });
  const [criteria, setCriteria] = useState<{ id: string; operator: string; value: string }[]>([]);
  const [results, setResults] = useState<any[]>([]);
  const [running, setRunning] = useState(false);
  const [lastRan, setLastRan] = useState<string | null>(null);

  const mutation = trpc.runScreener.useMutation({
    onSuccess: (data) => {
      setResults(Array.isArray(data) ? data : []);
      setRunning(false);
      setLastRan(new Date().toISOString());
    },
    onError: () => setRunning(false),
  });
  const groups = useMemo(() => {
    if (criteriaLoading || !criteriaMeta) return CRITERIA_GROUPS;
    const meta = criteriaMeta as any;
    const out: Record<string, { id: string; name: string; type: 'number' | 'boolean' }[]> = {};
    Object.entries(meta).forEach(([group, items]: [string, any]) => {
      out[group] = (items as any[]).map((c: any) => ({ id: c.id, name: c.name, type: c.type }));
    });
    return out;
  }, [criteriaMeta, criteriaLoading]);

  const addCriterion = useCallback((group: string, item: { id: string; name: string; type: string }) => {
    setCriteria((prev) => [...prev, { id: item.id, operator: 'gte', value: '' }]);
  }, []);

  const removeCriterion = useCallback((index: number) => {
    setCriteria((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const updateValue = useCallback((index: number, value: string) => {
    setCriteria((prev) => prev.map((c, i) => i === index ? { ...c, value } : c));
  }, []);

  const updateOperator = useCallback((index: number, operator: string) => {
    setCriteria((prev) => prev.map((c, i) => i === index ? { ...c, operator } : c));
  }, []);

  const run = useCallback(() => {
    const typed = criteria.map((c: any) => ({ id: c.id, operator: c.operator as any, value: c.value }));
    mutation.mutate(typed);
    setRunning(true);
  }, [criteria, mutation]);

  const columns: DataTableColumn<any>[] = [
    { key: 'symbol', label: 'Symbol', width: 120, sortable: true },
    { key: 'name', label: 'Name', width: 200, sortable: true },
    { key: 'sector', label: 'Sector', width: 140, sortable: true },
    { key: 'rank_composite', label: 'Composite', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(1) },
    { key: 'return_12m', label: 'Return 12M', width: 110, sortable: true, align: 'right', format: (v) => v == null ? DASH : formatPct(v, 1, true) },
    { key: 'momentum_score', label: 'Momentum', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(1) },
    { key: 'piotroski_f_score', label: 'Piotroski', width: 100, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(0) },
    { key: 'sharpe_ratio', label: 'Sharpe', width: 90, sortable: true, align: 'right', format: (v) => v == null ? DASH : Number(v).toFixed(2) },
  ];

  const hasCriteria = criteria.length > 0;
  const validCriteria = hasCriteria && criteria.every((c) => c.value.trim() !== '');

  if (criteriaError) return <QueryError />;

  return (
    <div className="v7-page">
      <div className="v7-page-header">
        <div className="v7-page-title-wrap">
          <div className="v7-page-icon"><Filter size={20} strokeWidth={2} /></div>
          <div>
            <h1 className="v7-page-title">Quant Screener</h1>
            <p className="v7-page-kicker">Filter the scored universe on real quant_scores fundamentals, technicals and momentum</p>
          </div>
        </div>
        <div className="v7-page-actions">
          <AsOfBanner asOf={lastRan} label="Screen ran" />
          <button
            disabled={!hasCriteria || !validCriteria || running}
            className="v7-btn v7-btn-primary"
            onClick={run}
          >
            <Play className="w-4 h-4" size={16} strokeWidth={2} />
            {running ? ' Running…' : ' Run screener'}
          </button>
        </div>
      </div>

      {/* ─── Criteria builder ─── */}
      <div className="v7-card">
        <div className="v7-card-head">
          <span className="v7-card-title">Build your screen</span>
          <span className="text-[10px] font-bold text-slate-400 uppercase">Add criteria · AND logic · run on latest computed batch</span>
        </div>
        <div className="space-y-3">
          {Object.entries(groups).map(([groupName, items]) => (
            <div key={groupName} className="space-y-2">
              <div className="v7-section-head">
                <h3 className="v7-section-title">{groupName}</h3>
              </div>
              <div className="flex flex-wrap gap-3">
                {items.map((item) => (
                  <button key={item.id}
                    onClick={() => addCriterion(groupName, item)}
                    className={cn('px-3 py-2 rounded-lg text-xs font-semibold border transition-colors flex items-center gap-2',
                      criteria.some((c) => c.id === item.id) ? 'bg-indigo-500/20 border-indigo-500/40 text-indigo-300' : 'border-slate-700/40 bg-slate-900/40 text-slate-400 hover:border-slate-500 hover:text-white')}>
                    <BarChart3 className="w-3.5 h-3.5" />
                    {item.name}
                  </button>
                ))}
              </div>
            </div>
          ))}
          {criteria.length === 0 && (
            <div className="v7-empty" style={{ padding: '30px 0' }}>
              <div className="v7-empty-icon"><List className="w-10 h-10 text-slate-600" /></div>
              <h4 className="v7-empty-title">No criteria yet</h4>
              <p className="v7-empty-text">Pick a factor above to add a filter. All criteria combine with AND logic when you run the screen.</p>
            </div>
          )}
          {criteria.length > 0 && (
            <div className="space-y-2">
              {criteria.map((c, i) => {
                const item = Object.values(groups).flat().find((x) => x.id === c.id);
                return (
                  <div key={i} className="flex items-center gap-2 px-3 py-2.5 rounded-lg border border-slate-700/50 bg-slate-900/30">
                    <span className="text-[10px] font-bold uppercase text-slate-400 w-16">{item?.name ?? c.id}</span>
                    <select
                      aria-label={`${item?.name ?? c.id} operator`}
                      value={c.operator}
                      onChange={(e) => updateOperator(i, e.target.value)}
                      className="v7-control w-24 text-xs bg-transparent text-slate-300"
                    >
                      <option value="gte">&ge;</option>
                      <option value="gt">&gt;</option>
                      <option value="lte">&le;</option>
                      <option value="lt">&lt;</option>
                      <option value="eq">=</option>
                    </select>
                    <input
                      aria-label={`${item?.name ?? c.id} value`}
                      type="text"
                      placeholder={item?.type === 'boolean' ? 'true/false' : 'value'}
                      value={c.value}
                      onChange={(e) => updateValue(i, e.target.value)}
                      className="v7-control w-28 text-xs bg-transparent text-slate-300"
                    />
                    <button
                      onClick={() => removeCriterion(i)}
                      className="p-1.5 rounded hover:bg-rose-500/10 text-slate-500 hover:text-rose-400"
                      title="Remove criterion"
                      aria-label={`Remove ${item?.name ?? c.id} criterion`}
                    >
                      <Trash2 className="w-4 h-4" strokeWidth={1.6} />
                    </button>
                  </div>
                );
              })}
              {!validCriteria && hasCriteria && (
                <div className="px-3 py-2 rounded-lg text-[11px] text-rose-400 bg-rose-500/10 border border-rose-500/20">
                  ⚠ Please fill in a value for every criterion before running.
                </div>
              )}
            </div>
          )}
        </div>
      </div>

      {/* ─── Results ─── */}
      <div className="v7-card">
        <div className="v7-card-head">
          <span className="v7-card-title">Results</span>
          <span className="text-[10px] font-bold text-slate-400 uppercase">{results.length} stocks matched</span>
        </div>
        {running && <div className="h-64 flex items-center justify-center text-slate-500 font-data">Running screen…</div>}
        {mutation.isError && <QueryError onRetry={run} />}
        {!running && !mutation.isError && (
          <DataTable
            columns={columns}
            data={results}
            pageSize={25}
            loading={false}
            emptyTitle={!hasCriteria ? 'Set criteria to see results' : 'No stocks matched your screen'}
            emptyText={!hasCriteria
              ? 'Add one or more criteria above, then run the screener.'
              : 'No stocks in the latest computed batch satisfy all your conditions. Try relaxing a threshold.'}
            getRowId={(row) => row.symbol}
          />
        )}
      </div>

      {/* ─── Honesty ─── */}
      <div className="v7-card mt-6">
        <div className="v7-honesty-banner">
          <AlertTriangle size={14} strokeWidth={1.5} />
          <span className="font-medium">Screen ≠ validated edge</span>
          <span className="ml-auto text-slate-300">A screener is a filter, not a recommendation. No factor in this platform's backtest harness currently clears statistical significance after the exit-pricing-bug fix — treat results as a candidate list for your own research, never as a buy list.</span>
        </div>
      </div>
    </div>
  );
};

export default ScreenerPage;
