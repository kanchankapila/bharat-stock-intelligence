import { Activity, ArrowDownRight, ArrowUpRight, CandlestickChart, Newspaper, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, fmtPct, n, numOrNull, pctClass, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart, V5Sparkline } from '../components/V5Visuals';

const PRESET_INDICES = [
  { key: 'nifty50', label: 'NIFTY 50' },
  { key: 'sensex', label: 'SENSEX' },
  { key: 'bankNifty', label: 'BANK NIFTY' },
] as const;

export function MarketPulsePage() {
  const marketQ = trpc.getMarketOverview.useQuery(undefined, {
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });
  const moversQ = trpc.getTopMovers.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const activityQ = trpc.getActivityFeed.useQuery(
    { hours: 24, limit: 35 },
    { refetchInterval: 60_000, refetchOnWindowFocus: true },
  );

  const data = marketQ.data ?? {};
  const indexCards = PRESET_INDICES.map((idx) => {
    const d = (data as any)[idx.key] ?? {};
    return {
      label: idx.label,
      value: numOrNull(d.value),
      change: numOrNull(d.change),
      changePct: numOrNull(d.changePct),
    };
  });

  const gainers = moversQ.data?.topGainers?.slice(0, 10) ?? [];
  const losers = moversQ.data?.topLosers?.slice(0, 10) ?? [];
  const feed = activityQ.data?.items ?? [];
  const avgGainer = gainers.length
    ? gainers.reduce((sum: number, x: any) => sum + n(x.change_percent), 0) / gainers.length
    : null;
  const avgLoser = losers.length
    ? losers.reduce((sum: number, x: any) => sum + Math.abs(n(x.change_percent)), 0) / losers.length
    : null;
  const strongestIndex = indexCards
    .filter((x) => x.changePct != null)
    .sort((a, b) => Number(b.changePct) - Number(a.changePct))[0];
  const hourlyActivity = (() => {
    const buckets = new Array<number>(24).fill(0);
    feed.forEach((item: any) => {
      const ts = s(item.timestamp);
      const d = ts ? new Date(ts) : null;
      if (d && !Number.isNaN(d.getTime())) {
        buckets[d.getHours()] += 1;
      }
    });
    return buckets;
  })();
  const peakHour = hourlyActivity
    .map((count, h) => ({ h, count }))
    .sort((a, b) => b.count - a.count)[0];

  const kpis = [
    { label: 'NIFTY 50', value: indexCards[0]?.value == null ? '—' : fmtFixed(indexCards[0].value, 2) },
    { label: 'Gainers / Losers', value: `${gainers.length}/${losers.length}` },
    { label: 'Activity Events', value: String(feed.length) },
    { label: 'Breadth Bias', value: gainers.length >= losers.length ? 'Positive' : 'Negative', tone: gainers.length >= losers.length ? 'positive' as const : 'negative' as const },
  ];

  const breadthInsights = [
    `Breadth: ${gainers.length} gainers vs ${losers.length} losers in top movers list.`,
    avgGainer == null || avgLoser == null
      ? 'Momentum spread unavailable until both gainer and loser baskets are populated.'
      : `Momentum spread: avg gainer ${fmtFixed(avgGainer, 2)}% vs avg loser ${fmtFixed(avgLoser, 2)}%.`,
    strongestIndex?.changePct == null
      ? 'Index leadership unavailable from current snapshot.'
      : `${strongestIndex.label} is leading at ${fmtPct(strongestIndex.changePct, 2)} in this snapshot.`,
    peakHour && peakHour.count > 0
      ? `Activity concentration highest around ${String(peakHour.h).padStart(2, '0')}:00 with ${peakHour.count} events.`
      : 'Hourly activity concentration is not available yet.',
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            `${gainers.length} gainers vs ${losers.length} losers in live movers.`,
            strongestIndex?.changePct == null
              ? 'Index leadership is unavailable in this snapshot.'
              : `${strongestIndex.label} currently leads at ${fmtPct(strongestIndex.changePct, 2)}.`,
            peakHour && peakHour.count > 0
              ? `Peak market activity is near ${String(peakHour.h).padStart(2, '0')}:00 (${peakHour.count} events).`
              : 'Activity rhythm is building and will appear as events stream in.',
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-8">
        <div className="v5-section-head">
          <div>
            <div className="flex items-center gap-2">
              <CandlestickChart className="h-4 w-4 text-[var(--v5-positive)]" />
              <h2 className="v5-section-title">Index Pulse</h2>
            </div>
            <p className="v5-section-subtitle">Benchmark direction and intraday delta spread across core indices.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          {indexCards.map((x) => (
            <div key={x.label} className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-4">
              <div className="text-[11px] font-semibold tracking-wide text-[var(--v5-muted)]">{x.label}</div>
              <div className="mt-1 text-xl font-bold text-[var(--v5-ink)]">{x.value == null ? '—' : fmtFixed(x.value, 2)}</div>
              {x.change == null || x.changePct == null ? (
                <div className="mt-1 text-sm font-semibold text-[var(--v5-muted)]">—</div>
              ) : (
                <div className={`mt-1 flex items-center gap-1 text-sm font-semibold ${pctClass(x.changePct)}`}>
                  {x.change >= 0 ? <ArrowUpRight className="h-3.5 w-3.5" /> : <ArrowDownRight className="h-3.5 w-3.5" />}
                  <span>{x.change >= 0 ? '+' : ''}{fmtFixed(x.change, 2)}</span>
                  <span>({x.changePct >= 0 ? '+' : ''}{fmtPct(x.changePct, 2)})</span>
                </div>
              )}
            </div>
          ))}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-4">
        <div className="v5-section-head">
          <div>
            <div className="flex items-center gap-2">
              <Activity className="h-4 w-4 text-sky-700" />
              <h2 className="v5-section-title">Live Movers</h2>
            </div>
            <p className="v5-section-subtitle">Real-time gainers and losers from the active session tape.</p>
          </div>
        </div>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 lg:grid-cols-1">
          <div>
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-[var(--v5-positive)]"><TrendingUp className="h-4 w-4" /> Gainers</div>
            <div className="space-y-2">
              {gainers.map((m: any) => (
                      <div key={s(m.symbol_name)} className="v5-table-row-intel flex items-center justify-between rounded-xl border border-[var(--v5-border)] px-3 py-2">
                  <span className="text-xs font-semibold text-[var(--v5-ink-soft)]">{s(m.symbol_name)}</span>
                  <span className="text-xs font-bold text-[var(--v5-positive)]">{numOrNull(m.change_percent) == null ? '—' : `+${fmtFixed(m.change_percent, 2)}%`}</span>
                </div>
              ))}
            </div>
          </div>
          <div>
            <div className="mb-2 mt-3 flex items-center gap-2 text-sm font-semibold text-[var(--v5-negative)]"><TrendingDown className="h-4 w-4" /> Losers</div>
            <div className="space-y-2">
              {losers.map((m: any) => (
                      <div key={s(m.symbol_name)} className="v5-table-row-intel flex items-center justify-between rounded-xl border border-[var(--v5-border)] px-3 py-2">
                  <span className="text-xs font-semibold text-[var(--v5-ink-soft)]">{s(m.symbol_name)}</span>
                  <span className="text-xs font-bold text-[var(--v5-negative)]">{numOrNull(m.change_percent) == null ? '—' : `${fmtFixed(m.change_percent, 2)}%`}</span>
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-3 grid gap-3">
          <V5MiniBarChart
            title="Breadth Magnitude"
            items={[
              { label: 'Avg Gainer', value: avgGainer, colorClass: 'v5-mini-fill-teal', suffix: '%' },
              { label: 'Avg Loser', value: avgLoser, colorClass: 'v5-mini-fill-rose', suffix: '%' },
            ]}
          />
          <V5InsightPanel title="Quick Insights" insights={breadthInsights} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="v5-section-head">
          <div>
            <div className="flex items-center gap-2">
              <Newspaper className="h-4 w-4 text-[var(--v5-warning)]" />
              <h2 className="v5-section-title">Market Activity Feed</h2>
            </div>
            <p className="v5-section-subtitle">Chronological market events, signal triggers, and notable updates.</p>
          </div>
        </div>
        <div className="v5-compact-scroll space-y-2 pr-1">
          {feed.map((item: any, i: number) => (
            <div key={`${s(item.symbol)}-${i}`} className="v5-table-row-intel rounded-xl border border-[var(--v5-border)] p-3">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="font-semibold text-[var(--v5-ink)]">{s(item.symbol, s(item.title, 'Market Event'))}</div>
                <span className="text-[11px] text-[var(--v5-muted)]">{s(item.timeLabel, s(item.timestamp))}</span>
              </div>
              <p className="mt-1 text-sm text-[var(--v5-ink-muted)]">{s(item.summary, s(item.reasoning, ''))}</p>
            </div>
          ))}
          {!feed.length && <p className="text-sm text-[var(--v5-muted)]">No fresh events in the selected window.</p>}
        </div>
        <div className="mt-3">
          <V5Sparkline
            title="24H Activity Rhythm"
            values={hourlyActivity}
            colorClass="v5-sparkline-stroke-indigo"
            minLabel="00:00"
            maxLabel="23:00"
          />
        </div>
      </div>
    </section>
  );
}
