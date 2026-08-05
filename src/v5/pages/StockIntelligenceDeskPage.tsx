import { useMemo, useState } from 'react';
import { Activity, BadgeDollarSign, CalendarClock, Layers3, Newspaper, Search, ShieldCheck, UserCircle2 } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, fmtINR, n, numOrNull, pctClass, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

type StockTab = 'overview' | 'financials' | 'earnings' | 'ownership' | 'screeners' | 'news';

const TABS: { id: StockTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'financials', label: 'Financials', icon: BadgeDollarSign },
  { id: 'earnings', label: 'Results & Earnings', icon: CalendarClock },
  { id: 'ownership', label: 'Ownership', icon: UserCircle2 },
  { id: 'screeners', label: 'All Screeners', icon: Layers3 },
  { id: 'news', label: 'News', icon: Newspaper },
];

export function StockIntelligenceDeskPage({
  selectedSymbol,
  setSelectedSymbol,
  query,
  setQuery,
}: {
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  query: string;
  setQuery: (query: string) => void;
}) {
  const [tab, setTab] = useState<StockTab>('overview');

  const searchQ = trpc.searchNSEStocks.useQuery(
    { query },
    { enabled: query.trim().length >= 1 },
  );

  const quoteQ = trpc.getLiveStockQuote.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchInterval: 45_000, refetchOnWindowFocus: true },
  );

  const scoreDetailQ = trpc.getStockScoreDetail.useQuery(
    { symbol: selectedSymbol, timeframe: 'long_term' },
    { enabled: !!selectedSymbol },
  );

  const fundamentalsQ = trpc.getStockFundamentals.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const ratiosQ = trpc.getRatios.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const shareholdingQ = trpc.getShareholding.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const corpActionsQ = trpc.getCorporateActions.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const earningsForecastQ = trpc.getMcEarningsForecast.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const analystRatingQ = trpc.getMcAnalystRating.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const priceForecastQ = trpc.getMcPriceForecast.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const screenersQ = trpc.getStockScreeners.useQuery(
    { stockId: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const mcNewsQ = trpc.getMcStockNews.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const searchRows = Array.isArray(searchQ.data) ? searchQ.data : [];

  const quote = quoteQ.data as any;
  const score = (scoreDetailQ.data as any)?.score;
  const factors = (scoreDetailQ.data as any)?.factors;
  const fundamentals = fundamentalsQ.data as any;
  const ratios = ratiosQ.data as any;
  const shareholding = shareholdingQ.data as any;
  const earnings = earningsForecastQ.data as any;
  const analyst = analystRatingQ.data as any;
  const forecast = priceForecastQ.data as any;
  const screeners = (screenersQ.data ?? []) as any[];
  const news = (mcNewsQ.data?.news ?? []) as any[];
  const actionRows = (corpActionsQ.data ?? []) as any[];

  const price = numOrNull(quote?.price);
  const dayChg = numOrNull(quote?.changePercent);
  const unifiedScore = numOrNull(score?.score);
  const winProb = numOrNull(score?.confidence);

  const bullishCount = screeners.filter((x) => s((x as any).sentiment).toLowerCase() === 'bullish').length;
  const bearishCount = screeners.filter((x) => s((x as any).sentiment).toLowerCase() === 'bearish').length;

  const latestEstimate = (rows?: { date: string; high: string; low: string; avg: string; actual: string }[]) =>
    rows && rows.length > 0 ? rows[rows.length - 1] : null;

  const latestEps = latestEstimate(earnings?.eps);
  const latestRevenue = latestEstimate(earnings?.revenue);
  const latestNet = latestEstimate(earnings?.netProfit);

  const sourceBreakdownBars = useMemo(() => {
    const grouped: Record<string, number> = {};
    screeners.forEach((row: any) => {
      const src = s(row.source, 'unknown').toLowerCase();
      grouped[src] = (grouped[src] ?? 0) + 1;
    });
    return Object.entries(grouped).map(([src, count]) => ({
      label: src.toUpperCase(),
      value: count,
      colorClass: 'v5-mini-fill-indigo',
    }));
  }, [screeners]);

  const kpis = [
    { label: 'Symbol', value: selectedSymbol || '—' },
    { label: 'LTP', value: price == null ? '—' : `₹${fmtINR(price)}` },
    { label: 'Unified Score', value: unifiedScore == null ? '—' : fmtFixed(unifiedScore, 1), tone: unifiedScore != null && unifiedScore >= 66 ? 'positive' as const : 'warning' as const },
    { label: 'Screeners', value: String(screeners.length) },
  ];

  const summaryItems = [
    price == null
      ? `${selectedSymbol}: live quote unavailable right now.`
      : `${selectedSymbol} is at ₹${fmtINR(price)} (${dayChg == null ? 'day move unavailable' : `${fmtFixed(dayChg, 2)}% day move`}).`,
    unifiedScore == null
      ? 'Unified model score is not available for this symbol.'
      : `Model classification is ${s(score?.classification, '—')} with score ${fmtFixed(unifiedScore, 1)}${winProb == null ? '' : ` and confidence ${fmtFixed(winProb * 100, 1)}%`}.`,
    `Screener coverage: ${screeners.length} total (${bullishCount} bullish, ${bearishCount} bearish).`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip title="Stock Decision Summary" items={summaryItems} />
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-3">
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-sky-700" />
          <h2 className="v5-title text-lg font-semibold">Stock Search</h2>
        </div>

        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type symbol or name"
          className="v5-input"
        />

        <div className="v5-compact-scroll mt-3 space-y-2 pr-1">
          {searchRows.slice(0, 40).map((row: any) => {
            const sym = s(row.symbol);
            const active = selectedSymbol === sym;
            return (
              <button
                key={sym}
                onClick={() => setSelectedSymbol(sym)}
                className={`w-full rounded-xl border px-3 py-2 text-left transition ${active ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <div className="text-sm font-semibold text-slate-800">{sym}</div>
                <div className="text-xs text-slate-500">{s((row as any).companyName, s((row as any).name, 'NSE Listing'))}</div>
              </button>
            );
          })}
          {!searchRows.length && <p className="text-sm text-slate-500">Search results will appear here.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="v5-title text-2xl font-bold text-slate-900">{selectedSymbol}</h2>
            <p className="text-sm text-slate-600">Professional stock intelligence with categorized live sections.</p>
          </div>
          <div className="flex flex-wrap gap-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold ${active ? 'border-teal-600 bg-teal-600 text-white' : 'border-slate-300 bg-white text-slate-700 hover:bg-slate-50'}`}
                >
                  <span className="inline-flex items-center gap-1.5"><Icon className="h-3.5 w-3.5" /> {t.label}</span>
                </button>
              );
            })}
          </div>
        </div>

        {tab === 'overview' && (
          <div className="space-y-3">
            <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
              <MetricCard label="LTP" value={price == null ? '—' : `₹${fmtINR(price)}`} />
              <MetricCard label="Day Change" value={dayChg == null ? '—' : `${dayChg >= 0 ? '+' : ''}${fmtFixed(dayChg, 2)}%`} toneClass={pctClass(dayChg ?? 0)} />
              <MetricCard label="Unified Score" value={unifiedScore == null ? '—' : fmtFixed(unifiedScore, 1)} />
              <MetricCard label="Classification" value={s(score?.classification, '—')} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <V5MiniBarChart
                title="Factor Breakdown"
                items={[
                  { label: 'Technical', value: numOrNull(factors?.technical), colorClass: 'v5-mini-fill-sky' },
                  { label: 'Fundamental', value: numOrNull(factors?.fundamental), colorClass: 'v5-mini-fill-teal' },
                  { label: 'Momentum', value: numOrNull(factors?.momentum), colorClass: 'v5-mini-fill-indigo' },
                  { label: 'Valuation', value: numOrNull(factors?.valuation), colorClass: 'v5-mini-fill-amber' },
                  { label: 'Delivery', value: numOrNull(factors?.delivery), colorClass: 'v5-mini-fill-rose' },
                  { label: 'News', value: numOrNull(factors?.news), colorClass: 'v5-mini-fill-indigo' },
                ]}
              />
              <V5InsightPanel
                title="Overview Insights"
                insights={[
                  score?.reasons?.length ? `Primary rationale count: ${score.reasons.length} model reasons.` : 'Model rationale details are not available yet.',
                  fundamentals?.market_cap == null ? 'Market cap is unavailable in current fundamentals snapshot.' : `Market cap is ₹${fmtFixed(fundamentals.market_cap, 0)} Cr.`,
                  ratios?.pe == null && fundamentals?.trailing_pe == null
                    ? 'Valuation multiple (P/E) is unavailable.'
                    : `P/E lens: ${fmtFixed(fundamentals?.trailing_pe ?? ratios?.pe, 2)}.`,
                ]}
              />
            </div>
          </div>
        )}

        {tab === 'financials' && (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
            <CategoryCard
              title="Valuation"
              rows={[
                ['P/E', fundamentals?.trailing_pe ?? ratios?.pe],
                ['P/B', fundamentals?.price_to_book ?? ratios?.pb],
                ['Earnings Yield %', fundamentals?.earnings_yield],
                ['Market Cap (Cr)', fundamentals?.market_cap],
              ]}
            />
            <CategoryCard
              title="Profitability"
              rows={[
                ['ROE %', fundamentals?.return_on_equity],
                ['Operating Margin %', fundamentals?.operating_margins],
                ['Piotroski', fundamentals?.piotroski_f_score],
              ]}
            />
            <CategoryCard
              title="Growth & Leverage"
              rows={[
                ['Revenue Growth %', fundamentals?.revenue_growth],
                ['Earnings Growth %', fundamentals?.earnings_growth],
                ['Debt/Equity', fundamentals?.debt_to_equity],
              ]}
            />
          </div>
        )}

        {tab === 'earnings' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <MetricCard label="Analyst Final Rating" value={s(analyst?.finalRating, '—')} />
              <MetricCard label="Analyst Count" value={numOrNull(analyst?.analystCount) == null ? '—' : String(n(analyst?.analystCount))} />
              <MetricCard label="Mean Price Target" value={forecast?.mean == null ? '—' : `₹${fmtFixed(forecast.mean, 2)}`} />
            </div>

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-3">
              <EstimateCard title="EPS (Latest)" row={latestEps} />
              <EstimateCard title="Revenue (Latest)" row={latestRevenue} />
              <EstimateCard title="Net Profit (Latest)" row={latestNet} />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Corporate Actions</div>
              <div className="v5-compact-scroll space-y-1 pr-1">
                {actionRows.slice(0, 40).map((a: any, i: number) => (
                  <div key={`${s(a.action_type)}-${i}`} className="flex items-center justify-between rounded-lg border border-slate-200 bg-white px-2 py-1.5 text-xs">
                    <span className="font-semibold text-slate-700">{s(a.action_type, s(a.purpose, 'Action'))}</span>
                    <span className="text-slate-500">{s(a.ex_date, '—')}</span>
                  </div>
                ))}
                {!actionRows.length && <p className="text-sm text-slate-500">No corporate actions available for this symbol.</p>}
              </div>
            </div>
          </div>
        )}

        {tab === 'ownership' && (
          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <CategoryCard
              title="Shareholding Pattern"
              rows={[
                ['Promoter %', shareholding?.summary?.promoters?.percentage ?? shareholding?.promoter_pct],
                ['FII %', shareholding?.summary?.fii?.percentage ?? shareholding?.fii_pct],
                ['DII/MF %', shareholding?.summary?.mf?.percentage ?? shareholding?.mf_pct],
                ['Pledge %', shareholding?.summary?.pledge?.percentage ?? shareholding?.pledge_pct],
              ]}
              suffix="%"
            />
            <V5InsightPanel
              title="Ownership Insights"
              insights={[
                numOrNull(shareholding?.summary?.promoters?.percentage ?? shareholding?.promoter_pct) == null
                  ? 'Promoter holding is unavailable from current source.'
                  : `Promoter holding is ${fmtFixed(shareholding?.summary?.promoters?.percentage ?? shareholding?.promoter_pct, 2)}%.`,
                numOrNull(shareholding?.summary?.pledge?.percentage ?? shareholding?.pledge_pct) == null
                  ? 'Pledge ratio is unavailable.'
                  : `Pledge ratio is ${fmtFixed(shareholding?.summary?.pledge?.percentage ?? shareholding?.pledge_pct, 2)}%.`,
                'Use ownership trend with score and screeners before final action.',
              ]}
            />
          </div>
        )}

        {tab === 'screeners' && (
          <div className="space-y-3">
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <V5MiniBarChart title="Screener Source Coverage" items={sourceBreakdownBars} />
              <V5InsightPanel
                title="Screener Insights"
                insights={[
                  `Total screener memberships: ${screeners.length}.`,
                  `Bullish signals: ${bullishCount}; Bearish signals: ${bearishCount}.`,
                  screeners.length ? 'Review screener descriptions for context before trade selection.' : 'No screener memberships found for this symbol.',
                ]}
              />
            </div>

            <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">All Screener Names This Stock Is Part Of</div>
              <div className="v5-compact-scroll space-y-2 pr-1">
                {screeners.map((sc: any, i: number) => (
                  <div key={`${s(sc.source)}-${s(sc.id)}-${i}`} className="rounded-lg border border-slate-200 bg-white p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-slate-800">{s(sc.name, 'Screener')}</span>
                      <span className="rounded-full bg-slate-100 px-2 py-0.5 text-[10px] font-semibold text-slate-600">{s(sc.source, 'source')}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-slate-600">
                      <span className="rounded-full border border-slate-200 px-2 py-0.5">Sentiment: {s(sc.sentiment, 'neutral')}</span>
                      {s(sc.category).trim() ? <span className="rounded-full border border-slate-200 px-2 py-0.5">{s(sc.category)}</span> : null}
                      {s(sc.subcategory).trim() ? <span className="rounded-full border border-slate-200 px-2 py-0.5">{s(sc.subcategory)}</span> : null}
                    </div>
                    {s(sc.description).trim() ? <p className="mt-1 text-xs text-slate-500">{s(sc.description)}</p> : null}
                  </div>
                ))}
                {!screeners.length && <p className="text-sm text-slate-500">No screener memberships found for this stock.</p>}
              </div>
            </div>
          </div>
        )}

        {tab === 'news' && (
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">Stock News</div>
            <div className="v5-compact-scroll space-y-2 pr-1">
              {news.map((item: any, i: number) => (
                <a
                  key={`${s(item.posturl)}-${i}`}
                  href={s(item.posturl)}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-slate-200 bg-white p-2 hover:bg-slate-50"
                >
                  <div className="text-sm font-semibold text-slate-800">{s(item.heading, 'News item')}</div>
                  <div className="mt-0.5 text-xs text-slate-500">{s(item.publish_date, '—')}</div>
                  {s(item.description).trim() ? <p className="mt-1 text-xs text-slate-600">{s(item.description)}</p> : null}
                </a>
              ))}
              {!news.length && <p className="text-sm text-slate-500">No stock-specific news available right now.</p>}
            </div>
          </div>
        )}
      </div>
    </section>
  );
}

function MetricCard({ label, value, toneClass = 'text-slate-900' }: { label: string; value: string; toneClass?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{label}</div>
      <div className={`mt-1 text-lg font-bold ${toneClass}`}>{value}</div>
    </div>
  );
}

function CategoryCard({
  title,
  rows,
  suffix,
}: {
  title: string;
  rows: [string, any][];
  suffix?: string;
}) {
  const present = rows.filter(([, v]) => v != null);
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {present.length ? (
        <div className="grid grid-cols-2 gap-2">
          {present.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-slate-200 bg-white p-2">
              <div className="text-sm font-bold text-slate-800">{fmtFixed(value, 2)}{suffix ?? ''}</div>
              <div className="text-[10px] uppercase tracking-wide text-slate-500">{label}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-slate-500">No values available.</p>
      )}
    </div>
  );
}

function EstimateCard({
  title,
  row,
}: {
  title: string;
  row: { date: string; high: string; low: string; avg: string; actual: string } | null;
}) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      {!row ? (
        <p className="text-sm text-slate-500">No estimate data.</p>
      ) : (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between"><span className="text-slate-500">Period</span><span className="font-semibold text-slate-700">{s(row.date, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-slate-500">Avg</span><span className="font-semibold text-slate-700">{s(row.avg, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-slate-500">Low / High</span><span className="font-semibold text-slate-700">{s(row.low, '—')} / {s(row.high, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-slate-500">Actual</span><span className="font-semibold text-slate-700">{s(row.actual, '—')}</span></div>
        </div>
      )}
    </div>
  );
}
