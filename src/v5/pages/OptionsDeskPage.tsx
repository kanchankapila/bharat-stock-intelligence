import { useMemo, useState } from 'react';
import { Activity, Layers, ShieldAlert, Target } from 'lucide-react';
import { trpc } from '../../lib/trpc';
import { fmtFixed, fmtINR, n, numOrNull, s } from '../utils';
import { V5KpiStrip } from '../components/V5KpiStrip';
import { V5DecisionSummaryStrip, V5InsightPanel, V5MiniBarChart } from '../components/V5Visuals';

export function OptionsDeskPage() {
  const [symbol, setSymbol] = useState('nifty');

  const optionsQ = trpc.getOptionsIntelligence.useQuery(undefined, {
    refetchInterval: 60_000,
    refetchOnWindowFocus: true,
  });
  const maxPainQ = trpc.getMaxPainAlerts.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
  const rolloverQ = trpc.getRolloverPositioning.useQuery(undefined, {
    refetchInterval: 300_000,
    refetchOnWindowFocus: true,
  });
  const chainQ = trpc.getOptionChain.useQuery({ symbol: symbol.toLowerCase() }, {
    enabled: !!symbol,
    refetchInterval: 30_000,
    refetchOnWindowFocus: true,
  });

  const chain = (chainQ.data as any)?.data;
  const rows = chain?.optionChain ?? [];

  const topCallOI = useMemo(() => {
    const sorted = [...rows].sort((a: any, b: any) => n(b.callOi) - n(a.callOi));
    return sorted.slice(0, 5);
  }, [rows]);

  const topPutOI = useMemo(() => {
    const sorted = [...rows].sort((a: any, b: any) => n(b.putOi) - n(a.putOi));
    return sorted.slice(0, 5);
  }, [rows]);
  const callOiBars = topCallOI.map((r: any) => ({
    label: String(n(r.strikePrice)),
    value: numOrNull(r.callOi),
    colorClass: 'v5-mini-fill-rose',
  }));
  const putOiBars = topPutOI.map((r: any) => ({
    label: String(n(r.strikePrice)),
    value: numOrNull(r.putOi),
    colorClass: 'v5-mini-fill-teal',
  }));

  const maxPainAlerts = maxPainQ.data ?? [];
  const pcr = numOrNull(chain?.pcr);
  const spot = numOrNull(chain?.spotPrice);
  const atmStrike = numOrNull(chain?.marketSentiment?.atmStrike);
  const maxPain = numOrNull(chain?.marketSentiment?.maxPain);
  const kpis = [
    { label: 'Symbol', value: symbol.toUpperCase() },
    { label: 'Chain Rows', value: String(rows.length) },
    { label: 'PCR', value: pcr == null ? '—' : fmtFixed(pcr, 2), tone: pcr != null && pcr > 1 ? 'positive' : 'warning' as const },
    { label: 'Alert Count', value: String(maxPainAlerts.length) },
  ];

  const optionsInsights = [
    pcr == null
      ? 'PCR unavailable for this symbol right now.'
      : `PCR at ${fmtFixed(pcr, 2)} suggests ${pcr > 1 ? 'put-heavy' : 'call-heavy'} positioning.`,
    maxPain == null
      ? 'Max pain not available in latest chain snapshot.'
      : `Max pain level near ${fmtFixed(maxPain, 0)}; monitor spot drift versus this anchor.`,
    `Top OI ladders: ${topCallOI.length} call strikes and ${topPutOI.length} put strikes loaded.`,
  ];

  return (
    <section className="v5-grid">
      <div className="col-span-12">
        <V5KpiStrip items={kpis} />
        <V5DecisionSummaryStrip
          items={[
            pcr == null ? 'PCR snapshot is not available for the selected chain.' : `PCR is ${fmtFixed(pcr, 2)} for ${symbol.toUpperCase()}.`,
            maxPain == null
              ? 'Max pain anchor is unavailable in the current options snapshot.'
              : `Max pain is ${fmtFixed(maxPain, 0)} versus spot ${spot == null ? '—' : fmtFixed(spot, 0)}.`,
            `Top OI ladders loaded: ${topCallOI.length} call strikes and ${topPutOI.length} put strikes.`,
          ]}
        />
      </div>

      <div className="v5-card col-span-12 p-4">
        <div className="mb-3 flex flex-wrap items-center justify-between gap-3">
          <div className="flex items-center gap-2">
            <Activity className="h-4 w-4 text-teal-700" />
            <h2 className="v5-title text-lg font-semibold">Options Desk</h2>
          </div>
          <input
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="v5-input w-52"
            placeholder="nifty / reliance"
          />
        </div>

        <div className="grid grid-cols-1 gap-3 md:grid-cols-3 xl:grid-cols-5">
          <Metric title="Spot" value={spot == null ? '—' : `₹${fmtINR(spot)}`} />
          <Metric title="PCR" value={pcr == null ? '—' : fmtFixed(pcr, 2)} />
          <Metric title="ATM Strike" value={atmStrike == null ? '—' : fmtFixed(atmStrike, 0)} />
          <Metric title="Max Pain" value={maxPain == null ? '—' : fmtFixed(maxPain, 0)} />
          <Metric title="Rows" value={String(rows.length)} />
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-6">
        <div className="mb-2 flex items-center gap-2"><ShieldAlert className="h-4 w-4 text-rose-700" /><h3 className="v5-title text-base font-semibold">Top Call OI Resistance</h3></div>
        <div className="space-y-2">
          {topCallOI.map((r: any) => (
            <div key={`c-${n(r.strikePrice)}`} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="font-semibold text-slate-800">{n(r.strikePrice)}</span>
              <span className="text-slate-600">OI {compact(n(r.callOi))}</span>
              <span className="text-slate-500">Δ {compact(n(r.callOiChange))}</span>
            </div>
          ))}
          {!topCallOI.length && <p className="text-sm text-slate-500">No call OI rows yet for this symbol.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-6">
        <div className="mb-2 flex items-center gap-2"><Target className="h-4 w-4 text-emerald-700" /><h3 className="v5-title text-base font-semibold">Top Put OI Support</h3></div>
        <div className="space-y-2">
          {topPutOI.map((r: any) => (
            <div key={`p-${n(r.strikePrice)}`} className="flex items-center justify-between rounded-lg border border-slate-200 bg-slate-50 px-3 py-2">
              <span className="font-semibold text-slate-800">{n(r.strikePrice)}</span>
              <span className="text-slate-600">OI {compact(n(r.putOi))}</span>
              <span className="text-slate-500">Δ {compact(n(r.putOiChange))}</span>
            </div>
          ))}
          {!topPutOI.length && <p className="text-sm text-slate-500">No put OI rows yet for this symbol.</p>}
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-7">
        <div className="mb-2 flex items-center gap-2"><Layers className="h-4 w-4 text-indigo-700" /><h3 className="v5-title text-base font-semibold">PCR Intelligence Grid</h3></div>
        <div className="mb-3 grid grid-cols-1 gap-3 xl:grid-cols-2">
          <V5MiniBarChart title="Top Call OI Profile" items={callOiBars} />
          <V5MiniBarChart title="Top Put OI Profile" items={putOiBars} />
        </div>
        <div className="overflow-x-auto">
          <table className="min-w-full text-sm">
            <thead>
              <tr className="border-b border-slate-200 text-left text-xs uppercase tracking-wide text-slate-500">
                <th className="px-3 py-2">Symbol</th>
                <th className="px-3 py-2">Expiry</th>
                <th className="px-3 py-2">PCR</th>
                <th className="px-3 py-2">Call OI</th>
                <th className="px-3 py-2">Put OI</th>
              </tr>
            </thead>
            <tbody>
              {(optionsQ.data ?? []).slice(0, 40).map((row: any, i: number) => (
                <tr key={`${s(row.symbol)}-${i}`} className="v5-table-row-intel border-b border-slate-100">
                  <td className="px-3 py-2 font-semibold text-slate-800">{s(row.symbol)}</td>
                  <td className="px-3 py-2">{s(row.expiry, '—')}</td>
                  <td className="px-3 py-2">{fmtFixed(row.pcr, 2)}</td>
                  <td className="px-3 py-2">{compact(n(row.total_call_oi))}</td>
                  <td className="px-3 py-2">{compact(n(row.total_put_oi))}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>

      <div className="v5-card col-span-12 p-4 xl:col-span-5">
        <h3 className="v5-title mb-2 text-base font-semibold">Max Pain + Rollover Alerts</h3>
        <div className="mb-3">
          <V5InsightPanel title="Options Insights" insights={optionsInsights} />
        </div>
        <div className="v5-compact-scroll space-y-2 pr-1">
          {maxPainAlerts.slice(0, 10).map((x: any) => (
            <div key={s(x.symbol)} className="v5-table-row-intel rounded-lg border border-slate-200 p-2">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-slate-800">{s(x.symbol)}</div>
                <div className="text-xs text-slate-500">{fmtFixed(x.diffPct, 2)}%</div>
              </div>
              <div className="text-[11px] text-slate-500">{s(x.rec)}</div>
            </div>
          ))}
          {(rolloverQ.data ?? []).slice(0, 8).map((x: any) => (
            <div key={`${s(x.symbol)}-roll`} className="v5-table-row-intel rounded-lg border border-slate-200 bg-slate-50 p-2">
              <div className="flex items-center justify-between">
                <div className="font-semibold text-slate-800">{s(x.symbol)}</div>
                <div className="text-xs text-slate-500">{s(x.positioning)}</div>
              </div>
              <div className="text-[11px] text-slate-500">Rollover {fmtFixed(x.rollover_pct, 1)}% | CoC {fmtFixed(x.cost_of_carry_ann, 1)}%</div>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}

function Metric({ title, value }: { title: string; value: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-slate-50 p-3">
      <div className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">{title}</div>
      <div className="mt-1 text-lg font-bold text-slate-900">{value}</div>
    </div>
  );
}

function compact(v: number): string {
  if (!v) return '0';
  if (v >= 10000000) return `${(v / 10000000).toFixed(2)}Cr`;
  if (v >= 100000) return `${(v / 100000).toFixed(2)}L`;
  return v.toLocaleString('en-IN');
}
