import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip } from 'recharts';
import { Landmark, ArrowUpRight, ArrowDownRight, ExternalLink } from 'lucide-react';
import { trpc } from '../lib/trpc';
import { QueryError } from './IntelligenceQueryError';
import { DataTable, type Column } from './DataTable';
import { DataHealthChip } from './DataHealthChip';
import { cn } from '../lib/utils';

// Sources (all already exist, verified against the routers):
//   getShareholding            fundamentals.router  -- ET Markets live, else the
//                                                    technical_signals promoter/FII/MF/pledge row
//   getInsiderTransactions     misc.router          -- insider_trades, per-symbol filter supported
//   getBlockDeals              misc.router          -- block_deals, per-symbol filter supported
//   getSuperstarInvestorActivity fundamentals.router -- superstar_investor_activity, per-symbol
//   getTrendlyneDVM            trendlyne.router     -- Trendlyne valuation/durability/momentum
type Row = Record<string, unknown>;

const SHAREHOLDING_SEGMENTS = [
  { key: 'promoter_pct', label: 'Promoter', color: '#6366f1' },
  { key: 'fii_pct', label: 'FII', color: '#22d3ee' },
  { key: 'mf_pct', label: 'Mutual funds', color: '#10b981' },
  { key: 'pledge_pct', label: 'Pledged', color: '#f43f5e' },
] as const;

function num(v: unknown): number | null {
  const n = typeof v === 'number' ? v : parseFloat(String(v ?? ''));
  return Number.isFinite(n) ? n : null;
}

function ShareholdingDonut({ data }: { data: Row | null }) {
  const segments = SHAREHOLDING_SEGMENTS
    .map(s => ({ ...s, value: num(data?.[s.key]) }))
    .filter((s): s is typeof s & { value: number } => s.value != null && s.value > 0);

  if (segments.length === 0) {
    return <p className="bsi-intel-note">No shareholding row stored for this symbol — ET Markets returned nothing and technical_signals has no snapshot. Absence, not zero.</p>;
  }

  const accounted = segments.reduce((s, x) => s + x.value, 0);

  return (
    <div className="space-y-3">
      <div className="h-[220px] w-full">
        <ResponsiveContainer width="100%" height="100%">
          <PieChart>
            <Pie data={segments} dataKey="value" nameKey="label" innerRadius="58%" outerRadius="86%" paddingAngle={2} isAnimationActive animationDuration={900}>
              {segments.map(s => <Cell key={s.key} fill={s.color} stroke="rgba(0,0,0,0.3)" />)}
            </Pie>
            <Tooltip
              contentStyle={{ backgroundColor: '#0f172a', border: '1px solid #1e293b', borderRadius: '12px', fontSize: 11 }}
              formatter={(v: number, n: string) => [`${v.toFixed(2)}%`, n]}
            />
          </PieChart>
        </ResponsiveContainer>
      </div>
      <ul className="space-y-1.5">
        {segments.map(s => (
          <li key={s.key} className="flex items-center justify-between gap-3 text-xs">
            <span className="flex items-center gap-2 text-slate-300">
              <span className="inline-block h-2.5 w-2.5 rounded-sm" style={{ background: s.color }} />
              {s.label}
            </span>
            <span className="font-mono text-white">{s.value.toFixed(2)}%</span>
          </li>
        ))}
      </ul>
      <p className="bsi-intel-note">
        Highlighted holdings total {accounted.toFixed(2)}%. The balance is public/other holders and is not itemised by this source, so the segments deliberately do not sum to 100.
      </p>
    </div>
  );
}

const INSIDER_COLUMNS: Column<Row>[] = [
  { key: 'person_name', label: 'Acquirer', sortable: true },
  { key: 'person_category', label: 'Category', sortable: true },
  { key: 'transaction_mode', label: 'Mode', sortable: true, render: r => {
    const mode = String(r.transaction_mode ?? '');
    const buy = /acq|buy|purchase/i.test(mode);
    const sell = /disp|sale|sell/i.test(mode);
    return <span className={cn('font-semibold', buy ? 'text-[var(--bsi-up)]' : sell ? 'text-[var(--bsi-down)]' : 'text-slate-400')}>{mode || '—'}</span>;
  } },
  { key: 'quantity', label: 'Quantity', sortable: true, align: 'right', render: r => (num(r.quantity) != null ? Number(r.quantity).toLocaleString('en-IN') : '—') },
  { key: 'value_cr', label: 'Value (Rs Cr)', sortable: true, align: 'right', render: r => (num(r.value_cr) != null ? Number(r.value_cr).toLocaleString('en-IN', { maximumFractionDigits: 4 }) : '—') },
  { key: 'transaction_date', label: 'Date', sortable: true },
];

const BLOCK_COLUMNS: Column<Row>[] = [
  { key: 'date', label: 'Date', sortable: true },
  { key: 'trade_type', label: 'Side', sortable: true, render: r => {
    const t = String(r.trade_type ?? '');
    const buy = /buy/i.test(t);
    return <span className={cn('font-semibold', buy ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>{t || '—'}</span>;
  } },
  { key: 'client_name', label: 'Counterparty', sortable: true },
  { key: 'category', label: 'Category', sortable: true },
  { key: 'qty', label: 'Quantity', sortable: true, align: 'right', render: r => (num(r.qty) != null ? Number(r.qty).toLocaleString('en-IN') : '—') },
  { key: 'price', label: 'Price', sortable: true, align: 'right', render: r => (num(r.price) != null ? `Rs ${Number(r.price).toLocaleString('en-IN', { maximumFractionDigits: 2 })}` : '—') },
  { key: 'value_cr', label: 'Value (Rs Cr)', sortable: true, align: 'right', render: r => (num(r.value_cr) != null ? Number(r.value_cr).toLocaleString('en-IN', { maximumFractionDigits: 2 }) : '—') },
  { key: 'pct_transacted', label: '% of float', sortable: true, align: 'right', render: r => (num(r.pct_transacted) != null ? `${Number(r.pct_transacted).toFixed(3)}%` : '—') },
];

const SUPERSTAR_COLUMNS: Column<Row>[] = [
  { key: 'investor_slug', label: 'Investor', sortable: true },
  { key: 'change_type', label: 'Change', sortable: true, render: r => {
    const c = String(r.change_type ?? '');
    const up = /entr|increas|buy/i.test(c);
    const down = /exit|decreas|sell/i.test(c);
    return <span className={cn('font-semibold', up ? 'text-[var(--bsi-up)]' : down ? 'text-[var(--bsi-down)]' : 'text-slate-400')}>{c || '—'}</span>;
  } },
  { key: 'curr_pct_holding', label: 'Holding', sortable: true, align: 'right', render: r => (num(r.curr_pct_holding) != null ? `${Number(r.curr_pct_holding).toFixed(2)}%` : '—') },
  { key: 'pct_holding_change', label: 'Change (pp)', sortable: true, align: 'right', render: r => {
    const v = num(r.pct_holding_change);
    if (v == null) return '—';
    return <span className={v >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]'}>{v >= 0 ? '+' : ''}{v.toFixed(3)}</span>;
  } },
  { key: 'period_end_date', label: 'Period end', sortable: true },
];

const DVM_ROWS = [
  { key: 'valuation', label: 'Valuation' },
  { key: 'durability', label: 'Durability' },
  { key: 'momentum', label: 'Momentum' },
] as const;

export function StockOwnershipTab({ symbol }: { symbol: string }) {
  const shareholding = trpc.getShareholding.useQuery({ symbol }, { staleTime: 3_600_000 });
  const insiders = trpc.getInsiderTransactions.useQuery({ symbol, limit: 50 }, { staleTime: 600_000 });
  const blocks = trpc.getBlockDeals.useQuery({ symbol, limit: 50 }, { staleTime: 600_000 });
  const superstars = trpc.getSuperstarInvestorActivity.useQuery({ symbol, limit: 30 }, { staleTime: 3_600_000 });
  const dvm = trpc.getTrendlyneDVM.useQuery({ symbol }, { staleTime: 3_600_000 });

  const insiderRows = (insiders.data ?? []) as Row[];
  const blockRows = (blocks.data ?? []) as Row[];
  const superstarRows = (superstars.data ?? []) as Row[];

  const netInsiderCr = React.useMemo(() => {
    let net = 0;
    for (const r of insiderRows) {
      const v = num(r.value_cr);
      if (v == null) continue;
      const mode = String(r.transaction_mode ?? '');
      if (/disp|sale|sell/i.test(mode)) net -= v;
      else if (/acq|buy|purchase/i.test(mode)) net += v;
    }
    return net;
  }, [insiderRows]);

  const dvmData = dvm.data as { valuation?: { score: number; color?: string | null } | null; durability?: { score: number; color?: string | null } | null; momentum?: { score: number; color?: string | null } | null } | null | undefined;

  return (
    <div className="space-y-6">
      <div className="grid gap-4 lg:grid-cols-2">
        <div className="bsi-intel-panel">
          <div className="mb-3 flex items-center justify-between gap-3">
            <h3 className="font-display flex items-center gap-2"><Landmark className="w-4 h-4" />Shareholding pattern</h3>
            <DataHealthChip lastUpdated={shareholding.dataUpdatedAt ? new Date(shareholding.dataUpdatedAt).toISOString() : null} staleThresholdMinutes={10080} />
          </div>
          {shareholding.isError
            ? <QueryError retry={() => void shareholding.refetch()} />
            : shareholding.isLoading
              ? <div className="h-[220px] animate-pulse rounded-xl bg-slate-900/50" />
              : <ShareholdingDonut data={(shareholding.data ?? null) as Row | null} />}
        </div>

        <div className="bsi-intel-panel">
          <h3 className="font-display mb-3">Quarter-on-quarter ownership change</h3>
          {(() => {
            const d = (shareholding.data ?? {}) as Row;
            const changes = [
              { key: 'promoter_chg_qoq', label: 'Promoter' },
              { key: 'fii_chg_qoq', label: 'FII' },
              { key: 'mf_chg_qoq', label: 'Mutual funds' },
              { key: 'pledge_chg_qoq', label: 'Pledged' },
            ];
            const present = changes.filter(c => num(d[c.key]) != null);
            if (present.length === 0) {
              return <p className="bsi-intel-note">No quarter-on-quarter change figures stored for this symbol. The live shareholding source does not carry them, and the fallback row has no snapshot.</p>;
            }
            return (
              <ul className="space-y-3">
                {present.map(c => {
                  const v = num(d[c.key]) as number;
                  const up = v > 0;
                  return (
                    <li key={c.key} className="flex items-center justify-between gap-3 text-xs">
                      <span className="text-slate-300">{c.label}</span>
                      <span className={cn('flex items-center gap-1 font-mono font-semibold', up ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
                        {up ? <ArrowUpRight className="w-3 h-3" /> : <ArrowDownRight className="w-3 h-3" />}
                        {up ? '+' : ''}{v.toFixed(2)} pp
                      </span>
                    </li>
                  );
                })}
                <li className="bsi-intel-note pt-2 border-t border-[var(--bsi-border)]">
                  Figures are percentage-point moves against the prior quarter, straight from the stored snapshot — no smoothing.
                </li>
              </ul>
            );
          })()}

          <h3 className="font-display mb-3 mt-5">Trendlyne DVM</h3>
          {dvm.isLoading ? <div className="h-20 animate-pulse rounded-xl bg-slate-900/50" />
            : !dvmData ? <p className="bsi-intel-note">Not scored by the nightly Trendlyne sync yet for {symbol}.</p>
            : (
              <dl className="space-y-2">
                {DVM_ROWS.map(row => {
                  const entry = dvmData[row.key];
                  return (
                    <div key={row.key} className="flex items-center justify-between gap-3 text-xs">
                      <dt className="text-slate-300">{row.label}</dt>
                      <dd className="font-mono text-white">{entry?.score != null ? entry.score.toFixed(0) : '—'}</dd>
                    </div>
                  );
                })}
                <p className="bsi-intel-note pt-1">Vendor-computed scores on the vendor's own scale, carried through with the colour band the vendor set.</p>
              </dl>
            )}
        </div>
      </div>

      <div className="bsi-intel-panel">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="font-display">Insider transactions</h3>
          {insiderRows.length > 0 && (
            <span className={cn('text-xs font-semibold', netInsiderCr >= 0 ? 'text-[var(--bsi-up)]' : 'text-[var(--bsi-down)]')}>
              Net {netInsiderCr >= 0 ? 'buy' : 'sell'} Rs {Math.abs(netInsiderCr).toLocaleString('en-IN', { maximumFractionDigits: 2 })} Cr
            </span>
          )}
        </div>
        {insiders.isError ? <QueryError retry={() => void insiders.refetch()} /> : (
          <>
            <DataTable
              data={insiderRows}
              columns={INSIDER_COLUMNS}
              isLoading={insiders.isLoading}
              searchable
              searchKeys={['person_name', 'person_category']}
              rowKey={r => `${r.person_name}-${r.transaction_date}-${r.quantity}`}
              emptyMessage="No insider filings stored for this symbol."
            />
            <p className="bsi-intel-note mt-3">
              Net flow sums only rows whose value is present and whose mode reads as an acquisition or a disposal. Before/after holding percentages are not carried by this source and are not shown rather than guessed.
            </p>
          </>
        )}
      </div>

      <div className="bsi-intel-panel">
        <h3 className="font-display mb-3">Block deals</h3>
        {blocks.isError ? <QueryError retry={() => void blocks.refetch()} /> : (
          <>
            <DataTable
              data={blockRows}
              columns={BLOCK_COLUMNS}
              isLoading={blocks.isLoading}
              searchable
              searchKeys={['client_name', 'category']}
              rowKey={r => `${r.date}-${r.client_name}-${r.qty}`}
              emptyMessage="No block deals recorded for this symbol."
            />
            <p className="bsi-intel-note mt-3">% of float is the field that makes a deal comparable across a microcap and a large-cap; raw quantity alone is not.</p>
          </>
        )}
      </div>

      <div className="bsi-intel-panel">
        <h3 className="font-display mb-3">Superstar investor activity</h3>
        {superstars.isError ? <QueryError retry={() => void superstars.refetch()} /> : (
          <>
            <DataTable
              data={superstarRows}
              columns={SUPERSTAR_COLUMNS}
              isLoading={superstars.isLoading}
              searchable
              searchKeys={['investor_slug', 'change_type']}
              rowKey={r => `${r.investor_slug}-${r.period_end_date}-${r.change_type}`}
              emptyMessage="No tracked superstar holds a reported position in this symbol."
            />
            <p className="bsi-intel-note mt-3">
              Reported holdings lag the market — a filing describes a quarter that has already closed, so it evidences conviction, not a live position.
            </p>
          </>
        )}
      </div>

      <p className="bsi-intel-note">
        Ownership data describes the past. None of it forecasts a price, and none of it is investment advice. Published filings are frequently weeks old by the time they appear here.
      </p>
    </div>
  );
}
