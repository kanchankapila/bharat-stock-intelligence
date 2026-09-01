import { useMemo } from 'react';
import { CalendarClock, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { fmtFixed, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5DeskSkeleton, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

export function EarningsPulseDeskPage({
  onSelectSymbol,
}: {
  onSelectSymbol?: (symbol: string) => void;
}) {
  const earningsQ = trpc.getEarnings.useQuery(undefined, {
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const data = earningsQ.data as any;
  const dash = data?.dashboard?.data;
  const earningsList: any[] = data?.earningsData?.data?.list ?? [];
  const shockers: any[] = data?.priceShockers?.data?.list ?? [];

  const totalResults = numOrNull(dash?.totalResults);
  const beat = numOrNull(dash?.beat);
  const miss = numOrNull(dash?.miss);
  const inLine = numOrNull(dash?.inLine);

  const surpriseBars = [
    { label: 'Beat', value: beat, colorClass: 'v5-mini-fill-teal' },
    { label: 'Miss', value: miss, colorClass: 'v5-mini-fill-rose' },
    { label: 'In-Line', value: inLine, colorClass: 'v5-mini-fill-indigo' },
  ];

  const avgProfitGrowth = (() => {
    const vals = earningsList
      .map((x) => numOrNull((x as any).netProfitGrowth))
      .filter((x): x is number => x != null);
    if (!vals.length) return null;
    return vals.reduce((sum, v) => sum + v, 0) / vals.length;
  })();

  const positiveShockers = shockers.filter((x) => numOrNull((x as any).changePercent) != null && Number((x as any).changePercent) > 0).length;
  const negativeShockers = shockers.filter((x) => numOrNull((x as any).changePercent) != null && Number((x as any).changePercent) < 0).length;

  const kpis = [
    { label: 'Results Declared', value: totalResults == null ? '—' : String(totalResults) },
    {
      label: 'Beat', value: beat == null ? '—' : String(beat),
      tone: beat != null && miss != null && beat >= miss ? 'positive' as const : 'warning' as const,
      pct: beat != null && miss != null && beat + miss > 0 ? (beat / (beat + miss)) * 100 : undefined,
    },
    { label: 'Miss', value: miss == null ? '—' : String(miss), tone: miss != null && beat != null && miss > beat ? 'negative' as const : 'neutral' as const },
    { label: 'Price Shockers', value: String(shockers.length) },
  ];

  const summaryItems = [
    totalResults == null
      ? 'Earnings dashboard totals are unavailable right now.'
      : `${totalResults} result events in the current earnings window.`,
    beat == null || miss == null
      ? 'Beat vs miss split is pending from upstream payload.'
      : `Earnings split: ${beat} beat vs ${miss} miss (${inLine ?? 0} in-line).`,
    avgProfitGrowth == null
      ? 'Average net-profit growth is unavailable from reported names.'
      : `Average net-profit growth across listed companies is ${fmtFixed(avgProfitGrowth, 2)}%.`,
  ];

  const earningsInsights = [
    shockers.length
      ? `Price shockers loaded: ${positiveShockers} positive and ${negativeShockers} negative moves.`
      : 'No price-shocker rows available at the moment.',
    earningsList.length
      ? `${earningsList.length} earnings rows are available for stock-level drill-down.`
      : 'No stock-level earnings list entries available in the payload.',
    'Click a symbol to open the dedicated Stock Intelligence desk for deeper analysis.',
  ];

  if (earningsQ.isLoading) return <V5DeskSkeleton />;

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip title="Earnings Decision Summary" items={summaryItems} />
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <div className="mb-3 flex items-center gap-2">
          <CalendarClock className="h-4 w-4 text-[var(--v5-positive)]" />
          <h2 className="v5-title text-lg font-semibold">Earnings Pulse</h2>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-2">
          <MetricCard label="Declared" value={totalResults == null ? '—' : String(totalResults)} />
          <MetricCard label="Beat" value={beat == null ? '—' : String(beat)} toneClass="text-[var(--v5-positive)]" />
          <MetricCard label="Miss" value={miss == null ? '—' : String(miss)} toneClass="text-[var(--v5-negative)]" />
          <MetricCard label="In-Line" value={inLine == null ? '—' : String(inLine)} />
        </div>

        <div className="mt-3 grid gap-3">
          <V5MiniBarChart title="Earnings Outcome Mix" items={surpriseBars} />
          <V5InsightPanel title="Quick Insights" insights={earningsInsights} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <h3 className="v5-title mb-3 text-base font-semibold">Result Declarations</h3>
        <div className="v5-compact-scroll space-y-2 pr-1">
          {earningsList.slice(0, 80).map((item: any, i: number) => {
            const sym = s(item.symbol, s(item.companyShortName, '—'));
            const npGrowth = numOrNull(item.netProfitGrowth);
            return (
              <button
                key={`${sym}-${i}`}
                onClick={() => item.symbol && onSelectSymbol?.(item.symbol)}
                className="v5-table-row-intel w-full rounded-xl border border-[var(--v5-border)] bg-[var(--v5-surface)] p-3 text-left hover:bg-[var(--v5-surface-2)]"
              >
                <div className="flex items-center justify-between gap-2">
                  <div>
                    <div className="text-sm font-semibold text-[var(--v5-ink)]">{s(item.companyName, sym)}</div>
                    <div className="text-xs text-[var(--v5-muted)]">{s(item.symbol, '—')}</div>
                  </div>
                  {npGrowth == null ? (
                    <span className="text-xs text-[var(--v5-muted)]">—</span>
                  ) : (
                    <span className={`inline-flex items-center gap-1 text-xs font-semibold ${npGrowth >= 0 ? 'text-[var(--v5-positive)]' : 'text-[var(--v5-negative)]'}`}>
                      {npGrowth >= 0 ? <TrendingUp className="h-3.5 w-3.5" /> : <TrendingDown className="h-3.5 w-3.5" />}
                      {npGrowth >= 0 ? '+' : ''}{fmtFixed(npGrowth, 2)}%
                    </span>
                  )}
                </div>
              </button>
            );
          })}
          {!earningsList.length && <p className="text-sm text-[var(--v5-muted)]">No results declared in current payload.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4">
        <h3 className="v5-title mb-3 text-base font-semibold">Price Shockers Around Results</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--v5-border)] text-left text-xs uppercase tracking-wide text-[var(--v5-muted)]">
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Company</th>
                <th className="px-3 py-2">Change %</th>
                <th className="px-3 py-2">LTP</th>
              </tr>
            </thead>
            <tbody>
              {shockers.slice(0, 80).map((row: any, i: number) => {
                const chg = numOrNull(row.changePercent);
                const sym = s(row.symbol);
                return (
                  <tr key={`${sym}-${i}`} className="v5-table-row-intel border-b border-[var(--v5-border)]">
                    <td className="px-3 py-2 font-semibold text-[var(--v5-ink)]">
                      <button
                        onClick={() => sym && onSelectSymbol?.(sym)}
                        className="text-left hover:text-[var(--v5-positive)]"
                        title="Open stock intelligence"
                      >
                        <div>{s(row.companyName, sym || '—')}</div>
                        <div className="text-[11px] font-medium text-[var(--v5-muted)]">{sym || '—'}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2 text-[var(--v5-ink-soft)]">{s(row.companyName, '—')}</td>
                    <td className="px-3 py-2">
                      <span className={chg == null ? 'text-[var(--v5-muted)]' : (chg >= 0 ? 'text-[var(--v5-positive)] font-semibold' : 'text-[var(--v5-negative)] font-semibold')}>
                        {chg == null ? '—' : `${chg >= 0 ? '+' : ''}${fmtFixed(chg, 2)}%`}
                      </span>
                    </td>
                    <td className="px-3 py-2 text-[var(--v5-ink-soft)]">{numOrNull(row.currentPrice) == null ? '—' : `₹${fmtFixed(row.currentPrice, 2)}`}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!shockers.length && <p className="py-6 text-center text-sm text-[var(--v5-muted)]">No shocker rows available right now.</p>}
        </div>
      </div>
    </section>
  );
}

function MetricCard({ label, value, toneClass = 'text-[var(--v5-ink)]' }: { label: string; value: string; toneClass?: string }) {
  return (
    <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">{label}</div>
      <div className={`mt-1 text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}
