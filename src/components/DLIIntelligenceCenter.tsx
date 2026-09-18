// Intelligence workspace: queries mount only for the selected tab.

import { QueryError } from './IntelligenceQueryError';

import React from 'react';
import { Brain, BarChart3, PieChart, Activity, Clock, RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { istDate, percent, percentPoint } from '../lib/intelligenceDisplay';
import { V1PageFrame } from './v1/V1PageFrame';
import { TabBar, type TabItem } from './TabBar';
import { MetricTile } from './MetricTile';
import { DataHealthChip } from './DataHealthChip';
import { DataTable, type Column } from './DataTable';

const TABS: TabItem[] = [
  { id: 'predictions', label: 'Predictions', icon: Brain },
  { id: 'performance', label: 'Model Performance', icon: BarChart3 },
  { id: 'regime', label: 'Market Regime', icon: PieChart },
  { id: 'features', label: 'Feature Importance', icon: Activity },
  { id: 'history', label: 'Prediction History', icon: Clock },
];
type Row = Record<string, unknown>;
const pctColumn = (key: string, label: string): Column<Row> => ({
  key, label, sortable: true, render: row => percent(row[key], key.includes('ret') ? 2 : 1),
});
const PREDICTION_COLUMNS: Column<Row>[] = [
  { key: 'symbol', label: 'Symbol', sortable: true },
  pctColumn('confidence', 'Model confidence'),
  pctColumn('prob_up_1d', '1D probability ↑'),
  pctColumn('prob_up_5d', '5D probability ↑'),
  pctColumn('prob_up_15d', '15D probability ↑'),
  pctColumn('exp_ret_5d', '5D expected return'),
  pctColumn('exp_ret_15d', '15D expected return'),
  { key: 'regime', label: 'Regime' },
  { key: 'model_version', label: 'Version' },
];

function PredictionsTab({ date, onSelectStock }: { date: string; onSelectStock?: (symbol: string) => void }) {
  const query = trpc.getDLPredictions.useQuery({ date }, { staleTime: 300_000 });
  const rows: Row[] = query.data ?? [];
  return <div className="space-y-4">
    <div className="flex items-center justify-between gap-3">
      <DataHealthChip lastUpdated={query.data?.[0]?.created_at ?? null} staleThresholdMinutes={1440} />
      <button type="button" disabled={query.isFetching} onClick={() => void query.refetch()} className="bsi-action"><RefreshCw size={14} />{query.isFetching ? 'Refreshing…' : 'Refresh'}</button>
    </div>
    {query.isError && <QueryError retry={() => void query.refetch()} />}
    <DataTable data={rows} columns={PREDICTION_COLUMNS} searchable searchKeys={['symbol', 'regime']} isLoading={query.isLoading}
      rowKey={row => `${row.symbol}-${row.model_name}`}
      onRowClick={onSelectStock ? row => onSelectStock(String(row.symbol)) : undefined}
      emptyMessage="No predictions for this date. Select an earlier trading session." />
    <p className="bsi-intel-note">Up to 200 stored predictions. Confidence is a model output, not a calibrated win rate. One-day expected returns are not produced by this model.</p>
  </div>;
}

function PerformanceTab() {
  const [days, setDays] = React.useState(30);
  const query = trpc.getDLModelPerformance.useQuery({ days }, { staleTime: 300_000 });
  const rows = (query.data ?? []) as Row[];
  const columns: Column<Row>[] = [
    { key: 'eval_date', label: 'Evaluation date', sortable: true },
    { key: 'model_version', label: 'Version' },
    { key: 'horizon_days', label: 'Horizon (days)', sortable: true },
    { key: 'sample_count', label: 'Samples', sortable: true },
    pctColumn('directional_accuracy', 'Directional accuracy'),
    { key: 'roc_auc', label: 'ROC AUC' },
    { key: 'sharpe_ratio', label: 'Sharpe' },
    { key: 'profit_factor', label: 'Profit factor' },
    { key: 'drift_score', label: 'Drift score' },
  ];
  return <div className="space-y-4">
    <label className="bsi-intel-note">Evaluation window <select className="bsi-control ml-2" value={days} onChange={e => setDays(Number(e.target.value))}><option value={30}>30 days</option><option value={90}>90 days</option><option value={365}>365 days</option></select></label>
    {query.isError && <QueryError retry={() => void query.refetch()} />}
    <DataTable data={rows} columns={columns} isLoading={query.isLoading} emptyMessage="No stored model evaluations in this window." />
    <p className="bsi-intel-note">Stored evaluations for LSTM_TFT_ENSEMBLE. Compare like-for-like horizons and versions. Overlapping windows are not independent samples; historical accuracy is not a future guarantee.</p>
  </div>;
}

function RegimeTab({ date }: { date: string }) {
  const query = trpc.getMarketRegime.useQuery({ date }, { staleTime: 300_000 });
  const regime = query.data;
  return <div className="space-y-4">
    {query.isError && <QueryError retry={() => void query.refetch()} />}
    <div className="grid gap-4 sm:grid-cols-3">
      <MetricTile label="Stored regime" value={regime?.regime ?? '—'} loading={query.isLoading} />
      <MetricTile label="Regime probability" value={percent(regime?.regime_prob)} loading={query.isLoading} />
      <MetricTile label="As-of session" value={regime?.date ?? '—'} loading={query.isLoading} />
    </div>
    <DataHealthChip lastUpdated={regime?.computed_at ?? null} staleThresholdMinutes={1440} />
    {!query.isLoading && !regime && <p className="bsi-intel-note">No stored market regime on or before the selected date.</p>}
    {regime?.features && <div className="bsi-intel-panel"><h3 className="font-display mb-3">Regime inputs</h3><dl className="grid gap-3 sm:grid-cols-2">{Object.entries(regime.features).map(([key, value]) => <div key={key} className="flex justify-between gap-4 text-xs"><dt className="text-slate-400">{key}</dt><dd className="font-mono break-all">{typeof value === 'number' ? value.toFixed(3) : JSON.stringify(value)}</dd></div>)}</dl></div>}
  </div>;
}

function FeaturesTab({ date }: { date: string }) {
  const query = trpc.getDLPredictions.useQuery({ date }, { staleTime: 300_000 });
  const available = (query.data ?? []).filter(row => row.topFeatures != null);
  return <div className="space-y-4">
    {query.isError && <QueryError retry={() => void query.refetch()} />}
    <p className="bsi-intel-note">Stored attribution only—not a recommendation. The current inference writer does not serialize feature attribution; missing explanations are never synthesized.</p>
    {query.isLoading ? <p role="status">Loading attribution…</p> : available.length === 0 ? <div className="bsi-intel-panel py-10 text-center"><Activity className="mx-auto mb-3 text-amber-400" /><h3 className="font-display">Feature attribution unavailable</h3><p className="bsi-intel-note mt-2">No stored attribution for this session. Predictions can exist without explanations.</p></div> : available.map(row => <article key={`${row.symbol}-${row.model_name}`} className="bsi-intel-panel"><h3 className="font-display mb-3">{row.symbol} · {row.model_name}</h3><pre className="overflow-auto text-xs text-slate-300">{JSON.stringify(row.topFeatures, null, 2)}</pre></article>)}
  </div>;
}

function HistoryTab() {
  const [symbol, setSymbol] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [horizon, setHorizon] = React.useState<5 | 15>(5);
  const query = trpc.getDLPredictionHistory.useQuery({ symbol: submitted, horizon, days: 90 }, { enabled: !!submitted, staleTime: 300_000 });
  const columns: Column<Row>[] = [
    { key: 'prediction_date', label: 'Session', sortable: true },
    pctColumn('prob_up', 'Probability ↑'), pctColumn('confidence', 'Model confidence'),
    pctColumn('exp_ret', 'Expected return (model)'),
    { key: 'actual_ret', label: 'Actual return', sortable: true, render: row => percentPoint(row.actual_ret) },
    { key: 'outcome', label: 'Outcome' }, { key: 'regime', label: 'Regime' },
  ];
  return <div className="space-y-4">
    <form className="flex flex-wrap items-end gap-3" onSubmit={e => { e.preventDefault(); setSubmitted(symbol.trim().toUpperCase()); }}>
      <label className="bsi-intel-note">NSE symbol<input required maxLength={40} className="bsi-control block mt-1" value={symbol} onChange={e => setSymbol(e.target.value)} placeholder="e.g. RELIANCE" /></label>
      <label className="bsi-intel-note">Horizon<select className="bsi-control block mt-1" value={horizon} onChange={e => setHorizon(Number(e.target.value) as 5 | 15)}><option value={5}>5 trading days</option><option value={15}>15 trading days</option></select></label>
      <button type="submit" className="bsi-action" disabled={!symbol.trim()}>View history</button>
    </form>
    {query.isError && <QueryError retry={() => void query.refetch()} />}
    {submitted ? <><h3 className="font-display">{submitted} · Last 90 days</h3><DataTable data={(query.data ?? []) as Row[]} columns={columns} isLoading={query.isLoading} emptyMessage="No stored predictions for this symbol in the last 90 days." /></> : <p className="bsi-intel-note">Enter a symbol to compare stored forecasts with resolved outcomes.</p>}
    <p className="bsi-intel-note">Expected returns are the model's stored fraction shown as % (app-wide convention); actual returns are realized percent moves (T+1 entry → horizon close) shown in their stored percent units. An absent actual return or outcome means it is unresolved or unavailable—not a zero return.</p>
  </div>;
}

export default function DLIIntelligenceCenter({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const [active, setActive] = React.useState('predictions');
  const [date, setDate] = React.useState(istDate);
  return <V1PageFrame title="Deep Learning Intelligence" kicker="RESEARCH LAB / MODEL DIAGNOSTICS">
    <div className="bsi-intel-hero"><div><span className="bsi-intel-eyebrow">01 / INTELLIGENCE LAB</span><h2 className="font-display text-2xl sm:text-3xl mt-2">Look inside the model.</h2><p className="bsi-intel-note mt-2">Forecasts, evaluation evidence and market context. No synthetic scores.</p></div>
      <label className="bsi-intel-note">Prediction / regime session (IST)<input type="date" aria-label="Prediction session" className="bsi-control block mt-2" max={istDate()} value={date} onChange={e => { if (e.target.value) setDate(e.target.value); }} /></label></div>
    <TabBar tabs={TABS} active={active} onChange={setActive} />
    <section role="tabpanel" aria-label={TABS.find(tab => tab.id === active)?.label} className="bsi-intel-panel min-w-0">
      {active === 'predictions' && <PredictionsTab date={date} onSelectStock={onSelectStock} />}
      {active === 'performance' && <PerformanceTab />}
      {active === 'regime' && <RegimeTab date={date} />}
      {active === 'features' && <FeaturesTab date={date} />}
      {active === 'history' && <HistoryTab />}
    </section>
    <p className="bsi-intel-note">Model diagnostics are not investment recommendations. NOT FINANCIAL ADVICE.</p>
  </V1PageFrame>;
}

