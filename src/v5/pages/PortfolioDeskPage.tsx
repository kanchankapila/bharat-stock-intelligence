import { useMemo, useState } from 'react';
import { BadgeIndianRupee, PieChart, ShieldCheck, Sparkles } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

function parseSymbols(input: string): string[] {
  return input
    .split(',')
    .map((x) => x.trim().toUpperCase())
    .filter((x) => x.length > 0)
    .slice(0, 25);
}

export function PortfolioDeskPage() {
  const [symbolsInput, setSymbolsInput] = useState('RELIANCE, TCS, HDFCBANK, INFY, ICICIBANK');

  const recommendationsQ = trpc.getBuyRecommendations.useQuery(
    { conviction: 'TOP', horizon: 'ALL', limit: 25 },
    { refetchInterval: 120_000, refetchOnWindowFocus: true },
  );

  const analyzeMutation = trpc.analyzePortfolio.useMutation();

  const symbols = useMemo(() => parseSymbols(symbolsInput), [symbolsInput]);
  const weights = useMemo(() => {
    if (!symbols.length) return [] as number[];
    const w = 1 / symbols.length;
    return symbols.map(() => Number(w.toFixed(6)));
  }, [symbols]);

  const runAnalysis = () => {
    if (!symbols.length) return;
    analyzeMutation.mutate({ symbols, weights });
  };

  const picks = recommendationsQ.data?.picks ?? [];
  const avgWinProb = picks.length
    ? picks.slice(0, 12).reduce((sum: number, row: any) => sum + n(row.win_probability), 0) / Math.min(picks.length, 12)
    : null;

  const kpis = [
    { label: 'Basket Symbols', value: String(symbols.length) },
    { label: 'Suggested Universe', value: String(picks.length) },
    {
      label: 'Avg Win Prob',
      value: avgWinProb == null ? '—' : `${(avgWinProb * 100).toFixed(1)}%`,
      tone: avgWinProb != null && avgWinProb >= 0.5 ? 'positive' as const : 'warning' as const,
    },
    { label: 'Analysis State', value: analyzeMutation.isPending ? 'Running' : analyzeMutation.data ? 'Ready' : 'Idle' },
  ];
  const topPickBars = picks.slice(0, 6).map((p: any) => ({
    label: s(p.symbol).slice(0, 8),
    value: numOrNull(p.unified_score),
    colorClass: 'v5-mini-fill-sky',
  }));
  const hasAnalysis = Boolean(analyzeMutation.data && !(analyzeMutation.data as any).error);
  const analysisInsights = [
    `Input basket has ${symbols.length} symbols with equal-weight template allocation.`,
    avgWinProb == null ? 'No recommendation win-probability snapshot available yet.' : `Average win probability across top picks is ${(avgWinProb * 100).toFixed(1)}%.`,
    hasAnalysis
      ? `Portfolio diagnostics ready: Sharpe ${fmtFixed((analyzeMutation.data as any).sharpe_ratio, 2)}, Beta ${fmtFixed((analyzeMutation.data as any).beta, 2)}.`
      : 'Run portfolio analysis to generate scenario metrics.',
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            `${symbols.length} symbols are currently in your sandbox basket.`,
            avgWinProb == null
              ? 'Win probability view will populate when recommendation data is available.'
              : `Top-pick average win probability is ${(avgWinProb * 100).toFixed(1)}%.`,
            hasAnalysis
              ? `Portfolio analytics ready with Sharpe ${fmtFixed((analyzeMutation.data as any).sharpe_ratio, 2)} and Beta ${fmtFixed((analyzeMutation.data as any).beta, 2)}.`
              : 'Run portfolio analysis to get risk-adjusted diagnostics before execution.',
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <div className="v5-section-head">
          <div>
            <div className="flex items-center gap-2">
              <PieChart className="h-4 w-4 text-teal-700" />
              <h2 className="v5-section-title">Portfolio Sandbox</h2>
            </div>
            <p className="v5-section-subtitle">Rapid allocation stress-test before execution decisions.</p>
          </div>
        </div>
        <p className="mb-3 text-sm text-slate-600">
          Enter your basket, run quick portfolio diagnostics, then compare with live conviction picks.
        </p>

        <div className="space-y-3">
          <div>
            <label className="mb-1 block text-xs font-semibold tracking-wide text-slate-500">SYMBOL BASKET</label>
            <textarea
              value={symbolsInput}
              onChange={(e) => setSymbolsInput(e.target.value)}
              rows={4}
              className="w-full rounded-xl border border-slate-300 bg-white px-3 py-2 text-sm outline-none ring-teal-200 focus:ring"
              placeholder="RELIANCE, TCS, INFY"
            />
          </div>

          <div className="flex flex-wrap items-center gap-2">
            <button
              onClick={runAnalysis}
              disabled={analyzeMutation.isPending || symbols.length === 0}
              className="rounded-xl border border-teal-600 bg-teal-600 px-3 py-2 text-xs font-semibold text-white hover:bg-teal-700 disabled:cursor-not-allowed disabled:opacity-60"
            >
              {analyzeMutation.isPending ? 'Running Analysis...' : 'Run Portfolio Analysis'}
            </button>
            <span className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-semibold text-slate-600">
              {symbols.length} symbols
            </span>
          </div>

          {analyzeMutation.error && (
            <div className="rounded-xl border border-rose-200 bg-rose-50 px-3 py-2 text-sm text-rose-700">
              {analyzeMutation.error.message}
            </div>
          )}

          {analyzeMutation.data && !analyzeMutation.data.error && (
            <div className="grid grid-cols-1 gap-3 md:grid-cols-2 xl:grid-cols-4">
              <MetricCard title="Sharpe" value={fmtFixed((analyzeMutation.data as any).sharpe_ratio, 2)} />
              <MetricCard title="Beta" value={fmtFixed((analyzeMutation.data as any).beta, 2)} />
              <MetricCard title="Ann. Return" value={numOrNull((analyzeMutation.data as any).annualized_return) == null ? '—' : `${(n((analyzeMutation.data as any).annualized_return) * 100).toFixed(2)}%`} />
              <MetricCard title="VaR 95" value={numOrNull((analyzeMutation.data as any).var_95) == null ? '—' : `${(n((analyzeMutation.data as any).var_95) * 100).toFixed(2)}%`} />
            </div>
          )}

          <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
            <V5MiniBarChart title="Top Pick Score Distribution" items={topPickBars} />
            <V5InsightPanel title="Portfolio Insights" insights={analysisInsights} />
          </div>
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <div className="v5-section-head">
          <div>
            <div className="flex items-center gap-2">
              <Sparkles className="h-4 w-4 text-sky-700" />
              <h2 className="v5-section-title">Suggested Allocation Universe</h2>
            </div>
            <p className="v5-section-subtitle">Top conviction candidates from the unified model stack.</p>
          </div>
        </div>

        <div className="v5-compact-scroll space-y-2 pr-1">
          {picks.map((p: any) => (
            <div key={s(p.symbol)} className="v5-table-row-intel rounded-xl border border-slate-200 p-3">
              <div className="flex items-center justify-between">
                <div>
                  <div className="text-sm font-bold text-slate-800">{s(p.symbol)}</div>
                  <div className="text-[11px] text-slate-500">{s(p.sector, 'Unclassified')}</div>
                </div>
                <span className="rounded-full bg-teal-50 px-2 py-1 text-[11px] font-semibold text-teal-700">
                  {s(p.classification, '—')}
                </span>
              </div>
              <div className="mt-2 grid grid-cols-3 gap-2 text-[11px]">
                <div>
                  <div className="text-slate-500">Score</div>
                  <div className="font-semibold text-slate-700">{fmtFixed(p.unified_score, 1)}</div>
                </div>
                <div>
                  <div className="text-slate-500">Win Prob</div>
                  <div className="font-semibold text-slate-700">{numOrNull(p.win_probability) == null ? '—' : `${(n(p.win_probability) * 100).toFixed(1)}%`}</div>
                </div>
                <div>
                  <div className="text-slate-500">Size</div>
                  <div className="font-semibold text-slate-700">{fmtFixed(p.position_size_pct, 1)}%</div>
                </div>
              </div>
            </div>
          ))}
          {!picks.length && <p className="text-sm text-slate-500">No active recommendations available.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 flex flex-wrap items-center justify-between gap-3 p-4 text-xs text-slate-600">
        <div className="inline-flex items-center gap-2"><ShieldCheck className="h-4 w-4 text-teal-700" /> Use this page for sandbox diagnostics, not final execution.</div>
        <div className="inline-flex items-center gap-2"><BadgeIndianRupee className="h-4 w-4 text-amber-700" /> Allocation view is sourced from unified recommendations.</div>
      </div>
    </section>
  );
}

function MetricCard({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="mt-1 text-xl font-bold text-slate-900">{value}</div>
    </div>
  );
}
