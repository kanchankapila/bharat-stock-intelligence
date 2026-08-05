import { useMemo } from 'react';
import { Compass, TrendingDown, TrendingUp } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

type RegimeRecord = {
  regime: string;
  prob: number | null;
  dt?: string;
};

type MacroTile = {
  symbol: string;
  label: string;
  group: string;
  close: number | null;
  ret1d: number | null;
  ret5d: number | null;
};

function pct(v: number | null | undefined) {
  if (v == null || !Number.isFinite(v)) return '—';
  return `${v > 0 ? '+' : ''}${fmtFixed(v, 2)}%`;
}

function regimeTone(regime: string): 'positive' | 'negative' | 'warning' {
  const r = regime.toUpperCase();
  if (r === 'BULL') return 'positive';
  if (r === 'BEAR' || r === 'CRASH') return 'negative';
  return 'warning';
}

export function MacroRegimeDeskPage() {
  const regimeQ = trpc.getRegimeSummary.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const macroQ = trpc.getMacroSnapshot.useQuery(undefined, {
    refetchInterval: 180_000,
    refetchOnWindowFocus: true,
  });

  const fiiQ = trpc.getFiiDiiFlow.useQuery({ days: 20 }, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });

  const current = (regimeQ.data?.current ?? {}) as RegimeRecord;
  const recent = (regimeQ.data?.recent ?? []) as RegimeRecord[];
  const macroTiles = (macroQ.data ?? []) as MacroTile[];

  const bySym = useMemo(() => {
    const m: Record<string, MacroTile> = {};
    macroTiles.forEach((t) => { m[t.symbol] = t; });
    return m;
  }, [macroTiles]);

  const flowRows = (fiiQ.data?.rows ?? fiiQ.data ?? []) as any[];
  const latestFlow = flowRows[0] ?? null;
  const fiiNet = numOrNull(latestFlow?.fii_net);
  const diiNet = numOrNull(latestFlow?.dii_net);
  const netFlow = (fiiNet ?? 0) + (diiNet ?? 0);

  const regime = s(current.regime, 'UNKNOWN');
  const regimeProb = numOrNull(current.prob);

  const globalBars = [
    { label: 'S&P 500', value: numOrNull(bySym.SP500?.ret1d), colorClass: 'v5-mini-fill-indigo' },
    { label: 'Nasdaq', value: numOrNull(bySym.NASDAQ?.ret1d), colorClass: 'v5-mini-fill-indigo' },
    { label: 'Nikkei', value: numOrNull(bySym.NIKKEI?.ret1d), colorClass: 'v5-mini-fill-indigo' },
    { label: 'Hang Seng', value: numOrNull(bySym.HANGSENG?.ret1d), colorClass: 'v5-mini-fill-indigo' },
    { label: 'GIFT Nifty', value: numOrNull(bySym.GIFT_NIFTY?.ret1d), colorClass: 'v5-mini-fill-teal' },
  ];

  const riskBars = [
    { label: 'India VIX', value: numOrNull(bySym.INDIAVIX?.close), colorClass: 'v5-mini-fill-amber' },
    { label: 'Crude', value: numOrNull(bySym.CRUDE?.ret1d), colorClass: 'v5-mini-fill-rose' },
    { label: 'DXY', value: numOrNull(bySym.DXY?.ret1d), colorClass: 'v5-mini-fill-rose' },
    { label: 'USDINR', value: numOrNull(bySym.USDINR?.ret1d), colorClass: 'v5-mini-fill-rose' },
  ];

  const recentDist = useMemo(() => {
    const map: Record<string, number> = {};
    recent.forEach((r) => {
      const k = s(r.regime, 'UNKNOWN');
      map[k] = (map[k] ?? 0) + 1;
    });
    return Object.entries(map).map(([label, value]) => ({ label, value, colorClass: 'v5-mini-fill-teal' }));
  }, [recent]);

  const kpis = [
    { label: 'Current Regime', value: regime, tone: regimeTone(regime) },
    { label: 'Regime Confidence', value: regimeProb == null ? '—' : `${fmtFixed(regimeProb * 100, 1)}%` },
    { label: 'FII+DII Net', value: `${netFlow >= 0 ? '+' : ''}${fmtFixed(netFlow, 0)} Cr`, tone: netFlow > 0 ? 'positive' as const : netFlow < 0 ? 'negative' as const : 'neutral' as const },
    { label: 'India VIX', value: bySym.INDIAVIX?.close == null ? '—' : fmtFixed(bySym.INDIAVIX.close, 2) },
  ];

  const summaryItems = [
    regimeProb == null
      ? `Current regime is ${regime}.`
      : `Current regime is ${regime} with ${fmtFixed(regimeProb * 100, 1)}% confidence.`,
    `Institutional net flow (FII + DII) is ${netFlow >= 0 ? 'supportive' : 'cautious'} at ${netFlow >= 0 ? '+' : ''}${fmtFixed(netFlow, 0)} Cr.`,
    `Global tape read: GIFT ${pct(bySym.GIFT_NIFTY?.ret1d)}, US index basket mixed state shown below.`,
  ];

  const insights = [
    `Recent regime samples loaded: ${recent.length}.`,
    bySym.INDIAVIX?.close == null
      ? 'VIX snapshot unavailable.'
      : `India VIX at ${fmtFixed(bySym.INDIAVIX.close, 2)}${bySym.INDIAVIX.ret1d == null ? '' : ` (${pct(bySym.INDIAVIX.ret1d)})`}.`,
    bySym.CRUDE?.ret1d == null
      ? 'Crude move unavailable.'
      : `Crude moved ${pct(bySym.CRUDE.ret1d)} on latest daily tape.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip title="Macro Regime Summary" items={summaryItems} />
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <div className="mb-3 flex items-center gap-2">
          <Compass className="h-4 w-4 text-teal-700" />
          <h2 className="v5-title text-lg font-semibold">Regime Console</h2>
        </div>

        <div className="grid grid-cols-2 gap-3 md:grid-cols-4 xl:grid-cols-2">
          <MetricCard label="Regime" value={regime} toneClass={regimeTone(regime) === 'positive' ? 'text-teal-700' : regimeTone(regime) === 'negative' ? 'text-rose-700' : 'text-amber-700'} />
          <MetricCard label="Confidence" value={regimeProb == null ? '—' : `${fmtFixed(regimeProb * 100, 1)}%`} />
          <MetricCard label="FII Net" value={fiiNet == null ? '—' : `${fiiNet >= 0 ? '+' : ''}${fmtFixed(fiiNet, 0)} Cr`} toneClass={fiiNet != null && fiiNet < 0 ? 'text-rose-700' : 'text-teal-700'} />
          <MetricCard label="DII Net" value={diiNet == null ? '—' : `${diiNet >= 0 ? '+' : ''}${fmtFixed(diiNet, 0)} Cr`} toneClass={diiNet != null && diiNet < 0 ? 'text-rose-700' : 'text-teal-700'} />
        </div>

        <div className="mt-3">
          <V5InsightPanel title="Regime Insights" insights={insights} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <h3 className="v5-title mb-3 text-base font-semibold">Cross-Market Pulse</h3>
        <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
          <V5MiniBarChart title="Global Equity 1D Moves" items={globalBars} />
          <V5MiniBarChart title="Risk Inputs" items={riskBars} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4">
        <h3 className="v5-title mb-3 text-base font-semibold">Recent Regime Distribution</h3>
        <V5MiniBarChart title="Regime Frequency (Recent Window)" items={recentDist} />

        <div className="mt-4 overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Date</th>
                <th className="px-3 py-2">Regime</th>
                <th className="px-3 py-2">Confidence</th>
                <th className="px-3 py-2">Direction</th>
              </tr>
            </thead>
            <tbody>
              {recent.slice(0, 30).map((row, i) => {
                const p = numOrNull(row.prob);
                const dir = s(row.regime).toUpperCase();
                const up = dir === 'BULL';
                const down = dir === 'BEAR' || dir === 'CRASH';
                return (
                  <tr key={`${s(row.dt)}-${i}`} className="v5-table-row-intel border-b border-slate-100">
                    <td className="px-3 py-2 text-slate-700">{s(row.dt, '—')}</td>
                    <td className="px-3 py-2 font-semibold text-slate-800">{s(row.regime, 'UNKNOWN')}</td>
                    <td className="px-3 py-2 text-slate-700">{p == null ? '—' : `${fmtFixed(p * 100, 1)}%`}</td>
                    <td className="px-3 py-2">
                      <span className={`inline-flex items-center gap-1 text-xs font-semibold ${up ? 'text-teal-700' : down ? 'text-rose-700' : 'text-amber-700'}`}>
                        {up ? <TrendingUp className="h-3.5 w-3.5" /> : down ? <TrendingDown className="h-3.5 w-3.5" /> : <span>•</span>}
                        {up ? 'Risk-On' : down ? 'Risk-Off' : 'Neutral'}
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!recent.length && <p className="py-4 text-sm text-slate-500">No recent regime rows available right now.</p>}
        </div>
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
