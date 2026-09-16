import { useMemo } from 'react';
import { Landmark } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { fmtFixed, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5DeskSkeleton, V5InsightPanel, V5MiniBarChart, V5Sparkline } from '../components/V5Visuals';

type FlowRow = {
  date: string;
  fii_buy: number | null;
  fii_sell: number | null;
  fii_net: number | null;
  dii_buy: number | null;
  dii_sell: number | null;
  dii_net: number | null;
};

function signedCr(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtFixed(v, 0)} Cr`;
}

export function InstitutionalFlowDeskPage() {
  const flowQ = trpc.getFiiDiiFlow.useQuery({ days: 30 }, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const detailsQ = trpc.getInstitutionalFlows.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const rows = (flowQ.data ?? []) as FlowRow[];
  const latest = rows[0] ?? null;

  const fiiNet = numOrNull(latest?.fii_net);
  const diiNet = numOrNull(latest?.dii_net);
  const net = (fiiNet ?? 0) + (diiNet ?? 0);

  const fiiSeries = useMemo(() => rows.slice(0, 20).reverse().map((r) => numOrNull(r.fii_net)), [rows]);
  const diiSeries = useMemo(() => rows.slice(0, 20).reverse().map((r) => numOrNull(r.dii_net)), [rows]);
  const netSeries = useMemo(() => rows.slice(0, 20).reverse().map((r) => {
    const f = numOrNull(r.fii_net);
    const d = numOrNull(r.dii_net);
    if (f == null && d == null) return null;
    return (f ?? 0) + (d ?? 0);
  }), [rows]);

  const bars = [
    { label: 'FII Net', value: fiiNet, colorClass: fiiNet == null ? 'v5-mini-fill-neutral' : fiiNet < 0 ? 'v5-mini-fill-rose' : 'v5-mini-fill-teal' },
    { label: 'DII Net', value: diiNet, colorClass: diiNet == null ? 'v5-mini-fill-neutral' : diiNet < 0 ? 'v5-mini-fill-rose' : 'v5-mini-fill-teal' },
    { label: 'Net', value: net, colorClass: net == null ? 'v5-mini-fill-neutral' : net < 0 ? 'v5-mini-fill-rose' : 'v5-mini-fill-teal' },
  ];

  const kpis = [
    { label: 'Latest Date', value: s(latest?.date, '—') },
    { label: 'FII Net', value: signedCr(fiiNet), tone: fiiNet == null ? 'neutral' as const : fiiNet < 0 ? 'negative' as const : 'positive' as const },
    { label: 'DII Net', value: signedCr(diiNet), tone: diiNet == null ? 'neutral' as const : diiNet < 0 ? 'negative' as const : 'positive' as const },
    { label: 'Combined Net', value: signedCr(net), tone: net == null ? 'neutral' as const : net < 0 ? 'negative' as const : 'positive' as const },
  ];

  const institutionalDetails = (detailsQ.data as any)?.data?.institutionalDetails ?? [];

  const summaryItems = [
    latest ? `Latest settled flow date is ${latest.date}.` : 'Latest flow date unavailable.',
    `Combined institutional net flow is ${net >= 0 ? 'supportive' : 'cautious'} at ${signedCr(net)}.`,
    `Detailed source feed rows loaded: ${institutionalDetails.length}.`,
  ];

  const insights = [
    rows.length ? `Trend window has ${rows.length} daily rows.` : 'No historical rows in selected flow window.',
    fiiNet == null ? 'FII snapshot unavailable.' : `FII net is ${signedCr(fiiNet)} on latest row.`,
    diiNet == null ? 'DII snapshot unavailable.' : `DII net is ${signedCr(diiNet)} on latest row.`,
  ];

  if (flowQ.isLoading && detailsQ.isLoading) return <V5DeskSkeleton />;

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip title="Institutional Flow Summary" items={summaryItems} />
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <div className="mb-3 flex items-center gap-2">
          <Landmark className="h-4 w-4 text-[var(--v5-positive)]" />
          <h2 className="v5-title text-lg font-semibold">Flow Snapshot</h2>
        </div>

        <div className="grid gap-3">
          <V5MiniBarChart title="Current Session Flow" items={bars} />
          <V5InsightPanel title="Flow Insights" insights={insights} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <h3 className="v5-title mb-3 text-base font-semibold">Flow Trends (Last 20 Sessions)</h3>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
          <V5Sparkline title="FII Net Trend" values={fiiSeries} colorClass="v5-sparkline-stroke-rose" />
          <V5Sparkline title="DII Net Trend" values={diiSeries} colorClass="v5-sparkline-stroke-teal" />
          <V5Sparkline title="Combined Net Trend" values={netSeries} colorClass="v5-sparkline-stroke-indigo" />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4">
        <h3 className="v5-title mb-3 text-base font-semibold">Institutional Detail Feed</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--v5-border)] text-left text-xs uppercase tracking-wide text-[var(--v5-muted)]">
                <th className="px-3 py-2">Category</th>
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Buy</th>
                <th className="px-3 py-2">Sell</th>
                <th className="px-3 py-2">Net</th>
              </tr>
            </thead>
            <tbody>
              {institutionalDetails.map((row: any, i: number) => {
                // Number(null) is 0 in JS, not NaN -- Number.isFinite(netVal) would read a
                // missing value as a genuine flat 0 and color it positive. Check nullness
                // directly instead (live 2026-08-14: fii_dii_flow.dii_net is NULL on 1,908/2,601
                // rows, no longer coerced to "0.00" by the backend as of this same fix).
                const netVal = row.netBuySell != null ? Number(row.netBuySell) : null;
                return (
                  <tr key={`${s(row.category)}-${i}`} className="v5-table-row-intel border-b border-[var(--v5-border)]">
                    <td className="px-3 py-2 font-semibold text-[var(--v5-ink)]">{s(row.category, '—')}</td>
                    <td className="px-3 py-2 text-[var(--v5-ink-soft)]">{s(row.date, '—')}</td>
                    <td className="px-3 py-2 text-[var(--v5-ink-soft)]">{row.buyValue ?? '—'}</td>
                    <td className="px-3 py-2 text-[var(--v5-ink-soft)]">{row.sellValue ?? '—'}</td>
                    <td className={`px-3 py-2 font-semibold ${netVal != null && Number.isFinite(netVal) ? (netVal >= 0 ? 'text-[var(--v5-positive)]' : 'text-[var(--v5-negative)]') : 'text-[var(--v5-ink-soft)]'}`}>
                      {row.netBuySell ?? '—'}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!institutionalDetails.length && <p className="py-4 text-sm text-[var(--v5-muted)]">No institutional detail rows available right now.</p>}
        </div>
      </div>
    </section>
  );
}
