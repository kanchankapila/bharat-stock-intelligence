import React from 'react';
import { FlaskConical } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { TabBar, type TabItem } from './TabBar';
import { QueryError } from './IntelligenceQueryError';
import { DataHealthChip } from './DataHealthChip';
import { MetricTile } from './MetricTile';
import { DataTable, type Column } from './DataTable';
import { ModelRocPanel } from './ModelRocPanel';
import { LiveHitRates } from './LiveHitRates';
import { ScreenerSurfacingSignalsPanel } from './ScreenerSurfacingSignalsPanel';
import { percent } from '../lib/intelligenceDisplay';

const TABS: TabItem[] = [
  { id: 'status', label: 'Scoring Status' },
  { id: 'roc', label: 'ROC Diagnostics' },
  { id: 'hits', label: 'Live Hit Rates' },
  { id: 'surfacing', label: 'Surfacing Monitor' },
  { id: 'dl', label: 'DL Performance' },
];

type Row = Record<string, unknown>;

function humanize(key: string): string {
  return key.replace(/_/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}

function scalar(value: unknown): string {
  if (value == null) return '—';
  if (typeof value === 'number') return Number.isFinite(value) ? value.toLocaleString('en-IN') : '—';
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  const s = String(value);
  return s.length > 60 ? `${s.slice(0, 57)}…` : s;
}

// getQuantScoringStatus returns { progress: QuantScoringProgress, summary: {...} } — nested
// objects. Flatten to depth 2 so scalar fields render as tiles; deeper structure renders '—'
// rather than being silently dropped.
function flattenStatus(data: unknown, prefix = '', depth = 0): [string, unknown][] {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return [];
  return Object.entries(data as Record<string, unknown>).flatMap(([key, value]) => {
    const label = prefix ? `${prefix} · ${humanize(key)}` : humanize(key);
    if (value !== null && typeof value === 'object' && !Array.isArray(value) && depth < 2) {
      return flattenStatus(value, label, depth + 1);
    }
    return [[label, value] as [string, unknown]];
  });
}

// Live status of quantScoringService as it reports itself. Quant scores are component inputs
// to the canonical unified ranking — see scoring-authority rules; nothing here re-ranks anything.
function ScoringStatus() {
  const query = trpc.getQuantScoringStatus.useQuery(undefined, { staleTime: 300_000, retry: false });
  const entries = flattenStatus(query.data)
    .filter(([, v]) => v == null || ['string', 'number', 'boolean'].includes(typeof v));
  return (
    <div className="space-y-4">
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {query.isLoading ? (
        <p role="status" className="bsi-intel-note">Loading scoring service status…</p>
      ) : entries.length === 0 ? (
        <p className="bsi-intel-note">The scoring service returned no status fields.</p>
      ) : (
        <div className="grid gap-4 sm:grid-cols-2 xl:grid-cols-4">
          {entries.map(([key, value]) => (
            <MetricTile key={key} label={humanize(key)} value={scalar(value)} />
          ))}
        </div>
      )}
      <p className="bsi-intel-note">Live status of quantScoringService as it reports itself. Quant scores are component inputs to the canonical unified ranking — see scoring-authority rules; nothing here re-ranks anything.</p>
    </div>
  );
}

const DL_COLUMNS: Column<Row>[] = [
  { key: 'eval_date', label: 'Eval date', sortable: true },
  { key: 'model_version', label: 'Version' },
  { key: 'horizon_days', label: 'Horizon (d)', sortable: true },
  { key: 'sample_count', label: 'Samples', sortable: true },
  { key: 'directional_accuracy', label: 'Dir. accuracy', sortable: true, render: (r) => percent(r.directional_accuracy) },
  { key: 'roc_auc', label: 'ROC AUC', sortable: true },
  { key: 'drift_score', label: 'Drift' },
];

function DlPerformance() {
  const [days, setDays] = React.useState(90);
  const query = trpc.getDLModelPerformance.useQuery({ days }, { staleTime: 300_000 });
  const rows = (query.data ?? []) as Row[];
  const lastEval = typeof rows[0]?.eval_date === 'string' ? (rows[0].eval_date as string) : null;
  return (
    <div className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <label className="bsi-intel-note">Evaluation window
          <select className="bsi-control ml-2" value={days} onChange={(e) => setDays(Number(e.target.value))}>
            {[30, 90, 365].map((d) => <option key={d} value={d}>{d} days</option>)}
          </select>
        </label>
        <DataHealthChip lastUpdated={lastEval} staleThresholdMinutes={2880} />
      </div>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      <DataTable
        data={rows}
        columns={DL_COLUMNS}
        isLoading={query.isLoading}
        rowKey={(r) => `${r.eval_date}-${r.model_version}-${r.horizon_days}`}
        emptyMessage="No stored DL model evaluations in this window."
      />
      <p className="bsi-intel-note">Stored evaluations of the LSTM_TFT_ENSEMBLE written by the performance tracker. Historical accuracy is not a future guarantee; overlapping windows are not independent samples.</p>
    </div>
  );
}

export default function ModelStudioPage() {
  const [tab, setTab] = React.useState('status');
  return (
    <V1PageFrame title="Model Studio" kicker="GOVERNANCE / DIAGNOSTICS / STATUS">
      <div className="bsi-intel-hero">
        <div>
          <span className="bsi-intel-eyebrow">04 / MODEL GOVERNANCE</span>
          <h2 className="font-display text-2xl sm:text-3xl mt-2">Watch the engines, not the story.</h2>
          <p className="bsi-intel-note mt-2">Scoring status, live ROC edge, emitted-signal hit rates and DL evaluations in one place.</p>
        </div>
        <FlaskConical size={44} className="text-emerald-400 shrink-0" aria-hidden="true" />
      </div>
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <section role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="bsi-intel-panel min-w-0">
        {tab === 'status' && <ScoringStatus />}
        {tab === 'roc' && <ModelRocPanel />}
        {tab === 'hits' && <LiveHitRates />}
        {tab === 'surfacing' && <ScreenerSurfacingSignalsPanel />}
        {tab === 'dl' && <DlPerformance />}
      </section>
      <p className="bsi-intel-note">Diagnostics and monitoring only. Nothing here is a recommendation. NOT FINANCIAL ADVICE.</p>
    </V1PageFrame>
  );
}
