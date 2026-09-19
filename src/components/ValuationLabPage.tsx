import React from 'react';
import { Filter, Plus, Trash2, Search, TrendingUp, TrendingDown, RefreshCw } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { TabBar, type TabItem } from './TabBar';
import { QueryError } from './IntelligenceQueryError';
import { DataTable, type Column } from './DataTable';
import { percentPoint } from '../lib/intelligenceDisplay';

const TABS: TabItem[] = [
  { id: 'builder', label: 'Rule Builder' },
  { id: 'combo', label: 'Combo Finder' },
  { id: 'kayal', label: 'Kayal AIO Screener' },
];

type CriteriaCategory = Record<string, { id: string; name: string; type: string }>;
type Rule = { id: string; name: string; operator: 'gt' | 'lt' | 'eq' | 'gte' | 'lte'; value: string };
type Row = Record<string, unknown>;

const OPERATORS = [
  { value: 'gt', label: 'Greater than' },
  { value: 'lt', label: 'Less than' },
  { value: 'eq', label: 'Equal to' },
  { value: 'gte', label: 'Greater or equal' },
  { value: 'lte', label: 'Less or equal' },
] as const;

const RESULT_COLUMNS: Column<Row>[] = [
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'name', label: 'Name', sortable: true },
  { key: 'price', label: 'Price', sortable: true, align: 'right', render: r => (typeof r.price === 'number' ? `₹${r.price.toFixed(2)}` : '—') },
  { key: 'changePct', label: '% Chg', sortable: true, align: 'right', render: r => {
    if (typeof r.changePct !== 'number') return '—';
    const cls = r.changePct >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]';
    const ico = r.changePct >= 0 ? <TrendingUp className="w-3 h-3 inline" /> : <TrendingDown className="w-3 h-3 inline" />;
    return <span className={cls}>{ico}{r.changePct.toFixed(2)}%</span>;
  }},
  { key: 'rank_composite', label: 'Rank', sortable: true, align: 'right', render: r => percentPoint(r.rank_composite, 0) },
  { key: 'momentum_score', label: 'Momentum', sortable: true, align: 'right', render: r => percentPoint(r.momentum_score) },
  { key: 'valuation_score', label: 'Value', sortable: true, align: 'right', render: r => percentPoint(r.valuation_score) },
  { key: 'trailing_pe', label: 'P/E', sortable: true, align: 'right', render: r => (typeof r.trailing_pe === 'number' ? r.trailing_pe.toFixed(2) : '—') },
  { key: 'debt_to_equity', label: 'D/E', sortable: true, align: 'right', render: r => (typeof r.debt_to_equity === 'number' ? r.debt_to_equity.toFixed(2) : '—') },
  { key: 'return_on_equity', label: 'ROE', sortable: true, align: 'right', render: r => percentPoint(r.return_on_equity) },
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
      searchKeys={['symbol', 'name']}
      onRowClick={onSymbolClick ? (row) => onSymbolClick(String(row.symbol)) : undefined}
function RuleBuilderTab({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const criteriaQuery = trpc.getScreenerCriteria.useQuery();
  const allRows = React.useMemo(() => {
    const flat: { id: string; name: string; type: string; category: string }[] = [];
    const cat = (criteriaQuery.data ?? {}) as CriteriaCategory;
    Object.entries(cat).forEach(([category, arr]) => arr.forEach(c => flat.push({ ...c, category })));
    return flat;
  }, [criteriaQuery.data]);

  const [rules, setRules] = React.useState<Rule[]>([]);
  const [currentId, setCurrentId] = React.useState('');
  const [currentOp, setCurrentOp] = React.useState<Rule['operator']>('gt');
  const [currentVal, setCurrentVal] = React.useState('');
  const [results, setResults] = React.useState<Row[] | null>(null);
  const [isRunning, setIsRunning] = React.useState(false);

  const selected = allRows.find(r => r.id === currentId);
  const addCriterion = () => {
    if (!currentId || !selected || !currentVal) return;
    setRules([...rules, { id: `${currentId}-${Date.now()}`, name: selected.name, operator: currentOp, value: currentVal }]);
    setCurrentId(''); setCurrentVal('');
  };
  const removeRule = (id: string) => setRules(rules.filter(r => r.id !== id));
  const runScreener = async () => {
    if (rules.length === 0) return;
    setIsRunning(true); setResults(null);
    const payload = rules.map(r => ({ id: r.name, operator: r.operator, value: r.value }));
    try {
      const res = await trpc.runScreener.mutate(payload as any);
      setResults(Array.isArray(res) ? res : []);
    } catch { setResults(null); }
    setIsRunning(false);
  };

  if (criteriaQuery.isLoading) return <div className="bsi-intel-note">Loading criteria…</div>;
  if (criteriaQuery.isError) return <QueryError retry={() => void criteriaQuery.refetch()} />;

  return (
    <div className="space-y-4">
      <div className="bsi-intel-panel">
        <h3 className="font-display mb-3">Build a Screener Rule</h3>
        <div className="grid gap-4 sm:grid-cols-2 md:grid-cols-5 items-end">
          <div className="sm:col-span-2">
            <label className="bsi-intel-note text-[10px]">Field</label>
            <select className="bsi-control mt-1 w-full" value={currentId} onChange={e => { setCurrentId(e.target.value); const found = allRows.find(r => r.id === e.target.value); if (found) setCurrentVal(''); }}>
              <option value="">Select a criterion</option>
              {allRows.map(r => <option key={r.id} value={r.id}>{r.name} <span className="text-slate-500">({r.category})</span></option>)}
            </select>
          </div>
          <div><label className="bsi-intel-note text-[10px]">Operator</label>
            <select className="bsi-control mt-1 w-full" value={currentOp} onChange={e => setCurrentOp(e.target.value as Rule['operator'])}>
              {OPERATORS.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
            </select>
          </div>
          <div><label className="bsi-intel-note text-[10px]">Value</label>
            <input type="number" step="any" className="bsi-control mt-1 w-full" value={currentVal} onChange={e => setCurrentVal(e.target.value)} placeholder={selected?.type === 'boolean' ? '0 or 1' : 'e.g. 15'} disabled={!selected} />
          </div>
          <button type="button" onClick={addCriterion} disabled={!currentId || !currentVal} className="bsi-action h-9 mt-1"><Plus className="w-3.5 h-3.5" />Add</button>
        </div>
        {rules.length > 0 && (<div className="mt-4 space-y-2">
          <h4 className="text-[10px] font-black text-slate-500 font-display uppercase tracking-wider">Active Rules ({rules.length})</h4>
          <div className="flex flex-wrap gap-2">{rules.map(r => (<div key={r.id} className="flex items-center gap-1.5 px-2.5 py-1 bg-slate-800/40 border border-slate-700/50 rounded-md text-[11px]">
            <span className="font-mono text-white">{r.name}</span>
            <span className="text-slate-500">{OPERATORS.find(o => o.value === r.operator)?.label ?? r.operator}</span>
            <span className="font-mono text-slate-300">{r.value}</span>
            <button onClick={() => removeRule(r.id)} className="ml-1 text-slate-500 hover:text-rose-400"><Trash2 className="w-3 h-3" /></button>
          </div>))}
          </div>
        </div>)}

function ComboFinderTab() {
  const tier1 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 1 });
  const tier2 = trpc.getScreenerComboFinderStatus.useQuery({ tier: 2 });

  return (
    <div className="space-y-4">
      <div className="bsi-intel-panel">
        <h3 className="font-display mb-3">Tier 1 — Validated (deep history)</h3>
        {tier1.isLoading ? <p className="bsi-intel-note">Loading…</p> : !tier1.data ? <p className="bsi-intel-note">No data.</p> : (
          <div className="space-y-3">
            {tier1.data?.best && (
              <div className="flex flex-col gap-2 p-3 bg-emerald-500/5 border border-emerald-500/20 rounded-xl">
                <div className="text-xs font-black text-emerald-400 font-display uppercase">REAL EDGE</div>
                <code className="text-[11px] text-white font-mono break-all">{tier1.data.best.filters.join(' + ')}</code>
                <div className="text-[10px] text-slate-400 mt-1">
                  {tier1.data.best.spread_pct.toFixed(3)}% spread vs universe · t={tier1.data.best.t_stat.toFixed(2)} · p={tier1.data.best.p_value.toFixed(4)} · {tier1.data.best.n_signals} signals across {tier1.data.best.n_days} days
                </div>
              </div>
            )}
            {!tier1.data?.best && <p className="bsi-intel-note">No combination cleared minimum sample thresholds.</p>}
          </div>
        )}
      </div>
      {tier2.data && (
        <div className="bsi-intel-panel opacity-70">
          <h3 className="font-display mb-3">Tier 2 — Low-data (directional only)</h3>
          <p className="bsi-intel-note text-[10px]">{tier2.data.n_days_history} days of live/EOD screener history — not enough to trust significance either way.</p>
          {tier2.data?.best && <code className="text-[11px] text-white font-mono break-all">{tier2.data.best.filters.join(' + ')} (p={tier2.data.best.p_value.toFixed(3)})</code>}
        </div>
function KayalAioTab({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const [screenpk, setScreenpk] = React.useState('');
  const [submitted, setSubmitted] = React.useState('');
  const [limit, setLimit] = React.useState(50);
  const query = trpc.getKayalScreener.useQuery(
    { screenpk: submitted, limit }, { enabled: !!submitted, staleTime: 300_000 }
  );

  const handleSubmit = (e: React.FormEvent) => { e.preventDefault(); if (screenpk.trim()) setSubmitted(screenpk.trim()); };

  const columns: Column<Row>[] = [
    { key: 'symbol', label: 'Symbol', sortable: true },
    { key: 'name', label: 'Name', sortable: true },
    { key: 'price', label: 'Price', sortable: true, align: 'right', render: r => (typeof r.price === 'number' ? `₹${r.price.toFixed(2)}` : '—') },
    { key: 'changePct', label: '% Chg', sortable: true, align: 'right', render: r => {
      if (typeof r.changePct !== 'number') return '—';
      return r.changePct >= 0 ? <span className="text-[var(--bsi-up)]">+{r.changePct.toFixed(2)}%</span> : <span className="text-[var(--bsi-down)]">{r.changePct.toFixed(2)}%</span>;
    }},
    { key: 'volume', label: 'Volume', sortable: true, align: 'right' },
    { key: 'marketCap', label: 'Mkt Cap', sortable: true, align: 'right' },
    { key: 'peRatio', label: 'P/E', sortable: true, align: 'right', render: r => (typeof r.peRatio === 'number' ? r.peRatio.toFixed(2) : '—') },
  ];

  return (
    <div className="space-y-4">
      <form onSubmit={handleSubmit} className="flex flex-wrap items-end gap-3">
        <label className="bsi-intel-note">Screen PK<input type="text" className="bsi-control block mt-1" value={screenpk} onChange={e => setScreenpk(e.target.value)} placeholder="e.g. 9230" required /></label>
        <label className="bsi-intel-note">Limit<input type="number" min={1} max={200} className="bsi-control block mt-1 w-20" value={limit} onChange={e => setLimit(Number(e.target.value))} /></label>
        <button type="submit" disabled={query.isFetching || !submitted} className="bsi-action h-9"><Search className="w-3.5 h-3.5" />Load</button>
      </form>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      {submitted && (
        <div className="space-y-2">
          <p className="bsi-intel-note">Screen PK: <code>{submitted}</code> · {query.data?.body?.tableData?.length ?? 0} rows</p>
          {query.isLoading ? <p className="bsi-intel-note">Loading results…</p> : query.data?.body?.tableData ? (() => {
            const { tableHeaders, tableData } = query.data.body;
            const headerNames = tableHeaders.map((h: any) => h?.name || String(h));
            const dataRows = tableData.map((row: any[], i: number) => { const obj: Record<string, unknown> = { _id: i }; headerNames.forEach((name, idx) => { obj[name] = row[idx]; }); return obj; });
            return <DataTable data={dataRows} columns={columns} searchable searchKeys={['symbol']} onRowClick={onSelectStock ? r => onSelectStock(String(r.symbol)) : undefined} rowKey={r => String(r._id)} emptyMessage="No results for this screen." />;
          })() : <p className="bsi-intel-note">Enter a screen PK and click Load.</p>}
        </div>
      )}
    </div>
  );
}

export default function ValuationLabPage({ onSelectStock }: { onSelectStock?: (symbol: string) => void }) {
  const [active, setActive] = React.useState('builder');
  return (
    <V1PageFrame title="Valuation Laboratory" kicker="SCREENING / RULE BUILDER / COMBO ANALYSIS">
      <div className="space-y-6">
        <div className="bsi-intel-hero">
          <div>
            <span className="bsi-intel-eyebrow">06 / LABORATORY</span>
            <h2 className="font-display text-2xl sm:text-3xl mt-2">Valuation Laboratory</h2>
            <p className="bsi-intel-note mt-2">Build custom screens, inspect combo finder results, and load Trendlyne Kayal all-in-one screeners. Rules hit the live runScreener mutation — no synthetic data.</p>
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
      )}
    </div>
  );
}

      </div>
      <div className="flex gap-3">
        <button onClick={runScreener} disabled={rules.length === 0 || isRunning} className="bsi-action">
          {isRunning ? <><RefreshCw className="w-3.5 h-3.5 animate-spin" />Running…</> : <><Filter className="w-3.5 h-3.5" />Run Screener</>}
        </button>
      </div>
      {results !== null && (<div className="space-y-2"><p className="bsi-intel-note">Results: {results.length} stock{results.length !== 1 ? 's' : ''}</p><ResultView data={results} onSymbolClick={onSelectStock} /></div>)}
    </div>
  );
}

      rowKey={row => String(row.symbol)}
      emptyMessage="No stocks match the selected criteria."
    />
  );
}

