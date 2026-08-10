import { useEffect, useMemo, useState } from 'react';
import {
  Activity, BadgeDollarSign, CalendarClock, Layers3, LineChart, Newspaper, Search,
  ShieldCheck, UserCircle2, Compass, Mic2, Gauge, ShoppingBag, Landmark,
} from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, fmtINR, n, numOrNull, pctClass, s } from '../utils';
import { relativeFromNow, formatISTWithLocal, isStale } from '../../lib/timeFormat';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart, V5Sparkline } from '../components/V5Visuals';
import { OptionChainView } from '../../components/OptionChainView';
import IndexFnoOverview from '../../components/IndexFnoOverview';

export type StockTab = 'overview' | 'technicals' | 'financials' | 'earnings' | 'ownership' | 'fno' | 'screeners' | 'news';

const TABS: { id: StockTab; label: string; icon: React.ComponentType<{ className?: string }> }[] = [
  { id: 'overview', label: 'Overview', icon: Activity },
  { id: 'technicals', label: 'Technicals', icon: LineChart },
  { id: 'financials', label: 'Financials', icon: BadgeDollarSign },
  { id: 'earnings', label: 'Results & Earnings', icon: CalendarClock },
  { id: 'ownership', label: 'Ownership', icon: UserCircle2 },
  { id: 'fno', label: 'F&O', icon: Landmark },
  { id: 'screeners', label: 'All Screeners', icon: Layers3 },
  { id: 'news', label: 'News', icon: Newspaper },
];

const CONVICTION_LABEL: Record<string, { label: string; tone: 'positive' | 'negative' | 'warning' | 'neutral' }> = {
  S_ELITE:    { label: 'S — Elite',    tone: 'positive' },
  A_HIGH:     { label: 'A — High',     tone: 'positive' },
  B_MEDIUM:   { label: 'B — Medium',   tone: 'warning'  },
  C_LOW:      { label: 'C — Low',      tone: 'neutral'  },
  D_MARGINAL: { label: 'D — Marginal', tone: 'negative' },
};

export function StockIntelligenceDeskPage({
  selectedSymbol,
  setSelectedSymbol,
  query,
  setQuery,
  initialTab,
}: {
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  query: string;
  setQuery: (query: string) => void;
  initialTab?: StockTab;
}) {
  const [tab, setTab] = useState<StockTab>(initialTab ?? 'overview');

  useEffect(() => {
    if (initialTab) setTab(initialTab);
  }, [initialTab]);

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

  // Real canonical unified_recommendations score -- previously absent from this page entirely.
  // The KPI below labeled "Unified Score" was actually scoreDetailQ's stock_scores value; that
  // KPI is renamed to "Composite Score" (matching v4's naming for the identical data) so this
  // is the only thing on the page called "Unified Score" going forward.
  const unifiedScoreQ = trpc.getUnifiedScoreForSymbol.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol },
  );

  const stockMetaQ = trpc.getNSEStockBySymbol.useQuery(
    { symbol: selectedSymbol },
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

  const superstarActivityQ = trpc.getSuperstarInvestorActivity.useQuery(
    { symbol: selectedSymbol, limit: 20 },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  // Replaces getCorporateActions (raw ET live proxy, no persistence, no cross-check) with the
  // persisted + cross-checked pair also used by v4/MCStockInfoPanel -- same data, better
  // quality, a swap rather than a second corporate-actions source on the page.
  const actionHistoryQ = trpc.getCorporateActionHistory.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );
  const filedActionsQ = trpc.getFiledCorporateActionsCalendar.useQuery(
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

  // swot/chartPatterns/historicalRating/hitsMisses all live in the same getMcConsolidated
  // response -- one query, each section below reads only its own piece so nothing is shown
  // twice. essentials/valuation/analystRating/priceForecast/consensus/shareholdingPattern from
  // the same blob are deliberately left unread here since they're already sourced above via
  // their own dedicated procedures.
  const mcConsolidatedQ = trpc.getMcConsolidated.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, staleTime: 3_600_000 },
  );

  // Sector Relative Rotation Graph -- market-wide payload, filtered client-side to this
  // stock's own sector (from stockMetaQ) below.
  const sectorRotationQ = trpc.getSectorRotationIntel.useQuery(undefined, { staleTime: 1_800_000 });

  // Transaction-level smart-money activity, distinct from the % shareholding and per-filing
  // insider data: real topInvestor block-deal trend with counterparty names, and NSE bulk/block
  // deals carrying pct_transacted (% of float, comparable across cap sizes).
  const institutionalDealsQ = trpc.getInstitutionalDealHistory.useQuery(
    { symbol: selectedSymbol, days: 30 },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );
  const blockDealsQ = trpc.getBlockDeals.useQuery(
    { symbol: selectedSymbol, limit: 20 },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  // Per-transaction NSE PIT insider/promoter filings -- richer than a boolean flag, and this
  // page had no insider-transaction feed at all before.
  const insiderTxQ = trpc.getInsiderTransactions.useQuery(
    { symbol: selectedSymbol, limit: 25 },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const concallTakeawaysQ = trpc.getConcallTakeaways.useQuery(
    { symbol: selectedSymbol, limit: 8 },
    { enabled: !!selectedSymbol, staleTime: 900_000 },
  );

  const dvmQ = trpc.getTrendlyneDVM.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );
  const checklistQ = trpc.getTrendlyneChecklist.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchOnWindowFocus: true },
  );

  const ohlcQ = trpc.getOHLCData.useQuery(
    { symbol: selectedSymbol, dur: '6m' },
    { enabled: !!selectedSymbol },
  );
  const predictionsQ = trpc.getTechnicalPredictions.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol },
  );

  const fnoSignalsQ = trpc.getFnOSignals.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol },
  );
  const fnoSymbolsQ = trpc.getFnoSymbols.useQuery();

  const searchRows = Array.isArray((searchQ.data as any)?.stocks)
    ? ((searchQ.data as any).stocks as any[])
    : [];

  const quote = quoteQ.data as any;
  const score = (scoreDetailQ.data as any)?.score;
  const factors = (scoreDetailQ.data as any)?.factors;
  const fundamentals = fundamentalsQ.data as any;
  const ratios = ratiosQ.data as any;
  const shareholding = shareholdingQ.data as any;
  const superstarActivity = (superstarActivityQ.data ?? []) as any[];
  const earnings = earningsForecastQ.data as any;
  const analyst = analystRatingQ.data as any;
  const forecast = priceForecastQ.data as any;
  const screeners = (screenersQ.data ?? []) as any[];
  const news = (mcNewsQ.data?.news ?? []) as any[];
  const actionHistory = (actionHistoryQ.data ?? []) as any[];
  const filedActions = (filedActionsQ.data ?? []) as any[];

  const unifiedScoreData = unifiedScoreQ.data as any;
  const stockSector = (stockMetaQ.data as any)?.sector as string | undefined;
  const sectorRow = ((sectorRotationQ.data as any)?.rrg as any[] | undefined)?.find((r) => r.sector === stockSector);

  const mc = mcConsolidatedQ.data as any;
  const swot = mc?.swot as { strengths?: string[]; weaknesses?: string[]; opportunities?: string[]; threats?: string[] } | undefined;
  const chartPatterns = mc?.chartPatterns;
  const historicalRating = mc?.historicalRating;
  const hrSnapshot = historicalRating?.data?.[0];
  const hitsMisses = mc?.hitsMisses;

  const institutionalDeals = (institutionalDealsQ.data ?? []) as any[];
  const blockDeals = (blockDealsQ.data ?? []) as any[];
  const insiderTx = (insiderTxQ.data ?? []) as any[];
  const concallTakeaways = (concallTakeawaysQ.data ?? []) as any[];
  const dvm = dvmQ.data as any;
  const checklist = checklistQ.data as any;

  const ohlcRows = (ohlcQ.data as any)?.data ?? [];
  const closeSeries = useMemo(() => ohlcRows.map((r: any) => numOrNull(r.close)), [ohlcRows]);
  const predictions = predictionsQ.data as any;
  const fnoEligible = ((fnoSymbolsQ.data as any) ?? []).includes(selectedSymbol.toUpperCase());
  const fnoSentiment = (fnoSignalsQ.data as any)?.marketSentiment;

  const price = numOrNull(quote?.price);
  const dayChg = numOrNull(quote?.changePercent);
  const compositeScore = numOrNull(score?.score);
  const unifiedScore = numOrNull(unifiedScoreData?.unified_score);
  const winProb = numOrNull(score?.confidence);
  const convictionMeta = unifiedScoreData?.conviction_level ? CONVICTION_LABEL[unifiedScoreData.conviction_level] : null;

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
    // Real canonical unified_recommendations score (see unifiedScoreQ above) -- this used to be
    // stock_scores' value mislabeled "Unified Score"; that data now lives in "Composite Score"
    // below instead, matching v4's naming for the identical field.
    { label: 'Unified Score', value: unifiedScore == null ? '—' : fmtFixed(unifiedScore, 1), tone: unifiedScore != null && unifiedScore >= 66 ? 'positive' as const : unifiedScore != null && unifiedScore <= 34 ? 'negative' as const : 'warning' as const },
    { label: 'Composite Score', value: compositeScore == null ? '—' : fmtFixed(compositeScore, 1), tone: compositeScore != null && compositeScore >= 66 ? 'positive' as const : 'warning' as const },
    { label: 'Screeners', value: String(screeners.length) },
  ];

  const summaryItems = [
    price == null
      ? `${selectedSymbol}: live quote unavailable right now.`
      : `${selectedSymbol} is at ₹${fmtINR(price)} (${dayChg == null ? 'day move unavailable' : `${fmtFixed(dayChg, 2)}% day move`}).`,
    unifiedScore == null
      ? 'Unified canonical score is not available for this symbol.'
      : `Unified classification is ${s(unifiedScoreData?.classification, '—')} with score ${fmtFixed(unifiedScore, 1)}${convictionMeta ? ` (${convictionMeta.label} conviction)` : ''}.`,
    compositeScore == null
      ? 'Composite (per-timeframe) score is not available for this symbol.'
      : `Composite model classification is ${s(score?.classification, '—')} with score ${fmtFixed(compositeScore, 1)}${winProb == null ? '' : ` and confidence ${fmtFixed(winProb * 100, 1)}%`}.`,
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
          {searchQ.isLoading && <p className="text-sm text-[var(--v5-muted)]">Searching stocks...</p>}
          {searchQ.isError && <p className="text-sm text-[var(--v5-negative-bright)]">Search is temporarily unavailable.</p>}
          {searchRows.slice(0, 40).map((row: any) => {
            const sym = s(row.symbol);
            const active = selectedSymbol === sym;
            return (
              <button
                key={sym}
                onClick={() => setSelectedSymbol(sym)}
                className={`w-full rounded-xl border px-3 py-2 text-left transition ${active ? 'border-[var(--v5-accent)] bg-[var(--v5-accent-soft)]' : 'border-[var(--v5-border)] bg-[var(--v5-surface)] hover:bg-[var(--v5-surface-2)]'}`}
              >
                <div className="text-sm font-semibold text-[var(--v5-ink)]">{sym}</div>
                <div className="text-xs text-[var(--v5-muted)]">{s((row as any).companyName, s((row as any).name, 'NSE Listing'))}</div>
              </button>
            );
          })}
          {!searchQ.isLoading && !searchQ.isError && !searchRows.length && (
            <p className="text-sm text-[var(--v5-muted)]">Search results will appear here.</p>
          )}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-9">
        <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
          <div>
            <h2 className="v5-title text-2xl font-bold text-[var(--v5-ink)]">{selectedSymbol}</h2>
            <p className="text-sm text-[var(--v5-ink-muted)]">Professional stock intelligence with categorized live sections.</p>
            {quoteQ.dataUpdatedAt ? (
              <p
                className={`mt-0.5 text-xs ${isStale(quoteQ.dataUpdatedAt, 90_000) ? 'text-[var(--v5-negative)] font-semibold' : 'text-[var(--v5-muted)]'}`}
                title={formatISTWithLocal(quoteQ.dataUpdatedAt)}
              >
                price {relativeFromNow(quoteQ.dataUpdatedAt)}{isStale(quoteQ.dataUpdatedAt, 90_000) ? ' — may be delayed' : ''}
              </p>
            ) : null}
          </div>
          <div className="flex flex-wrap gap-2">
            {TABS.map((t) => {
              const Icon = t.icon;
              const active = tab === t.id;
              return (
                <button
                  key={t.id}
                  onClick={() => setTab(t.id)}
                  className={`rounded-xl border px-3 py-1.5 text-xs font-semibold ${active ? 'border-[var(--v5-accent)] bg-[var(--v5-accent)] text-white' : 'border-[var(--v5-border-soft)] bg-[var(--v5-surface)] text-[var(--v5-ink-soft)] hover:bg-[var(--v5-surface-2)]'}`}
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
              <MetricCard
                label={`Unified Score${convictionMeta ? ` (${convictionMeta.label})` : ''}`}
                value={unifiedScore == null ? '—' : fmtFixed(unifiedScore, 1)}
                toneClass={convictionMeta?.tone === 'positive' ? 'text-[var(--v5-positive)]' : convictionMeta?.tone === 'negative' ? 'text-[var(--v5-negative)]' : undefined}
              />
              <MetricCard label="Unified Classification" value={s(unifiedScoreData?.classification, '—')} />
            </div>

            {unifiedScoreData?.trade_reasoning && (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3 text-xs text-[var(--v5-ink-muted)]">
                <span className="font-semibold text-[var(--v5-accent)]">Why: </span>
                {unifiedScoreData.trade_reasoning}
                {unifiedScoreData.engine_coverage_count != null && (
                  <span className="text-[var(--v5-muted)]"> ({unifiedScoreData.engine_coverage_count}/8 engines)</span>
                )}
              </div>
            )}

            {sectorRow && (
              <div className="flex items-center gap-2 rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] px-3 py-2 text-xs">
                <Compass className="h-4 w-4 text-sky-600" />
                <span className="text-[var(--v5-muted)]">Sector rotation — <span className="font-semibold text-[var(--v5-ink)]">{sectorRow.sector}</span> is currently</span>
                <span className="rounded-full border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-0.5 text-[10px] font-semibold text-[var(--v5-ink-soft)]">{sectorRow.quadrant ?? 'Unclassified'}</span>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <V5MiniBarChart
                title="Factor Breakdown (Composite Score)"
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

            {(swot?.strengths?.length || swot?.weaknesses?.length || swot?.opportunities?.length || swot?.threats?.length) ? (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">SWOT Analysis (MoneyControl)</div>
                <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                  {([
                    ['strengths', 'Strengths', 'text-[var(--v5-positive)] border-emerald-200 bg-[var(--v5-accent-soft)]'],
                    ['weaknesses', 'Weaknesses', 'text-[var(--v5-negative)] bg-[var(--v5-negative-soft)] border-[var(--v5-negative-bright)]'],
                    ['opportunities', 'Opportunities', 'text-sky-700 bg-sky-50 border-sky-200'],
                    ['threats', 'Threats', 'text-amber-700 bg-amber-50 border-amber-200'],
                  ] as [keyof typeof swot, string, string][]).map(([key, label, tone]) => {
                    const items = (swot?.[key] ?? []) as string[];
                    if (!items.length) return null;
                    return (
                      <div key={key}>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{label} ({items.length})</span>
                        <ul className="mt-1.5 space-y-1">
                          {items.map((item, i) => (
                            <li key={i} className="text-xs text-[var(--v5-ink-muted)] leading-relaxed">• {item}</li>
                          ))}
                        </ul>
                      </div>
                    );
                  })}
                </div>
              </div>
            ) : null}
          </div>
        )}

        {tab === 'technicals' && (
          <div className="space-y-3">
            <V5Sparkline title={`${selectedSymbol} — Close Price (6M)`} values={closeSeries} colorClass="v5-sparkline-stroke-indigo" />

            {predictions && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="RSI" value={predictions.rsi == null ? '—' : fmtFixed(predictions.rsi, 1)} />
                <MetricCard label="MACD" value={predictions.macd == null ? '—' : fmtFixed(predictions.macd, 2)} />
                <MetricCard label="ADX" value={predictions.adx == null ? '—' : fmtFixed(predictions.adx, 1)} />
                <MetricCard label="Win Probability" value={predictions.win_probability == null ? '—' : `${fmtFixed(predictions.win_probability * 100, 0)}%`} />
              </div>
            )}

            {hrSnapshot?.currSentiment && (
              <div className="flex items-center justify-between gap-3 rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] px-3 py-2 text-xs">
                <span className="font-semibold uppercase tracking-wide text-[var(--v5-muted)]">MC Historical Rating — sentiment on {hrSnapshot.currdate ?? '—'}</span>
                <span className={`font-semibold ${/bullish/i.test(hrSnapshot.currSentiment) ? 'text-[var(--v5-positive)]' : /bearish/i.test(hrSnapshot.currSentiment) ? 'text-[var(--v5-negative)]' : 'text-[var(--v5-ink)]'}`}>
                  {hrSnapshot.currSentiment} @ ₹{fmtFixed(hrSnapshot.closePrice, 2)}
                </span>
              </div>
            )}

            {Array.isArray(chartPatterns?.data) && chartPatterns.data.length > 0 && (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]"><Gauge className="h-3.5 w-3.5" /> Chart Patterns Detected (MoneyControl)</div>
                <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
                  {chartPatterns.data.map((p: any, i: number) => {
                    let meta: any = {};
                    try { meta = JSON.parse(p.meta_data || '{}'); } catch { /* ignore malformed meta_data */ }
                    const isBuy = meta.pattern_type === 'buy';
                    return (
                      <div key={i} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2">
                        <div className="flex items-center justify-between gap-2">
                          <span className="text-xs font-semibold text-[var(--v5-ink)]">{p.pattern_name}</span>
                          {meta.target_return_prcnt != null && <span className="text-xs font-bold text-[var(--v5-positive)]">+{meta.target_return_prcnt}%</span>}
                        </div>
                        <div className={`mt-0.5 text-[11px] ${isBuy ? 'text-[var(--v5-positive)]' : 'text-[var(--v5-negative)]'}`}>{p.comment} · {p.p_status} · {p.time_frame}</div>
                      </div>
                    );
                  })}
                </div>
              </div>
            )}
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

            {(dvm || checklist) && (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3 xl:col-span-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Trendlyne DVM & Checklist</div>
                <div className="flex flex-wrap gap-2">
                  {dvm && ([
                    ['Durability', dvm.durability], ['Valuation', dvm.valuation], ['Momentum', dvm.momentum],
                  ] as [string, any][]).map(([label, v]) => v && (
                    <span
                      key={label}
                      className="rounded-full border px-3 py-1 text-xs font-semibold"
                      style={{
                        color: v.color === 'green' ? 'var(--v5-positive)' : v.color === 'red' ? 'var(--v5-negative)' : 'var(--v5-warning)',
                        borderColor: 'var(--v5-border)',
                        background: 'var(--v5-surface)',
                      }}
                    >
                      {label}: {v.score}
                    </span>
                  ))}
                  {checklist && (
                    <span className="rounded-full border border-[var(--v5-border)] bg-[var(--v5-surface)] px-3 py-1 text-xs font-semibold text-[var(--v5-ink-soft)]">
                      Checklist: {checklist.yesCount}/{checklist.total} passed ({checklist.score}%)
                    </span>
                  )}
                </div>
              </div>
            )}
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

            {hitsMisses?.list && hitsMisses.list.length > 0 && (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Earnings Hits & Misses (EPS estimate track record)</div>
                <div className="v5-compact-scroll space-y-1 pr-1">
                  {hitsMisses.list.map((row: any, i: number) => (
                    <div key={i} className="flex items-center justify-between rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs">
                      <span className="font-semibold text-[var(--v5-ink-soft)]">{row.quarter}</span>
                      <span className="text-[var(--v5-ink-muted)]">Actual {row.actual || '—'} vs Est {row.estimates || '—'}</span>
                      <span style={{ color: row.type === 'positive' ? 'var(--v5-positive)' : row.type === 'negative' ? 'var(--v5-negative)' : 'var(--v5-muted)' }} className="font-semibold uppercase">{row.type}</span>
                    </div>
                  ))}
                </div>
              </div>
            )}

            {concallTakeaways.length > 0 && (
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]"><Mic2 className="h-3.5 w-3.5" /> Concall Takeaways (AI-Generated)</div>
                <div className="v5-compact-scroll space-y-1.5 pr-1">
                  {concallTakeaways.map((c: any, i: number) => (
                    <div key={i} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-xs font-semibold text-[var(--v5-ink)]">{c.quarter || c.fiscal_year || 'Latest concall'}</span>
                        {c.tone_assessment && (
                          <span style={{ color: /positive|bullish/i.test(c.tone_assessment) ? 'var(--v5-positive)' : /negative|bearish|cautio/i.test(c.tone_assessment) ? 'var(--v5-negative)' : 'var(--v5-muted)' }} className="text-[10px] font-semibold uppercase">
                            {c.tone_assessment}
                          </span>
                        )}
                      </div>
                      <p className="mt-1 text-xs text-[var(--v5-ink-muted)]">{c.key_takeaway}</p>
                    </div>
                  ))}
                </div>
              </div>
            )}

            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Corporate Actions — MoneyControl history</div>
                <div className="v5-compact-scroll space-y-1 pr-1">
                  {actionHistory.slice(0, 40).map((a: any, i: number) => (
                    <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs">
                      <div className="flex min-w-0 items-center gap-2">
                        <span className="shrink-0 font-semibold text-[var(--v5-ink-soft)]">{s(a.action_type, 'Action')}</span>
                        <span className="shrink-0 text-[var(--v5-muted)]">{s(a.record_date, '—')}</span>
                        <span className="truncate text-[var(--v5-ink-muted)]">{a.ratio_text ?? (a.amount != null ? `₹${fmtFixed(a.amount, 2)}` : '')}</span>
                      </div>
                      {/* Cross-checked against ohlcv_adjustment_factors -- same "Verified" convention
                          as MCStockInfoPanel/v4's Earnings tab. */}
                      {(a.crossCheck === 'confirmed_by_bhavcopy' || a.crossCheck === 'confirmed_via_this_source') ? (
                        <span className="shrink-0 font-semibold" style={{ color: 'var(--v5-positive)' }}>✓ Confirmed</span>
                      ) : a.crossCheck === 'unconfirmed' ? (
                        <span className="shrink-0 font-semibold" style={{ color: 'var(--v5-warning)' }}>⚠ Unconfirmed</span>
                      ) : null}
                    </div>
                  ))}
                  {!actionHistory.length && <p className="text-sm text-[var(--v5-muted)]">No dividend, bonus, split or rights history on record for {selectedSymbol}.</p>}
                </div>
              </div>
              <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
                <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Filed with NSE (last/next 6 months)</div>
                <div className="v5-compact-scroll space-y-1.5 pr-1">
                  {filedActions.map((f: any, i: number) => (
                    <a key={i} href={f.source_url} target="_blank" rel="noreferrer" className="block rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2 hover:bg-[var(--v5-surface-2)]">
                      <div className="flex items-center justify-between gap-2">
                        <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5 text-[10px] font-semibold text-[var(--v5-ink-soft)]">{(f.category || '').split('|')[0] || 'filing'}</span>
                        <span className="text-[10px] text-[var(--v5-muted)]">{f.filing_date}</span>
                      </div>
                      <p className="mt-1 text-xs text-[var(--v5-ink)]">{f.headline}</p>
                    </a>
                  ))}
                  {!filedActions.length && <p className="text-sm text-[var(--v5-muted)]">No NSE-filed corporate action in this window.</p>}
                </div>
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

            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3 xl:col-span-2">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Superstar Investor Activity (InvestSights)</div>
              <div className="v5-compact-scroll space-y-1.5 pr-1">
                {superstarActivity.map((row: any, idx: number) => {
                  const slug = s(row.investor_slug, 'investor');
                  const activity = s(row.change_type, 'update').toUpperCase();
                  const pctHolding = numOrNull(row.curr_pct_holding);
                  const pctChange = numOrNull(row.pct_holding_change);
                  const tone = activity === 'EXIT' || (pctChange != null && pctChange < 0)
                    ? 'text-[var(--v5-negative)] bg-[var(--v5-negative-soft)] border-[var(--v5-negative-bright)]'
                    : 'text-[var(--v5-positive)] bg-[var(--v5-accent-soft)] border-emerald-200';
                  return (
                    <div key={`${slug}-${s(row.period_end_date)}-${idx}`} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-3 py-2">
                      <div className="flex items-center justify-between gap-2">
                        <span className="text-sm font-semibold text-[var(--v5-ink)]">{slug.replace(/-/g, ' ')}</span>
                        <span className={`rounded-full border px-2 py-0.5 text-[10px] font-semibold ${tone}`}>{activity}</span>
                      </div>
                      <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--v5-ink-muted)]">
                        <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">Holding: {pctHolding == null ? '—' : `${fmtFixed(pctHolding, 2)}%`}</span>
                        <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">Change: {pctChange == null ? '—' : `${pctChange >= 0 ? '+' : ''}${fmtFixed(pctChange, 2)}%`}</span>
                        <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">As of: {s(row.period_end_date, '—')}</span>
                      </div>
                    </div>
                  );
                })}
                {!superstarActivityQ.isLoading && superstarActivity.length === 0 && (
                  <p className="text-sm text-[var(--v5-muted)]">No superstar investor activity rows are available for this symbol yet.</p>
                )}
                {superstarActivityQ.isLoading && (
                  <p className="text-sm text-[var(--v5-muted)]">Loading superstar investor activity...</p>
                )}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]"><ShieldCheck className="h-3.5 w-3.5" /> Insider / Promoter Transactions (NSE PIT)</div>
              <div className="v5-compact-scroll space-y-1.5 pr-1">
                {insiderTx.map((tx: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-[var(--v5-ink)]">{tx.person_name} <span className="font-normal text-[var(--v5-muted)]">({tx.person_category})</span></div>
                      <div className="text-[var(--v5-muted)]">{tx.transaction_date}</div>
                    </div>
                    <span style={{ color: /buy|acqui/i.test(tx.transaction_mode ?? '') ? 'var(--v5-positive)' : 'var(--v5-negative)' }} className="shrink-0 font-semibold">
                      {tx.transaction_mode} · {fmtFixed(tx.quantity, 0)}
                    </span>
                  </div>
                ))}
                {!insiderTx.length && <p className="text-sm text-[var(--v5-muted)]">No insider transactions recorded for {selectedSymbol}.</p>}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]"><Landmark className="h-3.5 w-3.5" /> Institutional Deal Trend (30d)</div>
              <div className="v5-compact-scroll space-y-1.5 pr-1">
                {institutionalDeals.map((row: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-[var(--v5-ink)]">{s(row.counterparty, '—')}</div>
                      <div className="text-[var(--v5-muted)]">{row.deal_date}</div>
                    </div>
                    <span style={{ color: /buy/i.test(row.action ?? '') ? 'var(--v5-positive)' : 'var(--v5-negative)' }} className="shrink-0 font-semibold">
                      {row.action} ₹{fmtFixed(row.deal_value_cr_1w, 1)}Cr
                    </span>
                  </div>
                ))}
                {!institutionalDeals.length && <p className="text-sm text-[var(--v5-muted)]">No topInvestor block-deal activity for {selectedSymbol} in the last 30 days.</p>}
              </div>
            </div>

            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
              <div className="mb-2 flex items-center gap-1.5 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]"><ShoppingBag className="h-3.5 w-3.5" /> Bulk / Block Deals</div>
              <div className="v5-compact-scroll space-y-1.5 pr-1">
                {blockDeals.map((row: any, i: number) => (
                  <div key={i} className="flex items-center justify-between gap-2 rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] px-2 py-1.5 text-xs">
                    <div className="min-w-0">
                      <div className="truncate font-semibold text-[var(--v5-ink)]">{s(row.client_name, '—')}</div>
                      <div className="text-[var(--v5-muted)]">{row.date} · {row.trade_type}</div>
                    </div>
                    <span className="shrink-0 font-semibold text-[var(--v5-ink-soft)]">
                      {row.pct_transacted != null ? `${fmtFixed(row.pct_transacted, 2)}% of float` : `₹${fmtFixed(row.value_cr, 1)}Cr`}
                    </span>
                  </div>
                ))}
                {!blockDeals.length && <p className="text-sm text-[var(--v5-muted)]">No bulk/block deals on record for {selectedSymbol}.</p>}
              </div>
            </div>
          </div>
        )}

        {tab === 'fno' && (
          <div className="space-y-3">
            {fnoEligible && <IndexFnoOverview symbol={selectedSymbol} />}
            {fnoSentiment && (
              <div className="grid grid-cols-2 gap-3 md:grid-cols-4">
                <MetricCard label="PCR" value={fnoSentiment.pcr == null ? '—' : fmtFixed(fnoSentiment.pcr, 2)} />
                <MetricCard label="Max Pain" value={fnoSentiment.maxPain == null ? '—' : String(fnoSentiment.maxPain)} />
                <MetricCard label="OI Trend" value={s(fnoSentiment.oiTrend, '—')} />
                <MetricCard label="IV Rank" value={fnoSentiment.ivRank == null ? '—' : fmtFixed(fnoSentiment.ivRank, 1)} />
              </div>
            )}
            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
              <OptionChainView defaultSymbol={selectedSymbol} />
            </div>
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

            <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
              <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">All Screener Names This Stock Is Part Of</div>
              <div className="v5-compact-scroll space-y-2 pr-1">
                {screeners.map((sc: any, i: number) => (
                  <div key={`${s(sc.source)}-${s(sc.id)}-${i}`} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-semibold text-[var(--v5-ink)]">{s(sc.name, 'Screener')}</span>
                      <span className="rounded-full bg-[var(--v5-surface-2)] px-2 py-0.5 text-[10px] font-semibold text-[var(--v5-ink-muted)]">{s(sc.source, 'source')}</span>
                    </div>
                    <div className="mt-1 flex flex-wrap items-center gap-2 text-xs text-[var(--v5-ink-muted)]">
                      <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">Sentiment: {s(sc.sentiment, 'neutral')}</span>
                      {s(sc.category).trim() ? <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">{s(sc.category)}</span> : null}
                      {s(sc.subcategory).trim() ? <span className="rounded-full border border-[var(--v5-border)] px-2 py-0.5">{s(sc.subcategory)}</span> : null}
                    </div>
                    {s(sc.description).trim() ? <p className="mt-1 text-xs text-[var(--v5-muted)]">{s(sc.description)}</p> : null}
                  </div>
                ))}
                {!screeners.length && <p className="text-sm text-[var(--v5-muted)]">No screener memberships found for this stock.</p>}
              </div>
            </div>
          </div>
        )}

        {tab === 'news' && (
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Stock News</div>
            <div className="v5-compact-scroll space-y-2 pr-1">
              {news.map((item: any, i: number) => (
                <a
                  key={`${s(item.posturl)}-${i}`}
                  href={s(item.posturl)}
                  target="_blank"
                  rel="noreferrer"
                  className="block rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2 hover:bg-[var(--v5-surface-2)]"
                >
                  <div className="text-sm font-semibold text-[var(--v5-ink)]">{s(item.heading, 'News item')}</div>
                  <div className="mt-0.5 text-xs text-[var(--v5-muted)]">{s(item.publish_date, '—')}</div>
                  {s(item.description).trim() ? <p className="mt-1 text-xs text-[var(--v5-ink-muted)]">{s(item.description)}</p> : null}
                </a>
              ))}
              {!news.length && <p className="text-sm text-[var(--v5-muted)]">No stock-specific news available right now.</p>}
            </div>
          </div>
        )}
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
    <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">{title}</div>
      {present.length ? (
        <div className="grid grid-cols-2 gap-2">
          {present.map(([label, value]) => (
            <div key={label} className="rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface)] p-2">
              <div className="text-sm font-bold text-[var(--v5-ink)]">{fmtFixed(value, 2)}{suffix ?? ''}</div>
              <div className="text-[10px] uppercase tracking-wide text-[var(--v5-muted)]">{label}</div>
            </div>
          ))}
        </div>
      ) : (
        <p className="text-sm text-[var(--v5-muted)]">No values available.</p>
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
    <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
      <div className="mb-2 text-xs font-semibold uppercase tracking-wide text-[var(--v5-muted)]">{title}</div>
      {!row ? (
        <p className="text-sm text-[var(--v5-muted)]">No estimate data.</p>
      ) : (
        <div className="space-y-1.5 text-xs">
          <div className="flex items-center justify-between"><span className="text-[var(--v5-muted)]">Period</span><span className="font-semibold text-[var(--v5-ink-soft)]">{s(row.date, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-[var(--v5-muted)]">Avg</span><span className="font-semibold text-[var(--v5-ink-soft)]">{s(row.avg, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-[var(--v5-muted)]">Low / High</span><span className="font-semibold text-[var(--v5-ink-soft)]">{s(row.low, '—')} / {s(row.high, '—')}</span></div>
          <div className="flex items-center justify-between"><span className="text-[var(--v5-muted)]">Actual</span><span className="font-semibold text-[var(--v5-ink-soft)]">{s(row.actual, '—')}</span></div>
        </div>
      )}
    </div>
  );
}
