import { useMemo, useState } from 'react';
import { Filter, Layers3, Search } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';
import { stockDisplayName } from '../stockIdentity';

export function ScreenerLabPage({ onSelectSymbol }: { onSelectSymbol?: (symbol: string) => void }) {
  const [minBullish, setMinBullish] = useState(2);
  const [minScore, setMinScore] = useState(55);
  const [conviction, setConviction] = useState<'ALL' | 'S_ELITE' | 'A_HIGH' | 'B_MEDIUM' | 'C_LOW' | 'D_MARGINAL'>('ALL');
  const [source, setSource] = useState<'all' | 'trendlyne' | 'moneycontrol' | 'etnow'>('all');
  const [query, setQuery] = useState('');

  const universeQ = trpc.getScreenerConfluenceUniverse.useQuery(
    {
      minBullishScreeners: minBullish,
      excludeBearishSignals: true,
      minUnifiedScore: minScore,
      conviction,
      limit: 120,
    },
    { refetchInterval: 120_000, refetchOnWindowFocus: true },
  );

  const boardQ = trpc.getScreenerLeaderboard.useQuery(
    {
      horizon: '20d',
      source: source === 'all' ? undefined : source,
      limit: 40,
      offset: 0,
    },
    { refetchInterval: 180_000, refetchOnWindowFocus: true },
  );

  const stocks = universeQ.data?.stocks ?? [];

  const filtered = useMemo(() => {
    if (!query.trim()) return stocks;
    const q = query.trim().toUpperCase();
    return stocks.filter((x: any) => s(x.symbol).includes(q) || s(x.sector).toUpperCase().includes(q));
  }, [stocks, query]);

  const leaderboardRows = boardQ.data ?? [];
  const avgUnified = filtered.length
    ? filtered.reduce((sum: number, row: any) => sum + n(row.unified_score), 0) / filtered.length
    : null;
  const avgBullish = filtered.length
    ? filtered.reduce((sum: number, row: any) => sum + n(row.bullish_screener_count), 0) / filtered.length
    : null;
  const avgBearish = filtered.length
    ? filtered.reduce((sum: number, row: any) => sum + n(row.bearish_screener_count), 0) / filtered.length
    : null;
  const eliteCount = filtered.filter((row: any) => s(row.conviction_level) === 'S_ELITE').length;
  const kpis = [
    { label: 'Universe', value: String(n(universeQ.data?.universeSize)) },
    { label: 'Filtered', value: String(filtered.length) },
    { label: 'Leaders', value: String(leaderboardRows.length) },
    { label: 'Source Lens', value: source === 'all' ? 'ALL' : source.toUpperCase() },
  ];

  const screenerInsights = [
    `Filtered universe: ${filtered.length} from ${n(universeQ.data?.universeSize)} symbols.`,
    avgUnified == null ? 'Average unified score unavailable.' : `Average unified score in shortlist: ${fmtFixed(avgUnified, 1)}.`,
    avgBullish == null || avgBearish == null
      ? 'Confluence depth unavailable for this filter.'
      : `Average confluence depth: ${fmtFixed(avgBullish, 2)} bullish vs ${fmtFixed(avgBearish, 2)} bearish screens.`,
    `Elite conviction count: ${eliteCount}.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            `Confluence shortlist is ${filtered.length} from a ${n(universeQ.data?.universeSize)}-symbol universe.`,
            avgUnified == null
              ? 'Unified-score average is unavailable for the current filter.'
              : `Average unified score is ${fmtFixed(avgUnified, 1)} with ${eliteCount} elite-conviction symbols.`,
            avgBullish == null || avgBearish == null
              ? 'Bullish/bearish screener balance is pending for this filter set.'
              : `Average screen balance is ${fmtFixed(avgBullish, 2)} bullish vs ${fmtFixed(avgBearish, 2)} bearish.`,
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Layers3 className="h-4 w-4 text-teal-700" />
            <h2 className="v5-title text-lg font-semibold">Screener Lab</h2>
          </div>
          <div className="relative min-w-[220px]">
            <Search className="pointer-events-none absolute left-3 top-2.5 h-4 w-4 text-slate-400" />
            <input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Search symbol / sector"
              className="w-full rounded-xl border border-slate-300 bg-white py-2 pl-9 pr-3 text-sm outline-none ring-teal-200 focus:ring"
            />
          </div>
        </div>

        <div className="mb-3 grid grid-cols-1 gap-2 md:grid-cols-4 xl:grid-cols-6">
          <Control label="Min Bullish Screens">
            <input type="number" min={1} max={10} value={minBullish} onChange={(e) => setMinBullish(Math.max(1, Math.min(10, Number(e.target.value) || 2)))} className="v5-input" />
          </Control>
          <Control label="Min Unified Score">
            <input type="number" min={0} max={100} value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(100, Number(e.target.value) || 0)))} className="v5-input" />
          </Control>
          <Control label="Conviction Filter">
            <select value={conviction} onChange={(e) => setConviction(e.target.value as any)} className="v5-input">
              <option value="ALL">ALL</option>
              <option value="S_ELITE">S_ELITE</option>
              <option value="A_HIGH">A_HIGH</option>
              <option value="B_MEDIUM">B_MEDIUM</option>
              <option value="C_LOW">C_LOW</option>
              <option value="D_MARGINAL">D_MARGINAL</option>
            </select>
          </Control>
          <Control label="Leaderboard Source">
            <select value={source} onChange={(e) => setSource(e.target.value as any)} className="v5-input">
              <option value="all">All</option>
              <option value="trendlyne">Trendlyne</option>
              <option value="moneycontrol">MoneyControl</option>
              <option value="etnow">ETnow</option>
            </select>
          </Control>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Universe</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{numOrNull(universeQ.data?.universeSize) == null ? '—' : String(n(universeQ.data?.universeSize))}</div>
          </div>
          <div className="rounded-xl border border-slate-200 bg-slate-50 p-2">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Filtered</div>
            <div className="mt-1 text-xl font-bold text-slate-900">{numOrNull(universeQ.data?.filteredCount) == null ? '—' : String(n(universeQ.data?.filteredCount))}</div>
          </div>
        </div>

        <div className="mb-4 grid grid-cols-1 gap-3 xl:grid-cols-2">
          <V5MiniBarChart
            title="Confluence Averages"
            items={[
              { label: 'Unified', value: avgUnified, colorClass: 'v5-mini-fill-indigo' },
              { label: 'Bullish', value: avgBullish, colorClass: 'v5-mini-fill-teal' },
              { label: 'Bearish', value: avgBearish, colorClass: 'v5-mini-fill-rose' },
            ]}
          />
          <V5InsightPanel title="Screening Insights" insights={screenerInsights} />
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Stock</th>
                <th className="px-3 py-2">Unified</th>
                <th className="px-3 py-2">Bull/Bear</th>
                <th className="px-3 py-2">Conviction</th>
                <th className="px-3 py-2">Risk/Reward</th>
                <th className="px-3 py-2">Sector</th>
                <th className="px-3 py-2">Action</th>
              </tr>
            </thead>
            <tbody>
              {filtered.slice(0, 120).map((row: any) => {
                const sym = s(row.symbol);
                return (
                <tr key={sym} className="v5-table-row-intel border-b border-slate-100">
                  <td className="px-3 py-2 font-semibold text-slate-800">
                    <button
                      onClick={() => onSelectSymbol?.(sym)}
                      className="text-left hover:text-teal-700"
                      title="Open stock intelligence"
                    >
                      <div>{stockDisplayName(sym, sym)}</div>
                      <div className="text-[11px] font-medium text-slate-500">{sym}</div>
                    </button>
                  </td>
                  <td className="px-3 py-2">{fmtFixed(row.unified_score, 1)}</td>
                  <td className="px-3 py-2">{n(row.bullish_screener_count)}/{n(row.bearish_screener_count)}</td>
                  <td className="px-3 py-2">{s(row.conviction_level, '—')}</td>
                  <td className="px-3 py-2">{fmtFixed(row.risk_reward, 2)}</td>
                  <td className="px-3 py-2">{s(row.sector, 'Unclassified')}</td>
                  <td className="px-3 py-2">
                    <button
                      onClick={() => onSelectSymbol?.(sym)}
                      className="rounded-lg border border-slate-300 px-2 py-1 text-xs font-semibold hover:bg-slate-100"
                    >
                      Open
                    </button>
                  </td>
                </tr>
              );})}
            </tbody>
          </table>
          {!filtered.length && <p className="py-6 text-center text-sm text-slate-500">No symbols matched your screener stack.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="mb-2 flex items-center gap-2">
          <Filter className="h-4 w-4 text-sky-700" />
          <h3 className="v5-title text-base font-semibold">Screener Reliability Leaderboard</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Screener</th>
                <th className="px-3 py-2">Source</th>
                <th className="px-3 py-2">Tier</th>
                <th className="px-3 py-2">Win Rate</th>
                <th className="px-3 py-2">Bayesian</th>
                <th className="px-3 py-2">Resolved</th>
              </tr>
            </thead>
            <tbody>
              {leaderboardRows.map((row: any) => (
                <tr key={`${s(row.source)}-${s(row.screener_id)}`} className="v5-table-row-intel border-b border-slate-100">
                  <td className="px-3 py-2 text-slate-700">{s(row.name)}</td>
                  <td className="px-3 py-2">{s(row.source)}</td>
                  <td className="px-3 py-2">{s(row.tier, 'Unranked')}</td>
                  <td className="px-3 py-2">{fmtFixed(row.win_rate, 1)}%</td>
                  <td className="px-3 py-2">{fmtFixed(row.bayesian_score, 2)}</td>
                  <td className="px-3 py-2">{n(row.resolved_count)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}

function Control({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="rounded-xl border border-slate-200 bg-slate-50 p-2">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className="mt-1">{children}</div>
    </label>
  );
}
