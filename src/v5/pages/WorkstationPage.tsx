import { Globe2, Search, ShieldCheck } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, fmtINR, n, numOrNull, pctClass, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

export function WorkstationPage({
  selectedSymbol,
  setSelectedSymbol,
  query,
  setQuery,
  flowMood,
}: {
  selectedSymbol: string;
  setSelectedSymbol: (symbol: string) => void;
  query: string;
  setQuery: (query: string) => void;
  flowMood: string;
}) {
  const searchQ = trpc.searchNSEStocks.useQuery(
    { query },
    { enabled: query.trim().length >= 1 },
  );

  const quoteQ = trpc.getLiveStockQuote.useQuery(
    { symbol: selectedSymbol },
    { enabled: !!selectedSymbol, refetchInterval: 45_000, refetchOnWindowFocus: true },
  );

  const detailQ = trpc.getStockScoreDetail.useQuery(
    { symbol: selectedSymbol, timeframe: 'long_term' },
    { enabled: !!selectedSymbol },
  );

  const searchRows = Array.isArray(searchQ.data) ? searchQ.data : [];
  const classification = s((detailQ.data as any)?.classification, '—');
  const quotePrice = numOrNull((quoteQ.data as any)?.price);
  const dayChangePct = numOrNull((quoteQ.data as any)?.changePercent);
  const unifiedScore = numOrNull((detailQ.data as any)?.score);
  const convictionProb = numOrNull((detailQ.data as any)?.win_probability);
  const kpis = [
    { label: 'Selected', value: selectedSymbol || '—' },
    { label: 'Search Matches', value: String(searchRows.length) },
    { label: 'Flow Mood', value: flowMood, tone: flowMood === 'Risk-On' ? 'positive' : flowMood === 'Risk-Off' ? 'negative' : 'warning' as const },
    { label: 'Classification', value: classification },
  ];

  const symbolBars = [
    { label: 'Unified', value: unifiedScore, colorClass: 'v5-mini-fill-indigo' },
    { label: 'Day Chg', value: dayChangePct, colorClass: dayChangePct != null && dayChangePct < 0 ? 'v5-mini-fill-rose' : 'v5-mini-fill-teal', suffix: '%' },
    { label: 'Win Prob', value: convictionProb == null ? null : convictionProb * 100, colorClass: 'v5-mini-fill-sky', suffix: '%' },
  ];
  const workstationInsights = [
    quotePrice == null ? 'Live quote unavailable for selected symbol.' : `Live quote at ₹${fmtINR(quotePrice)} with ${dayChangePct == null ? 'unavailable change' : `${fmtFixed(dayChangePct, 2)}% day move`}.`,
    unifiedScore == null ? 'Unified score unavailable for selected symbol/timeframe.' : `Unified score at ${fmtFixed(unifiedScore, 1)} with classification ${classification}.`,
    convictionProb == null ? 'Win probability not present in score detail response.' : `Model win probability ${fmtFixed(convictionProb * 100, 1)}%.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            quotePrice == null
              ? `${selectedSymbol}: live quote is currently unavailable.`
              : `${selectedSymbol} trades at ₹${fmtINR(quotePrice)} with ${dayChangePct == null ? 'unavailable day change' : `${fmtFixed(dayChangePct, 2)}% day move`}.`,
            unifiedScore == null
              ? 'Unified score is unavailable for the selected symbol/timeframe.'
              : `Unified score is ${fmtFixed(unifiedScore, 1)} with ${classification} classification.`,
            convictionProb == null
              ? 'Model win probability is not available in current score detail.'
              : `Model win probability is ${fmtFixed(convictionProb * 100, 1)}% with flow mood ${flowMood}.`,
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-4">
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-sky-700" />
          <h2 className="v5-title text-lg font-semibold">Symbol Finder</h2>
        </div>
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Type NSE symbol"
          className="v5-input"
        />
        <div className="v5-compact-scroll mt-3 space-y-2 pr-1">
          {searchRows.slice(0, 30).map((row: any) => {
            const sym = s(row.symbol);
            return (
              <button
                key={sym}
                onClick={() => setSelectedSymbol(sym)}
                className={`v5-table-row-intel w-full rounded-xl border px-3 py-2 text-left transition ${selectedSymbol === sym ? 'border-teal-500 bg-teal-50' : 'border-slate-200 bg-white hover:bg-slate-50'}`}
              >
                <div className="text-sm font-semibold text-slate-800">{sym}</div>
                <div className="text-xs text-slate-500">{s((row as any).companyName, s((row as any).name, 'NSE Listing'))}</div>
              </button>
            );
          })}
          {!searchRows.length && <p className="text-sm text-slate-500">Start typing to search symbols.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 lg:col-span-8">
        <div className="mb-4 flex items-center justify-between">
          <div>
            <h2 className="v5-title text-2xl font-bold">{selectedSymbol}</h2>
            <p className="text-sm text-slate-500">Execution-grade snapshot for intraday + swing context</p>
          </div>
          <div className="flex items-center gap-2">
            <span className="rounded-full bg-slate-100 px-2 py-1 text-xs font-semibold text-slate-700">Data-linked</span>
            <span className="rounded-full bg-teal-100 px-2 py-1 text-xs font-semibold text-teal-800">Live DB</span>
          </div>
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">LTP</div>
            <div className="mt-1 text-xl font-bold">{quotePrice == null ? '—' : `₹${fmtINR(quotePrice)}`}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Day Change</div>
            <div className={`mt-1 text-xl font-bold ${pctClass(dayChangePct ?? 0)}`}>
              {dayChangePct == null ? '—' : `${dayChangePct >= 0 ? '+' : ''}${fmtFixed(dayChangePct, 2)}%`}
            </div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Unified Score</div>
            <div className="mt-1 text-xl font-bold">{unifiedScore == null ? '—' : fmtFixed(unifiedScore, 1)}</div>
          </div>
          <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Classification</div>
            <div className="mt-1 text-lg font-bold text-slate-900">{s((detailQ.data as any)?.classification, '—')}</div>
          </div>
        </div>

        <div className="mt-4 grid grid-cols-1 gap-3 md:grid-cols-2">
          <div className="rounded-2xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><ShieldCheck className="h-4 w-4 text-teal-700" /> Why this setup</div>
            <p className="text-sm leading-relaxed text-slate-600">{s((detailQ.data as any)?.whyThisPick, 'Reasoning not available for this symbol/timeframe yet.')}</p>
          </div>
          <div className="rounded-2xl border border-slate-200 p-3">
            <div className="mb-2 flex items-center gap-2 text-sm font-semibold text-slate-700"><Globe2 className="h-4 w-4 text-sky-700" /> Market Context</div>
            <ul className="space-y-1 text-sm text-slate-600">
              <li>• Flow Mood: <span className="font-semibold">{flowMood}</span></li>
              <li>• Quote Refresh: <span className="font-semibold">45s</span></li>
              <li>• Signal Horizon: <span className="font-semibold">Long-term blend</span></li>
            </ul>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
          <V5MiniBarChart title="Symbol Snapshot" items={symbolBars} />
          <V5InsightPanel title="Decision Insights" insights={workstationInsights} />
        </div>
      </div>
    </section>
  );
}
