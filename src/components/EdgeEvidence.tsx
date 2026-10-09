import { ResponsiveContainer, ComposedChart, Line, XAxis, YAxis, Tooltip, ReferenceLine, CartesianGrid, BarChart, Bar, Cell } from 'recharts';
import { trpc } from '../lib/trpc';
import { relativeFromNow } from '../lib/timeFormat';
import { deriveCallState, type ForwardTier, type ForwardTestReport } from '../lib/callState';

// Evidence sections for /signal-report-card (spec 2026-10-08 section 2.D). Daily data: no polling.
const DAILY = { staleTime: 30 * 60_000, refetchOnWindowFocus: false } as const;
const num = (x: number | null | undefined, d = 3) => (x == null || !Number.isFinite(x) ? 'n/a' : x.toFixed(d));
const pctTxt = (x: number | null | undefined, d = 1) => (x == null || !Number.isFinite(x) ? 'n/a' : `${(x * 100).toFixed(d)}%`);

export function ForwardTestPanel() {
  const { data, isError } = trpc.getEdgeStatus.useQuery(undefined, DAILY);
  const ft = data?.forwardTest as ForwardTestReport | null | undefined;
  const block = ft?.blocks?.forward;
  const call = deriveCallState(ft, data?.scorecard as Record<string, unknown> | null | undefined);
  return (
    <section className="v1-card p-4 space-y-3" aria-label="Forward test">
      <div>
        <h2 className="v1-title-section">Forward test (frozen protocol)</h2>
        <p className="text-[11px] text-slate-400 mt-1">
          Source: app_settings forward_test_report{ft?.protocol_hash ? ` · protocol hash ${ft.protocol_hash}` : ''}
          {block ? ` · since ${block.since} · ${block.sessions ?? 0} sessions · ${block.calls ?? 0} calls` : ''}
          {data?.forwardTestAsOf ? ` · as of ${relativeFromNow(data.forwardTestAsOf)}` : ''}.
          Entry next open, 0.25% cost per side, benchmark is the equal-weight liquid ranked universe. A tier needs
          {' '}{data?.minIndependentWindows ?? 20} independent windows (dates / horizon) before its verdict is evidence.
        </p>
        <p className="text-[11px] text-amber-300 mt-1">{call.message}</p>
      </div>
      {isError && <div className="text-rose-400 text-sm" role="alert">Could not load the forward test.</div>}
      {!isError && !block && <div className="text-slate-500 text-sm">No forward-test report has been persisted yet.</div>}
      {block && Object.entries(block.tiers ?? {}).map(([hz, rows]) => (
        <div key={hz} className="overflow-x-auto">
          <div className="text-[11px] text-slate-300 mb-1">
            Horizon {hz} sessions
            {data?.calendarBlockedUntil?.[hz] ? ` · calendar-blocked until about ${data.calendarBlockedUntil[hz]} (weekdays; holidays push it later)` : ''}
          </div>
          <table className="w-full text-[11px] tabular-nums">
            <thead className="text-slate-500">
              <tr>{['Tier (top %)', 'Dates', 'Independent windows', 'Hit rate', 'Random-pick hit', 'Lift ±95%', 'Excess after cost', 't', 'Verdict'].map(h =>
                <th key={h} scope="col" className="text-left font-normal px-1.5 py-1">{h}</th>)}</tr>
            </thead>
            <tbody>
              {(rows as ForwardTier[]).map((r: any) => (
                <tr key={String(r.tier)} className="border-t border-slate-800 text-slate-300">
                  <td className="px-1.5 py-1">{r.tier === 'published' ? 'published' : `${r.coverage_pct}%`}</td>
                  <td className="px-1.5 py-1">{r.dates}</td>
                  <td className="px-1.5 py-1">{num(r.eff_dates, 1)}</td>
                  <td className="px-1.5 py-1">{pctTxt(r.hit_rate)}</td>
                  <td className="px-1.5 py-1">{pctTxt(r.base_hit)}</td>
                  <td className="px-1.5 py-1">{r.hit_lift == null ? 'n/a' : `${pctTxt(r.hit_lift)} ± ${pctTxt(r.hit_ci95)}`}</td>
                  <td className="px-1.5 py-1">{r.mean_excess_pct == null ? 'n/a' : `${num(r.mean_excess_pct, 2)}%`}</td>
                  <td className="px-1.5 py-1">{num(r.t_eff, 2)}</td>
                  <td className={r.verdict === 'EDGE' ? 'px-1.5 py-1 text-emerald-400' : r.verdict === 'NEGATIVE' ? 'px-1.5 py-1 text-rose-400' : 'px-1.5 py-1 text-slate-400'}>{r.verdict}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ))}
    </section>
  );
}

export function ReliabilityPanel() {
  const { data, isError } = trpc.getReliabilityCurve.useQuery(undefined, DAILY);
  if (isError) return <section className="v1-card p-4 text-rose-400 text-sm" role="alert">Could not load the reliability curve.</section>;
  if (!data) return null;
  const cost = data.roundTripCostPct;
  const pts = data.bins.map((b: any) => ({ ...b, predictedPct: b.predicted * 100, realisedPct: b.realised * 100 }));
  const dec = data.deciles.map((d: any) => ({ ...d, net: d.mean_return_pct - cost }));
  return (
    <section className="v1-card p-4 space-y-4" aria-label="Reliability">
      <div>
        <h2 className="v1-title-section">Calibrated win probability: predicted vs realised hit rate</h2>
        <p className="text-[11px] text-slate-400 mt-1">
          Brier {num(data.brier)} · base rate {pctTxt(data.baseRate)} · n {data.n} decisive outcomes (WIN vs LOSS/STOP_LOSS; flat
          NEUTRAL exits left out) over {data.dates} signal dates · through {data.asOf ?? 'n/a'}. Source: {data.source}. Overlapping
          5-session windows mean the dates are not independent. Unified scores elsewhere are ranks, not probabilities.
        </p>
      </div>
      <div className="h-56">
        <ResponsiveContainer width="100%" height="100%">
          <ComposedChart data={pts} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
            <CartesianGrid stroke="#1e293b" />
            <XAxis dataKey="predictedPct" type="number" domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <YAxis domain={[0, 100]} unit="%" tick={{ fontSize: 10, fill: '#94a3b8' }} />
            <Tooltip formatter={(v: any) => `${Number(v).toFixed(1)}%`} />
            <ReferenceLine segment={[{ x: 0, y: 0 }, { x: 100, y: 100 }]} stroke="#475569" strokeDasharray="4 4" />
            {data.baseRate != null && <ReferenceLine y={data.baseRate * 100} stroke="#f59e0b" strokeDasharray="3 3" />}
            <Line dataKey="realisedPct" name="realised" stroke="#38bdf8" dot />
          </ComposedChart>
        </ResponsiveContainer>
      </div>
      <table className="w-full text-[11px] tabular-nums">
        <caption className="sr-only">Predicted vs realised hit rate by probability bin</caption>
        <thead className="text-slate-500"><tr>{['Bin', 'Predicted', 'Realised', 'n', 'Dates'].map(h => <th key={h} scope="col" className="text-left font-normal px-1.5">{h}</th>)}</tr></thead>
        <tbody>{pts.map((b: any) => (
          <tr key={b.bin} className="border-t border-slate-800 text-slate-300">
            <td className="px-1.5">{(b.lo * 100).toFixed(0)}-{(b.hi * 100).toFixed(0)}%</td>
            <td className="px-1.5">{pctTxt(b.predicted)}</td><td className="px-1.5">{pctTxt(b.realised)}</td>
            <td className="px-1.5">{b.n}</td><td className="px-1.5">{b.dates}</td>
          </tr>))}
        </tbody>
      </table>
      <div>
        <h3 className="text-[12px] text-slate-300">Realised 5-session return by calibrated-probability decile</h3>
        <p className="text-[10px] text-slate-500">Mean return per signal, gross and net of a {cost}% round trip; every resolved outcome (NEUTRAL included).</p>
        <div className="h-44">
          <ResponsiveContainer width="100%" height="100%">
            <BarChart data={dec} margin={{ top: 8, right: 12, bottom: 8, left: 0 }}>
              <CartesianGrid stroke="#1e293b" />
              <XAxis dataKey="decile" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <YAxis unit="%" tick={{ fontSize: 10, fill: '#94a3b8' }} />
              <Tooltip formatter={(v: any) => `${Number(v).toFixed(2)}%`} />
              <ReferenceLine y={0} stroke="#475569" />
              <Bar dataKey="net" name="net">{dec.map((d: any) => <Cell key={d.decile} fill={d.net >= 0 ? '#34d399' : '#f87171'} />)}</Bar>
            </BarChart>
          </ResponsiveContainer>
        </div>
        <table className="w-full text-[11px] tabular-nums">
          <thead className="text-slate-500"><tr>{['Decile', 'Gross', 'Net', 'n', 'Dates'].map(h => <th key={h} scope="col" className="text-left font-normal px-1.5">{h}</th>)}</tr></thead>
          <tbody>{dec.map((d: any) => (
            <tr key={d.decile} className="border-t border-slate-800 text-slate-300">
              <td className="px-1.5">{d.decile}</td><td className="px-1.5">{d.mean_return_pct.toFixed(2)}%</td>
              <td className="px-1.5">{d.net.toFixed(2)}%</td><td className="px-1.5">{d.n}</td><td className="px-1.5">{d.dates}</td>
            </tr>))}
          </tbody>
        </table>
      </div>
    </section>
  );
}
