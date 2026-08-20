import { Activity, ArrowDownRight, ArrowUpRight, Radio, Target } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart, V5Sparkline } from '../components/V5Visuals';
import { stockDisplayName } from '../stockIdentity';

export function SignalReviewPage({ onSelectSymbol }: { onSelectSymbol?: (symbol: string) => void }) {
  const reportQ = trpc.getSignalReportCard.useQuery(undefined, {
    refetchInterval: 120_000,
    refetchOnWindowFocus: true,
  });

  const trackingQ = trpc.getSignalTracking.useQuery({ days: 30 }, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });

  const queueQ = trpc.getQueueStats.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const sourceSummary = reportQ.data?.sourceSummary ?? [];
  const recent = (trackingQ.data ?? []).slice(0, 40);
  const totalSignals = sourceSummary.reduce((sum: number, x: any) => sum + n(x.total_signals), 0);
  const activeSignals = sourceSummary.reduce((sum: number, x: any) => sum + n(x.active_signals), 0);
  const avgConfidence = sourceSummary.length
    ? sourceSummary.reduce((sum: number, x: any) => sum + n(x.avg_confidence_score), 0) / sourceSummary.length
    : 0;
  const queuePending = numOrNull((queueQ.data as any)?.pending);
  const confidenceBars = sourceSummary
    .slice(0, 6)
    .map((x: any) => ({
      label: s(x.signal_source, 'Source').slice(0, 10),
      value: numOrNull(x.avg_confidence_score),
      colorClass: 'v5-mini-fill-indigo',
      suffix: '%',
    }));
  const winner = sourceSummary
    .filter((x: any) => numOrNull(x.avg_confidence_score) != null)
    .sort((a: any, b: any) => Number(b.avg_confidence_score) - Number(a.avg_confidence_score))[0];
  const loser = sourceSummary
    .filter((x: any) => numOrNull(x.avg_confidence_score) != null)
    .sort((a: any, b: any) => Number(a.avg_confidence_score) - Number(b.avg_confidence_score))[0];
  const growthSeries = recent
    .slice()
    .reverse()
    .map((row: any) => numOrNull(row.growth_pct));
  const avgGrowth = growthSeries.filter((x): x is number => x != null).length
    ? growthSeries.filter((x): x is number => x != null).reduce((sum, x) => sum + x, 0) /
      growthSeries.filter((x): x is number => x != null).length
    : null;

  const kpis = [
    { label: 'Total Signals', value: String(totalSignals) },
    { label: 'Active Signals', value: String(activeSignals) },
    { label: 'Avg Confidence', value: `${avgConfidence.toFixed(1)}%`, tone: avgConfidence >= 60 ? 'positive' as const : 'warning' as const, pct: avgConfidence },
    { label: 'Queue Pending', value: queuePending == null ? '—' : String(queuePending) },
  ];

  const reviewInsights = [
    `Active/Total utilization: ${activeSignals}/${totalSignals} live signals tracked in the current window.`,
    winner
      ? `Top confidence engine: ${s(winner.signal_source)} at ${fmtFixed(winner.avg_confidence_score, 1)}%.`
      : 'Top confidence engine unavailable from current data.',
    loser && winner
      ? `Confidence dispersion: ${fmtFixed(winner.avg_confidence_score, 1)}% vs ${fmtFixed(loser.avg_confidence_score, 1)}%.`
      : 'Confidence dispersion unavailable until multiple sources are populated.',
    avgGrowth == null ? 'Signal growth trend unavailable.' : `Average signal growth in the displayed ledger is ${fmtFixed(avgGrowth, 2)}%.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            `Signal utilization is ${activeSignals}/${totalSignals} active signals in this cycle.`,
            winner
              ? `${s(winner.signal_source)} leads confidence at ${fmtFixed(winner.avg_confidence_score, 1)}%.`
              : 'Source confidence ranking is not available yet.',
            avgGrowth == null
              ? 'Recent growth trend is unavailable from ledger rows.'
              : `Average tracked growth is ${fmtFixed(avgGrowth, 2)}% across recent signals.`,
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="mb-3 flex items-center gap-2">
          <Radio className="h-4 w-4 text-[var(--v5-positive)]" />
          <h2 className="v5-title text-lg font-semibold">Signal Review</h2>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <Summary title="Total Signals" value={String(totalSignals)} icon={<Activity className="h-4 w-4 text-sky-700" />} />
          <Summary title="Active Signals" value={String(activeSignals)} icon={<Target className="h-4 w-4 text-[var(--v5-positive)]" />} />
          <Summary title="Avg Confidence" value={`${avgConfidence.toFixed(1)}%`} icon={<Radio className="h-4 w-4 text-indigo-700" />} />
          <Summary title="Queue Pending" value={queuePending == null ? '—' : String(queuePending)} icon={<Activity className="h-4 w-4 text-[var(--v5-warning)]" />} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <h3 className="v5-title mb-3 text-base font-semibold">Live Signal Ledger</h3>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--v5-border)] text-left text-xs uppercase tracking-wide text-[var(--v5-muted)]">
                <th className="px-3 py-2">Stock</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Type</th>
                <th className="px-3 py-2">Entry</th>
                <th className="px-3 py-2">Current</th>
                <th className="px-3 py-2">Growth</th>
                <th className="px-3 py-2">Generated</th>
              </tr>
            </thead>
            <tbody>
              {recent.map((row: any) => {
                const growth = numOrNull(row.growth_pct);
                const entry = numOrNull(row.entry_price);
                const current = numOrNull(row.current_price);
                const sym = s(row.symbol);
                return (
                  <tr key={String(row.id)} className="v5-table-row-intel border-b border-[var(--v5-border)]">
                    <td className="px-3 py-2 font-semibold text-[var(--v5-ink)]">
                      <button
                        onClick={() => sym && onSelectSymbol?.(sym)}
                        className="text-left hover:text-[var(--v5-positive)]"
                        title="Open stock intelligence"
                      >
                        <div>{stockDisplayName(sym, sym)}</div>
                        <div className="text-[11px] font-medium text-[var(--v5-muted)]">{sym}</div>
                      </button>
                    </td>
                    <td className="px-3 py-2">{s(row.signal_source)}</td>
                    <td className="px-3 py-2">{s(row.signal_type)}</td>
                    <td className="px-3 py-2">{entry == null ? '—' : `₹${fmtFixed(entry, 2)}`}</td>
                    <td className="px-3 py-2">{current == null ? '—' : `₹${fmtFixed(current, 2)}`}</td>
                    <td className="px-3 py-2">
                      {growth == null ? (
                        <span className="text-[var(--v5-muted)]">—</span>
                      ) : (
                        <span className={growth >= 0 ? 'inline-flex items-center gap-1 text-[var(--v5-positive)]' : 'inline-flex items-center gap-1 text-[var(--v5-negative)]'}>
                          {growth >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                          {growth >= 0 ? '+' : ''}{fmtFixed(growth, 2)}%
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-[var(--v5-muted)]">{s(row.signal_generated_at).slice(0, 10)}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!recent.length && <p className="py-6 text-center text-sm text-[var(--v5-muted)]">No signals available in the selected window.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <h3 className="v5-title mb-3 text-base font-semibold">Engine Source Health</h3>
        <div className="mb-3 grid gap-3">
          <V5MiniBarChart title="Confidence by Source" items={confidenceBars} />
          <V5Sparkline title="Recent Signal Growth Trend" values={growthSeries} colorClass="v5-sparkline-stroke-rose" />
          <V5InsightPanel title="Review Insights" insights={reviewInsights} />
        </div>
        <div className="space-y-2">
          {sourceSummary.map((src: any) => (
            <div key={s(src.signal_source)} className="rounded-xl border border-[var(--v5-border)] p-3">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-[var(--v5-ink)]">{s(src.signal_source)}</div>
                <div className="text-xs text-[var(--v5-muted)]">{n(src.active_signals)} active</div>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <div className="text-[var(--v5-muted)]">Total</div>
                  <div className="font-semibold text-[var(--v5-ink-soft)]">{n(src.total_signals)}</div>
                </div>
                <div>
                  <div className="text-[var(--v5-muted)]">Avg Conf</div>
                  <div className="font-semibold text-[var(--v5-ink-soft)]">{fmtFixed(src.avg_confidence_score, 1)}%</div>
                </div>
                <div>
                  <div className="text-[var(--v5-muted)]">Age</div>
                  <div className="font-semibold text-[var(--v5-ink-soft)]">{fmtFixed(src.avg_age_days, 1)}d</div>
                </div>
              </div>
            </div>
          ))}
          {!sourceSummary.length && <p className="text-sm text-[var(--v5-muted)]">Signal source summary unavailable.</p>}
        </div>
      </div>
    </section>
  );
}

function Summary({ title, value, icon }: { title: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
      <div className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">{icon}{title}</div>
      <div className="mt-1 text-xl font-bold text-[var(--v5-ink)]">{value}</div>
    </div>
  );
}
