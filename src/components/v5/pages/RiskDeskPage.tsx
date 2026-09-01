import { useMemo, useState } from 'react';
import { AlertTriangle, Search, ShieldCheck } from 'lucide-react';
import { trpc } from '../../../lib/trpc';
import { fmtFixed, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5DeskSkeleton, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';
import { stockDisplayName } from '../stockIdentity';

export function RiskDeskPage({ onSelectSymbol }: { onSelectSymbol?: (symbol: string) => void }) {
  const [symbol, setSymbol] = useState('RELIANCE');
  const [minScore, setMinScore] = useState(60);

  const regimeQ = trpc.getRegimeSummary.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const distributionQ = trpc.getRiskDistribution.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const riskQ = trpc.getRiskMetrics.useQuery({ symbol }, {
    enabled: !!symbol,
    refetchOnWindowFocus: true,
  });

  const topQ = trpc.getMultiFactorScores.useQuery({
    limit: 40,
    minScore,
  }, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const tiers = distributionQ.data?.tiers ?? {};

  const totalTier = useMemo(() => {
    const values = Object.values(tiers as Record<string, number>);
    return values.reduce((a, b) => a + n(b), 0);
  }, [tiers]);
  const tierBars = Object.entries(tiers as Record<string, number>).map(([key, value]) => ({
    label: key,
    value: numOrNull(value),
    colorClass: 'v5-mini-fill-amber',
  }));
  const topTier = Object.entries(tiers as Record<string, number>)
    .sort((a, b) => n(b[1]) - n(a[1]))[0];

  const regime = s((regimeQ.data?.current as any)?.regime, 'UNKNOWN');
  const regimeProb = numOrNull((regimeQ.data?.current as any)?.prob);
  const kpis = [
    { label: 'Regime', value: regime, tone: regime === 'BULL' ? 'positive' as const : regime === 'BEAR' ? 'negative' as const : 'warning' as const },
    { label: 'Regime Prob', value: regimeProb == null ? '—' : `${(regimeProb * 100).toFixed(1)}%`, pct: regimeProb == null ? undefined : regimeProb * 100 },
    { label: 'Universe', value: String(n(distributionQ.data?.total)) },
    { label: 'MF Leaders', value: String((topQ.data ?? []).length) },
  ];

  const riskInsights = [
    `Current regime: ${regime}${regimeProb == null ? '' : ` (${(regimeProb * 100).toFixed(1)}% confidence)`}.`,
    topTier ? `Largest risk bucket: ${topTier[0]} with ${n(topTier[1])} symbols.` : 'Risk tier distribution unavailable.',
    `Multi-factor leaders shown: ${(topQ.data ?? []).length} at min score ${minScore}.`,
  ];

  if (regimeQ.isLoading && distributionQ.isLoading && topQ.isLoading) return <V5DeskSkeleton />;

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            regimeProb == null
              ? `Current regime is ${regime}.`
              : `Current regime is ${regime} with ${(regimeProb * 100).toFixed(1)}% confidence.`,
            topTier ? `Largest risk bucket is ${topTier[0]} with ${n(topTier[1])} symbols.` : 'Risk bucket concentration unavailable.',
            `Multi-factor leaders loaded: ${(topQ.data ?? []).length} symbols at min score ${minScore}.`,
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="mb-3 flex items-center gap-2">
          <ShieldCheck className="h-4 w-4 text-[var(--v5-positive)]" />
          <h2 className="v5-title text-lg font-semibold">Risk Desk</h2>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Regime</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{s((regimeQ.data?.current as any)?.regime, 'UNKNOWN')}</div>
          </div>
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Regime Prob.</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{regimeProb == null ? '—' : `${(regimeProb * 100).toFixed(1)}%`}</div>
          </div>
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Universe</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{n(distributionQ.data?.total)}</div>
          </div>
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Avg Beta</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{fmtFixed(distributionQ.data?.avgBeta, 2)}</div>
          </div>
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Avg Vol</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{fmtFixed(distributionQ.data?.avgVol, 2)}%</div>
          </div>
          <div className="rounded-2xl border border-[var(--v5-border)] bg-[var(--v5-surface-2)] p-3">
            <div className="text-[11px] font-semibold uppercase tracking-wide text-[var(--v5-muted)]">Tier Entries</div>
            <div className="mt-1 text-lg font-bold text-[var(--v5-ink)]">{totalTier}</div>
          </div>
        </div>

        <div className="mt-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
          <V5MiniBarChart title="Risk Tier Distribution" items={tierBars} />
          <V5InsightPanel title="Risk Insights" insights={riskInsights} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-4">
        <div className="mb-3 flex items-center gap-2">
          <Search className="h-4 w-4 text-sky-700" />
          <h3 className="v5-title text-base font-semibold">Single Symbol Risk</h3>
        </div>

        <div className="mb-3 flex items-center gap-2">
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            className="v5-input"
            placeholder="RELIANCE"
          />
        </div>

        <div className="space-y-2 text-sm">
          <RiskItem label="Risk Tier" value={s((riskQ.data as any)?.risk_tier, '—')} />
          <RiskItem label="Beta 1Y" value={fmtFixed((riskQ.data as any)?.beta_1y, 3)} />
          <RiskItem label="Beta 6M" value={fmtFixed((riskQ.data as any)?.beta_6m, 3)} />
          <RiskItem label="Sortino" value={fmtFixed((riskQ.data as any)?.sortino_ratio, 3)} />
          <RiskItem label="VaR 95" value={`${fmtFixed((riskQ.data as any)?.var_95, 2)}%`} />
          <RiskItem label="Sharpe" value={fmtFixed((riskQ.data as any)?.sharpe_ratio, 3)} />
          <RiskItem label="Max DD" value={`${fmtFixed((riskQ.data as any)?.max_drawdown_1y, 2)}%`} />
          <RiskItem label="MF Composite" value={fmtFixed((riskQ.data as any)?.mf_composite_score, 2)} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-8">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <h3 className="v5-title text-base font-semibold">Multi-Factor Leadership</h3>
          <label className="flex items-center gap-2 text-xs text-[var(--v5-ink-muted)]">
            Min Score
            <input type="number" min={0} max={95} value={minScore} onChange={(e) => setMinScore(Math.max(0, Math.min(95, Number(e.target.value) || 0)))} className="v5-input w-20" />
          </label>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-[var(--v5-border)] text-left text-xs uppercase tracking-wide text-[var(--v5-muted)]">
                <th className="px-3 py-2">Stock</th>
                <th className="px-3 py-2">Sector</th>
                <th className="px-3 py-2">MF Composite</th>
                <th className="px-3 py-2">Risk Tier</th>
                <th className="px-3 py-2">Beta</th>
                <th className="px-3 py-2">Sharpe</th>
              </tr>
            </thead>
            <tbody>
              {(topQ.data ?? []).map((row: any) => {
                const sym = s(row.symbol);
                return (
                <tr key={sym} className="v5-table-row-intel border-b border-[var(--v5-border)]">
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
                  <td className="px-3 py-2">{s(row.sector, 'Unclassified')}</td>
                  <td className="px-3 py-2">{fmtFixed(row.mf_composite_score, 2)}</td>
                  <td className="px-3 py-2">{s(row.risk_tier, 'Unknown')}</td>
                  <td className="px-3 py-2">{fmtFixed(row.beta_1y, 2)}</td>
                  <td className="px-3 py-2">{fmtFixed(row.sharpe_ratio, 2)}</td>
                </tr>
              );})}
            </tbody>
          </table>
          {!topQ.data?.length && (
            <div className="flex items-center gap-2 py-6 text-sm text-[var(--v5-muted)]">
              <AlertTriangle className="h-4 w-4" />
              No risk records available for this filter.
            </div>
          )}
        </div>
      </div>
    </section>
  );
}

function RiskItem({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-center justify-between rounded-lg border border-[var(--v5-border)] bg-[var(--v5-surface-2)] px-2 py-1.5">
      <span className="text-xs text-[var(--v5-muted)]">{label}</span>
      <span className="font-semibold text-[var(--v5-ink)]">{value}</span>
    </div>
  );
}
