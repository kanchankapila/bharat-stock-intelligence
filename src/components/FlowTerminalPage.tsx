import React from 'react';
import { Handshake } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { V1PageFrame } from './v1/V1PageFrame';
import { TabBar, type TabItem } from './TabBar';
import { QueryError } from './IntelligenceQueryError';
import { MetricTile } from './MetricTile';
import { DataTable, type Column } from './DataTable';

const TABS: TabItem[] = [
  { id: 'block', label: 'Block Deals' },
  { id: 'insider', label: 'Insider Transactions' },
  { id: 'superstar', label: 'Superstar Activity' },
];

type Row = Record<string, unknown>;

function matchesFilter(row: Row, filter: string): boolean {
  if (!filter) return true;
  const f = filter.trim().toUpperCase();
  return String(row.symbol ?? '').toUpperCase().includes(f);
}

function SymbolFilter({ value, onChange, label }: { value: string; onChange: (v: string) => void; label: string }) {
  return (
    <label className="bsi-intel-note">
      {label}
      <input
        className="bsi-control block mt-1"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Filter by symbol (loaded rows)"
        maxLength={30}
      />
    </label>
  );
}

const BLOCK_COLUMNS: Column<Row>[] = [
  { key: 'date', label: 'Date', sortable: true },
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'trade_type', label: 'Side' },
  { key: 'qty', label: 'Qty', sortable: true, render: (r) => (typeof r.qty === 'number' ? r.qty.toLocaleString('en-IN') : '—') },
  { key: 'price', label: 'Price', sortable: true, render: (r) => (typeof r.price === 'number' ? `₹${r.price.toFixed(2)}` : '—') },
  { key: 'value_cr', label: 'Value (₹Cr)', sortable: true, render: (r) => (typeof r.value_cr === 'number' ? r.value_cr.toFixed(2) : '—') },
  { key: 'pct_transacted', label: '% of float', sortable: true, render: (r) => (typeof r.pct_transacted === 'number' ? `${r.pct_transacted.toFixed(2)}%` : '—') },
  { key: 'client_name', label: 'Counterparty' },
  { key: 'category', label: 'Category' },
];

function BlockDealsTab() {
  const [filter, setFilter] = React.useState('');
  const query = trpc.getBlockDeals.useQuery({ limit: 200 }, { staleTime: 300_000 });
  const rows = ((query.data ?? []) as Row[]).filter((r) => matchesFilter(r, filter));
  const totalValue = rows.reduce((sum, r) => (typeof r.value_cr === 'number' ? sum + r.value_cr : sum), 0);
  return (
    <div className="space-y-4">
      <SymbolFilter value={filter} onChange={setFilter} label="Symbol filter" />
      <div className="grid grid-cols-2 xl:grid-cols-4 gap-3">
        <MetricTile label="Deals shown" value={rows.length} loading={query.isLoading} />
        <MetricTile label="Combined value (₹Cr)" value={totalValue ? totalValue.toFixed(1) : '—'} loading={query.isLoading} />
        <MetricTile label="Stored rows (max 200)" value={(query.data ?? []).length} loading={query.isLoading} />
      </div>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      <DataTable
        data={rows}
        columns={BLOCK_COLUMNS}
        isLoading={query.isLoading}
        rowKey={(r, i) => `${r.symbol}-${r.date}-${i}`}
        emptyMessage="No block deals stored. block_deals is written by tickertape/block-deal fetchers."
      />
      <p className="bsi-intel-note">pct_transacted (% of float) is the comparable-size field; raw qty/value alone is not comparable across cap sizes. Historical feed — not a real-time tape.</p>
    </div>
  );
}

const INSIDER_COLUMNS: Column<Row>[] = [
  { key: 'transaction_date', label: 'Date', sortable: true },
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'person_name', label: 'Acquirer' },
  { key: 'person_category', label: 'Category' },
  { key: 'transaction_mode', label: 'Mode' },
  { key: 'quantity', label: 'Qty', sortable: true, render: (r) => (typeof r.quantity === 'number' ? r.quantity.toLocaleString('en-IN') : '—') },
  { key: 'value_cr', label: 'Value (₹Cr)', sortable: true, render: (r) => (typeof r.value_cr === 'number' ? r.value_cr.toFixed(2) : '—') },
];

export function InsiderTab() {
  const [filter, setFilter] = React.useState('');
  const query = trpc.getInsiderTransactions.useQuery({ limit: 200 }, { staleTime: 300_000 });
  const rows = ((query.data ?? []) as Row[]).filter((r) => matchesFilter(r, filter));
  return (
    <div className="space-y-4">
      <SymbolFilter value={filter} onChange={setFilter} label="Symbol filter" />
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      <DataTable
        data={rows}
        columns={INSIDER_COLUMNS}
        isLoading={query.isLoading}
        rowKey={(r, i) => `${r.symbol}-${r.transaction_date}-${i}`}
        emptyMessage="No insider transactions stored in insider_trades (MoneyControl + Tickertape source)."
      />
      <p className="bsi-intel-note">Source: insider_trades (repointed 2026-08-14 off NSE's frozen insider_transactions table). This source carries no before/after % holding — those columns are null by design, not missing by accident.</p>
    </div>
  );
}


const CHANGE_TYPES = ['all', 'entry', 'exit', 'increase', 'decrease'] as const;

const SUPERSTAR_COLUMNS: Column<Row>[] = [
  { key: 'fetched_at', label: 'Fetched', sortable: true },
  { key: 'period_end_date', label: 'Period end', sortable: true },
  { key: 'symbol', label: 'Symbol', sortable: true },
  { key: 'investor_name', label: 'Investor' },
  { key: 'change_type', label: 'Change' },
  { key: 'pct_holding_change', label: 'Δ holding %', sortable: true },
  { key: 'curr_pct_holding', label: 'Holding %', sortable: true },
];

function SuperstarTab() {
  const [changeType, setChangeType] = React.useState<(typeof CHANGE_TYPES)[number]>('all');
  const query = trpc.getSuperstarActivityFeed.useQuery(
    { changeType: changeType === 'all' ? undefined : changeType, limit: 60 },
    { staleTime: 300_000 },
  );
  return (
    <div className="space-y-4">
      <label className="bsi-intel-note">Change type
        <select className="bsi-control block mt-1" value={changeType} onChange={(e) => setChangeType(e.target.value as typeof changeType)}>
          {CHANGE_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}
        </select>
      </label>
      {query.isError && <QueryError retry={() => void query.refetch()} />}
      <DataTable
        data={(query.data ?? []) as Row[]}
        columns={SUPERSTAR_COLUMNS}
        isLoading={query.isLoading}
        rowKey={(r, i) => `${r.symbol}-${r.investor_slug}-${r.period_end_date}-${i}`}
        emptyMessage="No superstar activity rows for this filter (superstar_investor_activity, InvestSights-sourced)."
      />
      <p className="bsi-intel-note">Quarterly disclosure-based holding changes by named investors (Ashish Kacholia, Vijay Kedia, et al.). Disclosure lag means this is context, not a real-time signal.</p>
    </div>
  );
}

export default function FlowTerminalPage() {
  const [tab, setTab] = React.useState('block');
  return (
    <V1PageFrame title="Institutional Flow Terminal" kicker="BLOCK DEALS / INSIDER / SUPERSTARS">
      <div className="bsi-intel-hero">
        <div>
          <span className="bsi-intel-eyebrow">05 / FOLLOW THE MONEY</span>
          <h2 className="font-display text-2xl sm:text-3xl mt-2">Who is actually trading.</h2>
          <p className="bsi-intel-note mt-2">Block deals, insider transactions and named-investor holding changes in one terminal.</p>
        </div>
        <Handshake size={44} className="text-sky-400 shrink-0" aria-hidden="true" />
      </div>
      <TabBar tabs={TABS} active={tab} onChange={setTab} />
      <section role="tabpanel" aria-label={TABS.find((t) => t.id === tab)?.label} className="bsi-intel-panel min-w-0">
        {tab === 'block' && <BlockDealsTab />}
        {tab === 'insider' && <InsiderTab />}
        {tab === 'superstar' && <SuperstarTab />}
      </section>
      <p className="bsi-intel-note">Ownership and flow context, not advice — disclosure-based data lags the market by design. NOT FINANCIAL ADVICE.</p>
    </V1PageFrame>
  );
}
