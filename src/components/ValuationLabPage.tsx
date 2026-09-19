import React from 'react';
import { Filter, Plus, Trash2, Search, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { TabBar, type TabItem } from './TabBar';
import { QueryError } from './IntelligenceQueryError';
import { DataTable, type Column } from './DataTable';
import { MetricTile } from './MetricTile';
import { percentPoint } from '../lib/intelligenceDisplay';

const TABS: TabItem[] = [
  { id: 'builder', label: 'Rule Builder' },
  { id: 'combo', label: 'Combo Finder' },
  { id: 'kayal', label: 'Kayal AIO Screener' },
];

// getScreenerCriteria returns { [category]: [{ id, name, type }] } where `id` is a real
// quant_scores COLUMN name -- runScreener zod-validates against SCREENER_CRITERIA_COLUMNS, so
// the column id (not the human label) is what must be sent on submit.
type CriterionRow = { id: string; name: string; type: string; category: string };
type Rule = {
  rowKey: string;
  column: string;
  label: string;
  operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte';
  value: string;
};
type Row = Record<string, unknown>;

// The wire payload for runScreener: `id` must carry the whitelisted COLUMN id (r.column),
// never the human-readable label (r.label) -- runScreener zod-validates the ids against
// SCREENER_CRITERIA_COLUMNS, so a label would be rejected outright. Extracted as a pure
// function so a test pins the id-not-label contract.
export function buildScreenerPayload(rules: Rule[]): { id: string; operator: Rule['operator']; value: number }[] {
  return rules.map(r => ({ id: r.column, operator: r.operator, value: Number(r.value) }));
}

const OPERATORS = [
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'eq', label: 'Equal to' },
  { value: 'gte', label: 'Greater or equal' },
  { value: 'lte', label: 'Less or equal' },
] as const;

const RESULT_COLUMNS: Column<Row>[] = [
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'trailing_pe', label: 'Trailing P/E', sortable: true, align: 'right', render: r => (typeof r.trailing_pe === 'number' ? r.trailing_pe.toFixed(2) : '—') },
  { key: 'forward_pe', label: 'Forward P/E', sortable: true, align: 'right', render: r => (typeof r.forward_pe === 'number' ? r.forward_pe.toFixed(2) : '—') },
  { key: 'debt_to_equity', label: 'D/E', sortable: true, align: 'right', render: r => (typeof r.debt_to_equity === 'number' ? r.debt_to_equity.toFixed(2) : '—') },
  { key: 'return_on_equity', label: 'ROE', sortable: true, align: 'right', render: r => percentPoint(r.return_on_equity) },
  { key: 'momentum_score', label: 'Momentum', sortable: true, align: 'right', render: r => percentPoint(r.momentum_score) },
  { key: 'valuation_score', label: 'Value', sortable: true, align: 'right', render: r => percentPoint(r.valuation_score) },
  { key: 'rank_quality', label: 'Quality', sortable: true, align: 'right', render: r => percentPoint(r.rank_quality) },
  { key: 'rank_composite', label: 'Composite', sortable: true, align: 'right', render: r => percentPoint(r.rank_composite) },
  { key: 'sharpe_ratio', label: 'Sharpe', sortable: true, align: 'right', render: r => (typeof r.sharpe_ratio === 'number' ? r.sharpe_ratio.toFixed(2) : '—') },
  { key: 'piotroski_f_score', label: 'Piotroski', sortable: true, align: 'right', render: r => (typeof r.piotroski_f_score === 'number' ? r.piotroski_f_score.toFixed(0) : '—') },
];

function ResultView({ data, isLoading, onSymbolClick }: { data: Row[] | null; isLoading?: boolean; onSymbolClick?: (symbol: string) => void }) {
  return (
    <DataTable
      data={data ?? []}
      columns={RESULT_COLUMNS}
      isLoading={isLoading}
      searchable
      searchKeys={['symbol']}
      onRowClick={onSymbolClick ? row => onSymbolClick(String(row.symbol)) : undefined}
      rowKey={row => String(row.symbol)}
      emptyMessage="No stocks match the selected criteria."
    />
  );
}

function RuleBuilderTab({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const criteriaQuery = trpc.getScreenerCriteria.useQuery();
  const allRows = React.useMemo<CriterionRow[]>(() => {
    const flat: CriterionRow[] = [];
    const cat = (criteriaQuery.data ?? {}) as Record<string, { id: string; name: string; type: string }[]>;
    Object.entries(cat).forEach(([category, arr]) =>
      (arr ?? []).forEach(c => flat.push({ id: c.id, name: c.name, type: c.type, category })),
    );
    return flat;
  }, [criteriaQuery.data]);

  const [rules, setRules] = React.useState<Rule[]>([]);
  const [currentId, setCurrentId] = React.useState('');
  const [currentOp, setCurrentOp] = React.useState<Rule['operator']>('gt');
  const [currentVal, setCurrentVal] = React.useState('');
  const [results, setResults] = React.useState<Row[] | null>(null);
  const [runError, setRunError] = React.useState<string | null>(null);

  const screenerMutation = trpc.runScreener.useMutation({
    onSuccess: res => {
      setResults(Array.isArray(res) ? (res as Row[]) : []);
    },
    onError: err => {
      setRunError(err.message || 'Screener request failed.');
    },
  });

  const selected = allRows.find(r => r.id === currentId);

  const addCriterion = () => {
    if (!currentId || !selected || !currentVal.trim()) return;
    setRules(prev => [...prev, {
      rowKey: `${selected.id}-${Date.now()}`,
      column: selected.id,
      label: selected.name,
      operator: currentOp,
      value: currentVal.trim(),
    }]);
    setCurrentId('');
    setCurrentVal('');
  };

  const removeRule = (key: string) => setRules(prev => prev.filter(r => r.rowKey !== key));

  const runScreener = () => {
    if (rules.length === 0) return;
    setResults(null);
    setRunError(null);
    screenerMutation.mutate(
      buildScreenerPayload(rules) as never,
    );
  };

  if (criteriaQuery.isLoading) return <p className="bsi-intel-note">Loading criteria…</p>;
  if (criteriaQuery.isError) return <QueryError retry={() => void criteriaQuery.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="bsi-intel-panel">
        <h3 className="font-display mb-3">Build a Screener Rule</h3>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-5 items-end">
          <div className="sm:col-span-2">
            <label className="bsi-intel-note text-[10px]">Field</label>
            <select
              className="bsi-control mt-1 w-full"
              value={currentId}
              onChange={e => { setCurrentId(e.target.value); setCurrentVal(''); }}
            >
              <option value="">Select a criterion</option>
              {allRows.map(r => <option key={r.id} value={r.id}>{r.name} — {r.category}</option>)}
            </select>
          </div>
          <div>
            <label className="bsi-intel-note text-[10px]">Operator</label>
            <select className="bsi-control mt-1 w-full" value={currentOp} onChange={e => setCurrentOp(e.target.value as Rule['operator'])}>
              {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div>
            <label className="bsi-intel-note text-[10px]">Value</label>
            <input
              type="number"
              step="any"
              className="bsi-control mt-1 w-full"
              value={currentVal}
              onChange={e => setCurrentVal(e.target.value)}
              placeholder={selected?.type === 'boolean' ? '0 or 1' : 'e.g. 15'}
              disabled={!selected}
            />
          </div>
          <button type="button" onClick={addCriterion} disabled={!currentId || !currentVal.trim()} className="bsi-action h-9 mt-1">
            <Plus className="w-3.5 h-3.5" />Add
          </button>
        </div>

        {rules.length > 0 && (
          <div className="mt-4 space-y-2">
            <h4 className="text-[10px] font-black text-slate-500 font-display uppercase tracking-wider">Active rules ({rules.length}) — AND-joined</h4>
            <div className="flex flex-wrap gap-2">
              {rules.map(r => (
                <div key={r.rowKey} className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-800/40 border border-slate-700/50 rounded-md text-[11px]">
                  <span className="font-mono text-white">{r.label}</span>
                  <span className="text-slate-500">{OPERATORS.find(o => o.value === r.operator)?.label ?? r.operator}</span>
                  <span className="font-mono text-slate-300">{r.value}</span>
                  <button type="button" onClick={() => removeRule(r.rowKey)} aria-label={`Remove ${r.label}`} className="ml-1 text-slate-500 hover:text-rose-400">
                    <Trash2 className="w-3 h-3" />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-3">
        <button type="button" onClick={runScreener} disabled={rules.length === 0 || screenerMutation.isPending} className="bsi-action">
          {screenerMutation.isPending ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Running…</> : <><Filter className="w-3.5 h-3.5" />Run Screener</>}
        </button>
        {rules.length === 0 && <span className="bsi-intel-note">Add at least one rule to run.</span>}
      </div>

      {runError && <div role="alert" className="bsi-intel-panel text-rose-400 text-xs">{runError}</div>}

      {results !== null && (
        <div className="space-y-2">
          <p className="bsi-intel-note">Matched {results.length} stock{results.length === 1 ? '' : 's'} in quant_scores.</p>
          <ResultView data={results} onSymbolClick={onSelectStock} />
        </div>
      )}
      <p className="bsi-intel-note">Rules run against the stored quant_scores table — a stock absent from it cannot match, however good it is. A screen is a starting filter, not a recommendation.</p>
    </div>
  );
}

function ComboFinderTab() {
  const tier1 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 1 });
  const tier2 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 2 });
  const d = (tier1.data ?? null) as Record<string, any> | null;
  const d2 = (tier2.data ?? null) as Record<string, any> | null;

  const comboColumns: Column<Record<string, unknown>>[] = [
    { key: 'filters', label: 'Screener combination', render: r => <code className="text-[10px] text-slate-300 break-all">{Array.isArray(r.filters) ? (r.filters as string[]).join(' + ') : '—'}</code> },
    { key: 'n_days', label: 'Days', sortable: true, align: 'right' },
    { key: 'n_signals', label: 'Signals', sortable: true, align: 'right' },
    { key: 'spread_pct', label: 'Spread %', sortable: true, align: 'right', render: r => (typeof r.spread_pct === 'number' ? `${(r.spread_pct as number).toFixed(4)}%` : '—') },
    { key: 't_stat', label: 't-stat', sortable: true, align: 'right', render: r => (typeof r.t_stat === 'number' ? (r.t_stat as number).toFixed(2) : '—') },
    { key: 'p_value', label: 'p-value', sortable: true, align: 'right', render: r => (typeof r.p_value === 'number' ? (r.p_value as number).toFixed(4) : '—') },
  ];

  if (tier1.isLoading) return <p className="bsi-intel-note">Loading combo-finder evidence…</p>;
  if (tier1.isError) return <QueryError retry={() => void tier1.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="bsi-intel-panel">
        <h3 className="font-display mb-1">Tier 1 — deep OHLCV history</h3>
        <p className="bsi-intel-note mb-3">
          Which precursor screens best predicted a next-session flyer. Round-trip cost of {d?.cost_pct_used ?? '—'}% is already deducted from the spread.
        </p>
        {!d ? (
          <p className="bsi-intel-note">No Tier 1 result stored yet — screener_combo_finder.py has not produced one.</p>
        ) : (
          <div className="space-y-4">
            <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-4">
              <MetricTile label="Verdict" value={d.is_edge ? 'REAL EDGE' : 'NO PROVEN EDGE'} direction={d.is_edge ? 'up' : 'neutral'} />
              <MetricTile label="History" value={d.n_days_history != null ? `${d.n_days_history} days` : '—'} />
              <MetricTile label="Combos reported" value={Array.isArray(d.top_combinations) ? d.top_combinations.length : 0} />
              <MetricTile label="As of" value={d.as_of ?? '—'} />
            </div>
            {d.best && (
              <div className={`flex flex-col gap-2 p-3 rounded-xl border ${d.is_edge ? 'bg-emerald-500/5 border-emerald-500/20' : 'bsi-intel-chip'}`}>
                <div className={`text-xs font-black font-display uppercase ${d.is_edge ? 'text-emerald-400' : 'text-slate-500'}`}>Best combination</div>
                <code className="text-[11px] text-white font-mono break-all">{Array.isArray(d.best.filters) ? d.best.filters.join(' + ') : '—'}</code>
                <div className="text-[10px] text-slate-500 font-mono">
                  {Number(d.best.spread_pct ?? 0).toFixed(4)}% spread · t={Number(d.best.t_stat ?? 0).toFixed(2)} · p={Number(d.best.p_value ?? 0).toFixed(4)} · {d.best.n_signals ?? 0} signals across {d.best.n_days ?? 0} days
                </div>
              </div>
            )}
            {Array.isArray(d.top_combinations) && d.top_combinations.length > 0 && (
              <DataTable
                data={d.top_combinations as Record<string, unknown>[]}
                columns={comboColumns}
                rowKey={r => JSON.stringify(r.filters)}
                emptyMessage="No combination cleared the minimum sample thresholds."
              />
            )}
            <p className="bsi-intel-note">A p-value above 0.05 means the spread is not distinguishable from noise. These are persistence screens, not recommendations.</p>
          </div>
        )}
      </div>
      {d2 && (
        <div className="bsi-intel-panel opacity-70">
          <h3 className="font-display mb-1">Tier 2 — low-data (directional only)</h3>
          <p className="bsi-intel-note">
            Only {d2.n_days_history ?? '—'} days of live/EOD screener-membership history — too short to establish significance either way. Shown for visibility, never as a validated edge.
          </p>
          {d2.best && <code className="text-[11px] text-slate-300 font-mono break-all mt-2 block">{Array.isArray(d2.best.filters) ? d2.best.filters.join(' + ') : '—'} (p={Number(d2.best.p_value ?? 0).toFixed(3)})</code>}
        </div>
      )}
    </div>
  );
}

function KayalAioTab({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const [screenpk, setScreenpk] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [limit, setLimit] = React.useState(50);
  const query = trpc.getKayalScreener.useQuery(
    { screenpk: submitted, limit },
    { enabled: !!submitted, staleTime: 300_000 },
  );

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (screenpk.trim()) setSubmitted(screenpk.trim());
  };

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="bsi-intel-note">Screen PK
          <input type="text" inputMode="numeric" className="bsi-control block mt-1" value={screenpk} onChange={e => setScreenpk(e.target.value)} placeholder="e.g. 9230" required />
        </label>
        <label className="bsi-intel-note">Rows per page
          <input type="number" min={1} max={200} className="bsi-control block mt-1 w-24" value={limit} onChange={e => setLimit(Number(e.target.value))} />
        </label>
        <button type="submit" disabled={query.isFetching || !screenpk.trim()} className="bsi-action h-9">
          <Search className="w-3.5 h-3.5" />Load
        </button>
      </form>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {submitted && (
        <div className="space-y-3">
          <p className="bsi-intel-note">
            Kayal Trendlyne all-in-one screener <code>{submitted}</code> · {query.data?.body?.tableData?.length ?? 0} rows returned
          </p>
          {query.isLoading ? <p className="bsi-intel-note">Loading results…</p> : query.data?.body?.tableData?.length ? (() => {
            const { tableHeaders, tableData } = query.data.body;
            const names = (tableHeaders ?? []).map((h: any) => String(h?.name ?? h?.key ?? '').trim());
            const rows = (tableData as any[][]).map((row, i) => {
              const obj: Record<string, unknown> = { _rowId: i };
              names.forEach((name, idx) => { if (name) obj[name] = row[idx]; });
              return obj;
            });
            const cols: Column<Record<string, unknown>>[] = names.filter(Boolean).map(name => ({
              key: name,
              label: name,
              sortable: true,
            }));
            const symbolCol = names.find(n => /symbol|stock|company/i.test(n));
            return (
              <>
                <DataTable
                  data={rows}
                  columns={cols}
                  searchable
                  searchKeys={symbolCol ? [symbolCol] : names.slice(0, 2)}
                  rowKey={r => String(r._rowId)}
                  onRowClick={onSelectStock && symbolCol ? r => onSelectStock(String(r[symbolCol])) : undefined}
                  emptyMessage="No rows for this screen."
                />
                <p className="bsi-intel-note">
                  Columns render exactly as the vendor returns them ({names.length} fields) — no local renaming, so a vendor schema change shows up instead of being hidden.
                </p>
              </>
            );
          })() : <p className="bsi-intel-note">No rows returned. Confirm the screen PK exists in Kayal Trendlyne.</p>}
        </div>
      )}
      <p className="bsi-intel-note">Screen PKs come from Kayal Trendlyne. Membership is a vendor filter, not a recommendation.</p>
    </div>
  );
}

export default function ValuationLabPage({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const [active, setActive] = React.useState('builder');
  return (
    <V1PageFrame title="Valuation Laboratory" kicker="SCREENING / RULE BUILDER / COMBO EVIDENCE">
      <div className="space-y-6">
        <div className="bsi-intel-hero">
          <div>
            <span className="bsi-intel-eyebrow">06 / LABORATORY</span>
            <h2 className="font-display text-2xl sm:text-3xl mt-2">Valuation Laboratory</h2>
            <p className="bsi-intel-note mt-2">
              Build screens against the stored quant_scores table, read the persisted combo-finder evidence, and load Kayal Trendlyne screeners. Every number here comes from a real procedure — nothing is synthesized.
            </p>
          </div>
        </div>
        <TabBar tabs={TABS} active={active} onChange={setActive} />
        <section role="tabpanel" aria-label={TABS.find(t => t.id === active)?.label} className="bsi-intel-panel min-w-0">
          {active === 'builder' && <RuleBuilderTab onSelectStock={onSelectStock} />}
          {active === 'combo' && <ComboFinderTab />}
          {active === 'kayal' && <KayalAioTab onSelectStock={onSelectStock} />}
        </section>
        <p className="bsi-intel-note">Screener results are a starting filter, not a recommendation. NOT FINANCIAL ADVICE.</p>
      </div>
    </V1PageFrame>
  );
}
